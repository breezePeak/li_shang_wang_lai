import express from 'express';
import { generateCommentWithHermes, generateReplyWithHermes, getCommentMaxLength } from './agent/comment-agent-server.mjs';

const app = express();
const port = Number(process.env.AGENT_SERVER_PORT || 3001);

app.use(express.json({ limit: '128kb' }));

app.post('/generate-comment', async (req, res) => {
  const context = req.body || {};
  const taskId = context.taskId || 'unknown';
  try {
    const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
    console.error(`[agent] task=${taskId} 请求生成评论`);
    const comment = await generateCommentWithHermes({
      ...context,
      requirements: {
        ...(context.requirements || {}),
        maxLength,
      },
    });
    console.error(`[agent] task=${taskId} 评论生成成功 comment=${comment}`);
    res.json({ ok: true, comment });
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[agent] task=${taskId} failed reason=${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/generate-reply', async (req, res) => {
  const context = req.body || {};
  const taskId = context.taskId || context?.comment?.commentId || 'unknown';
  try {
    const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
    console.error(`[agent] task=${taskId} 请求生成回复`);
    const reply = await generateReplyWithHermes({
      ...context,
      requirements: {
        ...(context.requirements || {}),
        maxLength,
      },
    });
    console.error(`[agent] task=${taskId} 回复生成成功 reply=${reply}`);
    res.json({ ok: true, reply });
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[agent] task=${taskId} failed reason=${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.error(`[agent] server listening on http://localhost:${port}`);
});
