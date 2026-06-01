import { describe, it, expect } from 'vitest';
import { generateReplyText } from '../../src/domain/reply-template.mjs';

describe('generateReplyText', () => {
  it('returns template:question for 怎么', () => {
    const result = generateReplyText('这个功能怎么用？');
    expect(result.reason).toBe('template:question');
    expect(result.replyText).toBeTruthy();
  });

  it('returns template:question for 如何', () => {
    const result = generateReplyText('如何才能做好');
    expect(result.reason).toBe('template:question');
  });

  it('returns template:question for 为什么', () => {
    const result = generateReplyText('为什么会这样');
    expect(result.reason).toBe('template:question');
  });

  it('returns template:question for ？', () => {
    const result = generateReplyText('真的假的？');
    expect(result.reason).toBe('template:question');
  });

  it('returns template:question for ?', () => {
    const result = generateReplyText('真的假的?');
    expect(result.reason).toBe('template:question');
  });

  it('returns template:praise for 支持', () => {
    const result = generateReplyText('支持支持');
    expect(result.reason).toBe('template:praise');
    expect(result.replyText).toBe('感谢支持，一起交流。');
  });

  it('returns template:praise for 不错', () => {
    const result = generateReplyText('写得不错');
    expect(result.reason).toBe('template:praise');
  });

  it('returns template:praise for 厉害', () => {
    const result = generateReplyText('厉害');
    expect(result.reason).toBe('template:praise');
  });

  it('returns template:praise for 学到了', () => {
    const result = generateReplyText('学到了很多');
    expect(result.reason).toBe('template:praise');
  });

  it('returns template:praise for 有用', () => {
    const result = generateReplyText('很有用');
    expect(result.reason).toBe('template:praise');
  });

  it('returns template:praise for 赞', () => {
    const result = generateReplyText('赞一个');
    expect(result.reason).toBe('template:praise');
  });

  it('returns template:short for very short text (<=3 chars)', () => {
    const result = generateReplyText('好');
    expect(result.reason).toBe('template:short');
    expect(result.replyText).toBe('感谢支持。');
  });

  it('returns template:short for 2-char text', () => {
    const result = generateReplyText('加油');
    expect(result.reason).toBe('template:short');
  });

  it('returns template:short for mostly emoji text', () => {
    const result = generateReplyText('👍👍👍');
    expect(result.reason).toBe('template:short');
  });

  it('returns template:praise for text containing 不错', () => {
    const result = generateReplyText('今天天气不错');
    expect(result.reason).toBe('template:praise');
    expect(result.replyText).toBe('感谢支持，一起交流。');
  });

  it('returns template:default for neutral text without keywords', () => {
    const result = generateReplyText('今天天气很好');
    expect(result.reason).toBe('template:default');
    expect(result.replyText).toBe('感谢评论，一起交流。');
  });

  it('returns template:default for null input', () => {
    const result = generateReplyText(null);
    expect(result.reason).toBe('template:default');
    expect(result.replyText).toBe('感谢支持。');
  });

  it('returns template:default for undefined input', () => {
    const result = generateReplyText(undefined);
    expect(result.reason).toBe('template:default');
  });

  it('returns template:default for empty string', () => {
    const result = generateReplyText('');
    expect(result.reason).toBe('template:default');
  });

  it('prioritizes question over praise when both match', () => {
    const result = generateReplyText('怎么才能像你一样厉害');
    expect(result.reason).toBe('template:question');
  });

  it('uses work context when preparing replies from stored comments', () => {
    const result = generateReplyText('这个怎么做到的？', {
      workTitle: '为了龙虾口粮，魔改网上脚本居然成功了',
      referenceComments: ['省流量 cliproxy+gpt codex 注册机', '已领'],
    });
    expect(result.reason).toBe('template:question_context:script_hack');
    expect(result.replyText).toContain('脚本折腾过程');
  });

  it('uses reference comments to infer the reply topic', () => {
    const result = generateReplyText('厉害', {
      referenceComments: ['这个 openclaw 和 codex 的流程很有用'],
    });
    expect(result.reason).toBe('template:praise_context:ai_tooling');
    expect(result.replyText).toContain('AI工具实践');
  });

  it('uses work body text, not only work title', () => {
    const result = generateReplyText('这个有意思', {
      workTitle: '',
      workText: '视频里完整演示了用 codex agent 自动读取评论并生成回复的过程',
      referenceComments: [],
    });
    expect(result.reason).toBe('template:default_context:ai_tooling');
    expect(result.replyText).toContain('AI工具实践');
  });
});
