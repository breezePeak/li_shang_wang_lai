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

    // 已完成回访任务数
    const completedTasks = db.prepare(`
      SELECT COUNT(*) as count FROM return_visit_tasks 
      WHERE status = 'done'
    `).get().count;

    // 总任务数
    const totalTasks = db.prepare("SELECT COUNT(*) as count FROM return_visit_tasks").get().count;

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
        completedTasks,
        totalTasks,
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

// 5. GET /api/pending-comments: 获取暂缓回复的评论列表
app.get('/api/pending-comments', (req, res) => {
  try {
    const db = getDb();
    const comments = db.prepare(`
      SELECT * FROM work_comments 
      WHERE reply_status = 'pending'
      ORDER BY last_seen_at DESC
    `).all();

    res.json({ ok: true, data: comments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6. POST /api/pending-comments/:id/reply: 确定对某挂起评论进行回复
app.post('/api/pending-comments/:id/reply', (req, res) => {
  const { id } = req.params;

  try {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE work_comments 
      SET reply_status = 'prepared', last_seen_at = ?
      WHERE id = ?
    `).run(now, id);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: '未找到该评论' });
    }

    res.json({ ok: true, message: '评论已移出暂存，成功加入待回复队列' });
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
      SET reply_status = 'skipped', last_seen_at = ?
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
