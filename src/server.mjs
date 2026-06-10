import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { getDb } from './db/database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

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

    // 已有回访评论草稿但尚未落地的任务数
    const pendingComments = db.prepare(`
      SELECT COUNT(*) as count FROM return_visit_tasks 
      WHERE comment_status = 'generated' OR (status = 'comment_generated' AND comment_status != 'posted')
    `).get().count;

    // 待回评评论数
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

    const replyStatusRows = db.prepare(`
      SELECT reply_status, COUNT(*) as count FROM work_comments GROUP BY reply_status
    `).all();
    const replyStatusDistribution = {};
    for (const r of replyStatusRows) {
      replyStatusDistribution[r.reply_status] = r.count;
    }

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
      WHERE event_type IN ('like', 'comment', 'reply', 'follow')
    `).get().count;
    const collectedLikes = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'like'
    `).get().count;
    const collectedComments = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'comment'
    `).get().count;
    const collectedReplies = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'reply'
    `).get().count;
    const collectedFollows = db.prepare(`
      SELECT COUNT(*) as count FROM interaction_events
      WHERE event_type = 'follow'
    `).get().count;

    // 各状态任务数量分布
    const statusRows = db.prepare(`
      SELECT status, COUNT(*) as count FROM return_visit_tasks GROUP BY status
    `).all();
    const statusDistribution = {};
    for (const r of statusRows) {
      statusDistribution[r.status] = r.count;
    }

    const eventStatusRows = db.prepare(`
      SELECT event_type, status, COUNT(*) as count
      FROM interaction_events
      GROUP BY event_type, status
    `).all();
    const eventStatusDistribution = {};
    for (const r of eventStatusRows) {
      if (!eventStatusDistribution[r.event_type]) eventStatusDistribution[r.event_type] = {};
      eventStatusDistribution[r.event_type][r.status] = r.count;
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
        collectedReplies,
        collectedFollows,
        unhandledLikes: eventStatusDistribution.like?.new || 0,
        unhandledComments: eventStatusDistribution.comment?.new || 0,
        unhandledReplies: eventStatusDistribution.reply?.new || 0,
        unhandledFollows: eventStatusDistribution.follow?.new || 0,
        succeededReplies: replyStatusDistribution.succeeded || 0,
        skippedReplies: replyStatusDistribution.skipped || 0,
        preparedReplies: replyStatusDistribution.prepared || 0,
        skippedVisitTasks:
          (statusDistribution.skipped_no_work || 0) +
          (statusDistribution.skipped_private || 0) +
          (statusDistribution.skipped_no_suitable_work || 0),
        statusDistribution,
        eventStatusDistribution,
        replyStatusDistribution
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. GET /api/unhandled-events: 获取未处理的互动事件（visitUnhandled 节点）
app.get('/api/unhandled-events', (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const [countRow] = db.prepare(
      "SELECT COUNT(*) as total FROM interaction_events WHERE status = 'new'"
    ).all();
    const total = countRow.total;

    const events = db.prepare(`
      SELECT id, event_type, actor_name, actor_profile_url, relation,
        my_work_title, comment_text, event_time_text, status, created_at
      FROM interaction_events
      WHERE status = 'new'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ ok: true, data: events, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. GET /api/revisit-tasks: 获取可执行/可重试/异常回访任务（支持分页）
app.get('/api/revisit-tasks', (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const statusParam = req.query.status || '';
    const defaultStatuses = ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'pending_execute', 'executing', 'failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment', 'failed', 'done', 'skipped_no_work', 'skipped_private', 'skipped_no_suitable_work'];
    const allowed = statusParam ? statusParam.split(',').map(s => s.trim()).filter(Boolean) : defaultStatuses;
    const placeholders = allowed.map(() => '?').join(',');

    const countSql = `SELECT COUNT(*) as total FROM return_visit_tasks WHERE status IN (${placeholders})`;
    const [countRow] = db.prepare(countSql).all(...allowed);
    const total = countRow.total;

    const tasks = db.prepare(`
      SELECT * FROM return_visit_tasks 
      WHERE status IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...allowed, limit, offset);

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
      referenceComments: row.reference_comments_json ? safeJsonParse(row.reference_comments_json) : null,
      likeStatus: row.like_status,
      commentStatus: row.comment_status,
      retryCount: row.retry_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({ ok: true, data: formatted, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. POST /api/revisit-tasks/:id/approve: 保存某条回访评论并进入待执行
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

    res.json({ ok: true, message: '任务已保存，加入待执行队列' });
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

// 4b. POST /api/revisit-tasks/bulk-approve: 批量保存回访任务并更新 AI 评论
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
    res.json({ ok: true, message: `成功批量保存了 ${count} 个回访任务` });
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

// 5. GET /api/pending-comments: 获取待处理/异常回评评论列表（支持分页和状态筛选）
app.get('/api/pending-comments', (req, res) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const statusParam = req.query.status || '';
    const defaultStatuses = ['pending', 'blocked', 'sent_unverified', 'skipped', 'succeeded'];
    const allowed = statusParam ? statusParam.split(',').map(s => s.trim()).filter(Boolean) : defaultStatuses;
    const placeholders = allowed.map(() => '?').join(',');

    const countSql = `SELECT COUNT(*) as total FROM work_comments wc WHERE wc.reply_status IN (${placeholders})`;
    const [countRow] = db.prepare(countSql).all(...allowed);
    const total = countRow.total;

    const comments = db.prepare(`
      SELECT
        wc.*,
        COALESCE(w_by_work.work_url, w_by_modal.work_url, wc.work_url) AS joined_work_url,
        COALESCE(w_by_work.work_title, w_by_modal.work_title) AS joined_work_title,
        COALESCE(w_by_work.work_desc, w_by_modal.work_desc) AS joined_work_desc,
        COALESCE(w_by_work.author_profile_url, w_by_modal.author_profile_url) AS joined_author_profile_url,
        COALESCE(w_by_work.published_at, w_by_modal.published_at) AS joined_work_published_at
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
      WHERE wc.reply_status IN (${placeholders})
      ORDER BY wc.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...allowed, limit, offset);

    res.json({ ok: true, data: comments, page, limit, total, totalPages: Math.ceil(total / limit) });
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

// 6c. POST /api/pending-comments/:id/clear-reply: 清空单条回评文本
app.post('/api/pending-comments/:id/clear-reply', (req, res) => {
  const { id } = req.params;

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE work_comments
      SET reply_text = NULL, last_seen_at = ?
      WHERE id = ?
        AND reply_status IN ('pending', 'blocked', 'sent_unverified')
    `).run(now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该评论' });
    }

    res.json({ ok: true, message: '回评文本已清空' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6d. POST /api/pending-comments/bulk-clear-reply: 批量清空回评文本
app.post('/api/pending-comments/bulk-clear-reply', (req, res) => {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: '清空的评论 ID 列表不能为空' });
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const bulkClear = db.transaction((idList) => {
      const updateStmt = db.prepare(`
        UPDATE work_comments
        SET reply_text = NULL, last_seen_at = ?
        WHERE id = ?
          AND reply_status IN ('pending', 'blocked', 'sent_unverified')
      `);

      let updatedCount = 0;
      for (const id of idList) {
        const result = updateStmt.run(now, id);
        if (result.changes > 0) updatedCount++;
      }
      return updatedCount;
    });

    const count = bulkClear(ids);
    res.json({ ok: true, message: `成功清空 ${count} 条回评文本` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6e. POST /api/pending-comments/bulk-update-status: 批量修改回评状态
app.post('/api/pending-comments/bulk-update-status', (req, res) => {
  const { ids, replyStatus } = req.body || {};
  const allowedStatuses = new Set(['pending', 'blocked', 'sent_unverified', 'skipped']);

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: '评论 ID 列表不能为空' });
  }
  if (!allowedStatuses.has(replyStatus)) {
    return res.status(400).json({ ok: false, error: '不支持的回评状态' });
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const bulkUpdate = db.transaction((idList) => {
      const updateStmt = db.prepare(
        'UPDATE work_comments SET reply_status = ?, reply_reason = NULL, last_seen_at = ? WHERE id = ?'
      );
      let count = 0;
      for (const id of idList) {
        const result = updateStmt.run(replyStatus, now, id);
        if (result.changes > 0) count++;
      }
      return count;
    });

    const count = bulkUpdate(ids);
    res.json({ ok: true, message: `已将 ${count} 条评论状态更新为 ${replyStatus}` });
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
  const url = `http://localhost:${PORT}`;
  console.error(`[server] 礼尚往来回访控制驾驶舱服务已成功启动！`);
  console.error(`[server] 正在打开浏览器：${url}`);

  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
});
