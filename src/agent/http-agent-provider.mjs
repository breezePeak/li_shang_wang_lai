export class HttpAgentProvider {
  constructor(baseUrl = process.env.AGENT_SERVER_URL || 'http://localhost:3001') {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
  }

  async generateComment(context) {
    const res = await fetch(`${this.baseUrl}/generate-comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Agent 生成评论失败: HTTP ${res.status}`);
    }

    if (!res.ok || !data?.ok || !data?.comment) {
      throw new Error(data?.error || `Agent 生成评论失败: HTTP ${res.status}`);
    }

    return String(data.comment || '').trim();
  }

  async generateReply(context) {
    const res = await fetch(`${this.baseUrl}/generate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Agent 生成回复失败: HTTP ${res.status}`);
    }

    if (!res.ok || !data?.ok || !data?.reply) {
      throw new Error(data?.error || `Agent 生成回复失败: HTTP ${res.status}`);
    }

    return String(data.reply || '').trim();
  }

  async generateReplies(contexts) {
    const res = await fetch(`${this.baseUrl}/generate-replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: contexts }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Agent 批量生成回复失败: HTTP ${res.status}`);
    }

    if (!res.ok || !data?.ok || !Array.isArray(data?.replies)) {
      throw new Error(data?.error || `Agent 批量生成回复失败: HTTP ${res.status}`);
    }

    return data.replies.map(item => ({
      taskId: String(item?.taskId || '').trim(),
      reply: String(item?.reply || '').trim(),
    }));
  }
}
