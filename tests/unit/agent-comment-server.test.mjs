import { describe, expect, it } from 'vitest';
import {
  extractJson,
  validateComment,
  validateReply,
  buildCommentPrompt,
  buildReplyPrompt,
  loadCommentSafetyRules,
  resolveAgentCliConfig,
} from '../../src/agent/comment-agent-server.mjs';
import { LocalAgentProvider } from '../../src/agent/local-agent-provider.mjs';

describe('agent comment server helpers', () => {
  it('extractJson parses fenced json and trims comment', () => {
    const parsed = extractJson('说明\n```json\n{"comment":" 这个说得挺真实 "}\n```');
    expect(parsed.comment).toBe('这个说得挺真实');
  });

  it('extractJson parses json surrounded by text', () => {
    const parsed = extractJson('好的 {"comment":"挺实在的分享"} 就这样');
    expect(parsed.comment).toBe('挺实在的分享');
  });

  it('validateComment rejects empty and too long comments', () => {
    expect(() => validateComment('', { maxLength: 30 })).toThrow('comment 为空');
    expect(() => validateComment('这是一条明显超过限制的评论内容', { maxLength: 5 })).toThrow('comment 超长');
  });

  it('buildCommentPrompt keeps browser-control out of agent instructions', () => {
    const prompt = buildCommentPrompt({
      taskId: 'visit_001',
      work: { workId: '987654', desc: '今天聊聊做账号过程中的几个坑' },
      requirements: { maxLength: 30 },
    });
    expect(prompt).toContain('只负责生成一条回访评论');
    expect(prompt).toContain('只能返回 JSON');
    expect(prompt).not.toContain('点击');
    expect(prompt).not.toContain('提交');
  });

  it('buildCommentPrompt includes project comment safety rules', () => {
    const rules = loadCommentSafetyRules();
    const prompt = buildCommentPrompt({ taskId: 'visit_002' });
    expect(rules).toContain('评论生成规则与安全边界');
    expect(prompt).toContain('评论生成规则与安全边界');
    expect(prompt).toContain('不出现“互关”“互赞”“回访”“已赞”“求关注”“三连”等词');
    expect(prompt).toContain('{"comment":"评论内容"}');
  });

  it('buildReplyPrompt puts reply output format in code prompt', () => {
    const prompt = buildReplyPrompt({ taskId: 'reply_001', requirements: { minLength: 15, maxLength: 30 } });
    expect(prompt).toContain('{"reply":"回复内容"}');
    expect(prompt).toContain('15-30 个中文可见字符');
    expect(prompt).toContain('Agent 代回评');
    expect(prompt).toContain('自己用真实身份自然披露');
    expect(prompt).not.toContain('小礼');
    expect(prompt).toContain('评论生成规则与安全边界');
  });

  it('validateReply rejects replies shorter than minLength or missing agent disclosure', () => {
    expect(() => validateReply('收到啦', { minLength: 15, maxLength: 30 })).toThrow('reply 过短');
    expect(() => validateReply('这个问题后面可以单独展开讲讲呀', { minLength: 15, maxLength: 30 })).toThrow('reply 缺少 Agent 身份提示');
    expect(validateReply('AI助手觉得这个问题可以后面展开讲讲', { minLength: 15, maxLength: 30 })).toBe('AI助手觉得这个问题可以后面展开讲讲');
  });

  it('resolveAgentCliConfig supports hermes and openclaw providers', () => {
    expect(resolveAgentCliConfig({ provider: 'hermes' })).toMatchObject({
      provider: 'hermes',
      bin: 'hermes',
      argsTemplate: ['chat', '-Q', '-q', '{prompt}'],
    });

    expect(resolveAgentCliConfig({ provider: 'openclaw' })).toMatchObject({
      provider: 'openclaw',
      bin: 'openclaw',
      argsTemplate: ['chat', '-Q', '-q', '{prompt}'],
    });
  });

  it('LocalAgentProvider calls in-process agent generators', async () => {
    const provider = new LocalAgentProvider({
      provider: 'hermes',
      bin: process.execPath,
      argsTemplate: ['-e', 'const prompt = process.argv[1]; console.log(prompt.includes("{\\"reply\\":\\"回复内容\\"}") ? JSON.stringify({ reply: "AI助手觉得这个问题可以后面展开讲讲" }) : JSON.stringify({ comment: "挺真实" }))', '{prompt}'],
    });

    await expect(provider.generateComment({ taskId: 'visit_1' })).resolves.toBe('挺真实');
    await expect(provider.generateReply({ taskId: 'reply_1' })).resolves.toBe('AI助手觉得这个问题可以后面展开讲讲');
  });
});
