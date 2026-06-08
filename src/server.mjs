import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// 映射前端静态页面存放的 public 目录
app.use(express.static(path.join(__dirname, '../public')));

// 1. GET /api/stats: 获取大盘统计指标
app.get('/api/stats', (req, res) => {
  try {
    const db = getDb();
    
    // 待点赞的任务数
    const pendingLikes = db.prepare(`
      SELECT COUNT(*) as count FROM return_visit_tasks 
      WHERE like_status = 'pending' AND status != 'done' AND status != 'skipped_no_work' AND status != 'skipped_private' AND status != 'skipped_no_suitable_work' AND status != 'failed'
    `).get().count;

    // 待评论审核数
    const pendingComments = db.prepare(`
      SELECT COUNT(*) as count FROM return_visit_tasks 
      WHERE comment_status = 'generated' OR (status = 'comment_generated' AND comment_status != 'posted')
    `).get().count;

    // 暂缓回复评论数
    const pendingReplies = db.prepare(`
      SELECT COUNT(*) as count FROM work_comments 
      WHERE reply_status = 'pending'
    `).get().count;

    const blockedReplies = db.prepare(`
      SELECT COUNT(*) as count FROM work_comments
      WHERE reply_status = 'blocked'
    `).get().count;

    const sentUnverifiedReplies = db.prepare(`
      SELECT COUNT(*) as count FROM work_comments
      WHERE reply_status = 'sent_unverified'
    `).get().count;

    // 已完成回访任务数
    const completedTasks = db.prepare(`
      SELECT COUNT(*) as count FROM return_visit_tasks 
      WHERE status = 'done'
    `).get().count;

    // 总任务数
    const totalTasks = db.prepare("SELECT COUNT(*) as count FROM return_visit_tasks").get().count;

    // 通知采集入库数
    const collectedTotal = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type IN ('like', 'comment')
    `).get().count;
    const collectedLikes = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'like'
    `).get().count;
    const collectedComments = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'comment'
    `).get().count;

    // 各状态任务数量分布
    const statusRows = db.prepare(`
      SELECT status, COUNT(*) as count FROM return_visit_tasks GROUP BY status
    `).all();
    const statusDistribution = {};
    for (const r of statusRows) {
      statusDistribution[r.status] = r.count;
    }

    res.json({
      ok: true,
      data: {
        pendingLikes,
        pendingComments,
        pendingReplies,
        blockedReplies,
        sentUnverifiedReplies,
        replyExceptions: blockedReplies + sentUnverifiedReplies,
        completedTasks,
        totalTasks,
        collectedTotal,
        collectedLikes,
        collectedComments,
        statusDistribution
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. GET /api/revisit-tasks: 获取待审核/待执行的任务
app.get('/api/revisit-tasks', (req, res) => {
  try {
    const db = getDb();
    const tasks = db.prepare(`
      SELECT * FROM return_visit_tasks 
      WHERE status IN ('pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'pending_execute', 'executing', 'failed_like', 'failed_comment')
      ORDER BY updated_at DESC
    `).all();

    const formatted = tasks.map(row => ({
      id: row.id,
      taskId: row.task_id,
      identityKey: row.identity_key,
      userName: row.user_name,
      userProfileUrl: row.user_profile_url,
      sourceType: row.source_type,
      status: row.status,
      targetWork: {
        workId: row.target_work_id,
        workUrl: row.target_work_url,
        workTitle: row.target_work_title,
        workText: row.target_work_text,
        contentSummary: row.target_work_summary,
        publishTime: row.target_work_publish_time,
      },
      generatedComment: row.generated_comment,
      likeStatus: row.like_status,
      commentStatus: row.comment_status,
      retryCount: row.retry_count,
      lastError: row.last_error,
      updatedAt: row.updated_at
    }));

    res.json({ ok: true, data: formatted });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. POST /api/revisit-tasks/:id/approve: 批准某条回访并更新 AI 评论内容
app.post('/api/revisit-tasks/:id/approve', (req, res) => {
  const { id } = req.params;
  const { commentText } = req.body;

  if (!commentText || !commentText.trim()) {
    return res.status(400).json({ ok: false, error: '评论内容不能为空' });
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE return_visit_tasks 
      SET generated_comment = ?, status = 'pending_execute', comment_status = 'generated', updated_at = ?, retry_count = 0, last_error = null
      WHERE id = ?
    `).run(commentText.trim(), now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该任务' });
    }

    res.json({ ok: true, message: '任务已批准通过，加入了待执行队列' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. POST /api/revisit-tasks/:id/skip: 跳过某条回访任务
app.post('/api/revisit-tasks/:id/skip', (req, res) => {
  const { id } = req.params;
  const { reason = 'user_skipped' } = req.body;

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE return_visit_tasks 
      SET status = 'skipped_no_suitable_work', last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该任务' });
    }

    res.json({ ok: true, message: '回访任务已跳过' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4b. POST /api/revisit-tasks/bulk-approve: 批量批准回访任务并更新 AI 评论
app.post('/api/revisit-tasks/bulk-approve', (req, res) => {
  const { tasks } = req.body;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ ok: false, error: '审批任务列表不能为空' });
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const bulkApprove = db.transaction((taskList) => {
      const updateStmt = db.prepare(`
        UPDATE return_visit_tasks 
        SET generated_comment = ?, status = 'pending_execute', comment_status = 'generated', updated_at = ?, retry_count = 0, last_error = null
        WHERE id = ?
      `);

      let updatedCount = 0;
      for (const task of taskList) {
        if (task.id && task.commentText && task.commentText.trim()) {
          const result = updateStmt.run(task.commentText.trim(), now, task.id);
          if (result.changes > 0) {
            updatedCount++;
          }
        }
      }
      return updatedCount;
    });

    const count = bulkApprove(tasks);
    res.json({ ok: true, message: `成功批量批准通过了 ${count} 个回访任务` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4c. POST /api/revisit-tasks/bulk-skip: 批量跳过回访任务
app.post('/api/revisit-tasks/bulk-skip', (req, res) => {
  const { ids, reason = 'user_skipped_bulk' } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: '跳过的任务 ID 列表不能为空' });
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const bulkSkip = db.transaction((idList) => {
      const updateStmt = db.prepare(`
        UPDATE return_visit_tasks 
        SET status = 'skipped_no_suitable_work', last_error = ?, updated_at = ?
        WHERE id = ?
      `);

      let updatedCount = 0;
      for (const id of idList) {
        const result = updateStmt.run(reason, now, id);
        if (result.changes > 0) {
          updatedCount++;
        }
      }
      return updatedCount;
    });

    const count = bulkSkip(ids);
    res.json({ ok: true, message: `成功批量跳过了 ${count} 个回访任务` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. GET /api/pending-comments: 获取待处理/异常回评评论列表
app.get('/api/pending-comments', (req, res) => {
  try {
    const db = getDb();
    const comments = db.prepare(`
      SELECT
        wc.*,
        COALESCE(w_by_work.work_url, w_by_modal.work_url, wc.work_url) AS joined_work_url,
        COALESCE(w_by_work.work_title, w_by_modal.work_title) AS joined_work_title,
        COALESCE(w_by_work.work_desc, w_by_modal.work_desc) AS joined_work_desc,
        COALESCE(w_by_work.author_profile_url, w_by_modal.author_profile_url) AS joined_author_profile_url
      FROM work_comments wc
      LEFT JOIN works w_by_work
        ON wc.work_id IS NOT NULL
        AND wc.work_id != ''
        AND w_by_work.work_id = wc.work_id
      LEFT JOIN works w_by_modal
        ON (wc.work_id IS NULL OR wc.work_id = '' OR w_by_work.id IS NULL)
        AND wc.modal_id IS NOT NULL
        AND wc.modal_id != ''
        AND w_by_modal.modal_id = wc.modal_id
      WHERE wc.reply_status IN ('pending', 'blocked', 'sent_unverified')
      ORDER BY CASE wc.reply_status
        WHEN 'blocked' THEN 0
        WHEN 'sent_unverified' THEN 1
        ELSE 2
      END, wc.last_seen_at DESC
    `).all();

    res.json({ ok: true, data: comments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6. POST /api/pending-comments/:id/reply: 确定对某挂起评论进行回复
app.post('/api/pending-comments/:id/reply', (req, res) => {
  const { id } = req.params;
  const { replyText } = req.body || {};

  try {
    const db = getDb();
    const now = new Date().toISOString();
    const updates = ["reply_status = 'pending'", 'reply_reason = NULL', 'last_seen_at = ?'];
    const params = [now];
    if (replyText !== undefined) {
      updates.push('reply_text = ?');
      params.push(String(replyText || '').trim() || null);
    }
    params.push(id);

    const result = db.prepare(`UPDATE work_comments SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该评论' });
    }

    res.json({ ok: true, message: '评论已标记待回复' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6b. POST /api/pending-comments/:id/update: 修改回评文本或人工调整状态
app.post('/api/pending-comments/:id/update', (req, res) => {
  const { id } = req.params;
  const { replyText, replyStatus, replyReason } = req.body || {};
  const allowedStatuses = new Set(['pending', 'blocked', 'sent_unverified', 'skipped']);

  try {
    const db = getDb();
    const now = new Date().toISOString();
    const updates = ['last_seen_at = ?'];
    const params = [now];

    if (replyText !== undefined) {
      updates.push('reply_text = ?');
      params.push(String(replyText || '').trim() || null);
    }

    if (replyStatus !== undefined) {
      const status = String(replyStatus || '').trim();
      if (!allowedStatuses.has(status)) {
        return res.status(400).json({ ok: false, error: '不支持的回评状态' });
      }
      updates.push('reply_status = ?');
      params.push(status);
      if (status === 'pending' && replyReason === undefined) {
        updates.push('reply_reason = NULL');
      }
    }

    if (replyReason !== undefined) {
      updates.push('reply_reason = ?');
      params.push(String(replyReason || '').trim() || null);
    }

    params.push(id);
    const result = db.prepare(`UPDATE work_comments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该评论' });
    }

    res.json({ ok: true, message: '回评信息已更新' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 7. POST /api/pending-comments/:id/ignore: 忽略某挂起评论
app.post('/api/pending-comments/:id/ignore', (req, res) => {
  const { id } = req.params;

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE work_comments 
      SET reply_status = 'skipped', reply_reason = 'user_ignored', last_seen_at = ?
      WHERE id = ?
    `).run(now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该评论' });
    }

    res.json({ ok: true, message: '已忽略该评论' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.error(`[server] 礼尚往来回访控制驾驶舱服务已成功启动！`);
  console.error(`[server] 请使用浏览器打开：http://localhost:${PORT}`);
});
