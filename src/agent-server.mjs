import express from 'express';
import { generateCommentWithHermes, generateRepliesWithHermes, generateReplyWithHermes, getCommentMaxLength, resolveAgentCliConfig } from './agent/comment-agent-server.mjs';

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

app.post('/generate-replies', async (req, res) => {
  const contexts = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    console.error(`[agent] batch 请求生成回复 count=${contexts.length}`);
    const replies = await generateRepliesWithHermes(contexts);
    console.error(`[agent] batch 回复生成成功 count=${replies.length}`);
    res.json({ ok: true, replies });
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[agent] batch failed reason=${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get('/health', (req, res) => {
  const config = resolveAgentCliConfig();
  res.json({ ok: true, provider: config.provider, bin: config.bin });
});

app.listen(port, () => {
  const config = resolveAgentCliConfig();
  console.error(`[agent] server listening on http://localhost:${port} provider=${config.provider} bin=${config.bin}`);
});
