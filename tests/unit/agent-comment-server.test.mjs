import { describe, expect, it } from 'vitest';
import {
  buildReplyBatchPrompt,
  extractJson,
  validateComment,
  validateReply,
  validateReplyBatch,
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
    expect(prompt).toContain('项目 Agent 代回评');
    expect(prompt).toContain('对外人格叫“小猿”');
    expect(prompt).toContain('不要写“AI小助手”');
    expect(prompt).toContain('评论生成规则与安全边界');
  });

  it('buildReplyBatchPrompt gives agent the full pending reply list', () => {
    const prompt = buildReplyBatchPrompt([
      {
        taskId: 'work_comment_1',
        work: { workId: 'w1', title: '作品1' },
        comment: { commentId: 1, actorName: '用户1', text: '评论1' },
        requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true },
      },
      {
        taskId: 'work_comment_2',
        work: { workId: 'w2', title: '作品2' },
        comment: { commentId: 2, actorName: '用户2', text: '评论2' },
        requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true },
      },
    ]);

    expect(prompt).toContain('批量生成对评论的回复');
    expect(prompt).toContain('{"replies":[{"taskId":"work_comment_1","reply":"回复内容"}]}');
    expect(prompt).toContain('必须在该条 reply 里自然出现“小猿”');
    expect(prompt).toContain('不要写“AI小助手”');
    expect(prompt).toContain('work_comment_1');
    expect(prompt).toContain('work_comment_2');
    expect(prompt).toContain('评论1');
    expect(prompt).toContain('评论2');
  });

  it('validateReply rejects replies shorter than minLength or missing agent disclosure', () => {
    expect(() => validateReply('收到啦', { minLength: 15, maxLength: 30 })).toThrow('reply 过短');
    expect(() => validateReply('这个问题后面可以单独展开讲讲呀', { minLength: 15, maxLength: 30 })).toThrow('reply 缺少 Agent 身份提示');
    expect(() => validateReply('AI助手觉得这个问题可以后面展开讲讲', { minLength: 15, maxLength: 30 })).toThrow('reply 缺少小猿身份特征');
    expect(() => validateReply('AI小助手来串门看看感谢你的评论', { minLength: 15, maxLength: 30 })).toThrow('reply 缺少小猿身份特征');
    expect(() => validateReply('小猿替主人看完觉得这个问题挺真实', { minLength: 15, maxLength: 30 })).toThrow('reply 使用了泛化或伪装身份提示');
    expect(validateReply('小猿看完觉得这个问题可以后面展开讲讲', { minLength: 15, maxLength: 30 })).toBe('小猿看完觉得这个问题可以后面展开讲讲');
  });

  it('validateReplyBatch requires one validated reply per taskId', () => {
    const contexts = [
      { taskId: 'work_comment_1', requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true } },
      { taskId: 'work_comment_2', requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true } },
    ];

    expect(validateReplyBatch({
      replies: [
        { taskId: 'work_comment_2', reply: '小猿看完觉得这个细节确实值得再展开' },
        { taskId: 'work_comment_1', reply: '小猿也觉得这条反馈挺真诚自然的' },
      ],
    }, contexts)).toEqual([
      { taskId: 'work_comment_1', reply: '小猿也觉得这条反馈挺真诚自然的' },
      { taskId: 'work_comment_2', reply: '小猿看完觉得这个细节确实值得再展开' },
    ]);

    expect(() => validateReplyBatch({
      replies: [{ taskId: 'work_comment_1', reply: '小猿也觉得这条反馈挺真诚自然的' }],
    }, contexts)).toThrow('数量不匹配');

    expect(() => validateReplyBatch({
      replies: [
        { taskId: 'work_comment_1', reply: '小猿也觉得这条反馈挺真诚自然的' },
        { taskId: 'work_comment_x', reply: '小猿看完觉得这个细节确实值得再展开' },
      ],
    }, contexts)).toThrow('未知 taskId');
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
      argsTemplate: ['-e', 'const prompt = process.argv[1]; console.log(prompt.includes("{\\"reply\\":\\"回复内容\\"}") ? JSON.stringify({ reply: "小猿看完觉得这个问题可以后面展开讲讲" }) : JSON.stringify({ comment: "挺真实" }))', '{prompt}'],
    });

    await expect(provider.generateComment({ taskId: 'visit_1' })).resolves.toBe('挺真实');
    await expect(provider.generateReply({ taskId: 'reply_1' })).resolves.toBe('小猿看完觉得这个问题可以后面展开讲讲');
  });

  it('LocalAgentProvider can generate replies in one batch', async () => {
    const provider = new LocalAgentProvider({
      provider: 'hermes',
      bin: process.execPath,
      argsTemplate: ['-e', 'const prompt = process.argv[1]; console.log(JSON.stringify({ replies: Array.from(prompt.matchAll(/"taskId": "([^"]+)"/g)).map(m => ({ taskId: m[1], reply: `小猿看完觉得${m[1].slice(-1)}号评论挺真诚自然` })) }))', '{prompt}'],
    });

    await expect(provider.generateReplies([
      { taskId: 'work_comment_1', requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true } },
      { taskId: 'work_comment_2', requirements: { minLength: 15, maxLength: 30, requireAgentDisclosure: true } },
    ])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: '小猿看完觉得1号评论挺真诚自然' },
      { taskId: 'work_comment_2', reply: '小猿看完觉得2号评论挺真诚自然' },
    ]);
  });
});
