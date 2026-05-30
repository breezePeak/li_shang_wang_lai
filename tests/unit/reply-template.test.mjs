import { describe, it, expect } from 'vitest';
import { generateReplyText, buildPlanItemFromEvent } from '../../src/domain/reply-template.mjs';

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
});

describe('buildPlanItemFromEvent', () => {
  const mockEvent = {
    id: 42,
    actor_name: '张三',
    actor_profile_url: 'https://example.com/profile/zhangsan',
    my_work_title: '我的视频作品',
    target_work_id: 'w123',
    target_work_url: 'https://example.com/work/123',
    comment_text: '写得不错',
    event_time_text: '05-30 14:00',
    raw_payload_json: '{"large": "should not appear"}',
  };

  it('sets approved to false', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.approved).toBe(false);
  });

  it('maps eventId from id', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.eventId).toBe(42);
  });

  it('preserves workTitle from my_work_title', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.workTitle).toBe('我的视频作品');
  });

  it('preserves actorName from actor_name', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.actorName).toBe('张三');
  });

  it('preserves actorProfileUrl', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.actorProfileUrl).toBe('https://example.com/profile/zhangsan');
  });

  it('preserves commentText from comment_text', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.commentText).toBe('写得不错');
  });

  it('preserves eventTimeText from event_time_text', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.eventTimeText).toBe('05-30 14:00');
  });

  it('generates replyText from template', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.replyText).toBe('感谢支持，一起交流。');
    expect(item.reason).toBe('template:praise');
  });

  it('maps workId from target_work_id', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.workId).toBe('w123');
  });

  it('maps workUrl from target_work_url', () => {
    const item = buildPlanItemFromEvent(mockEvent);
    expect(item.workUrl).toBe('https://example.com/work/123');
  });

  it('returns null for null event', () => {
    expect(buildPlanItemFromEvent(null)).toBeNull();
  });

  it('returns null for event without id', () => {
    expect(buildPlanItemFromEvent({})).toBeNull();
  });

  it('handles event with missing optional fields', () => {
    const sparse = { id: 99, comment_text: '好' };
    const item = buildPlanItemFromEvent(sparse);
    expect(item.eventId).toBe(99);
    expect(item.workTitle).toBe('');
    expect(item.workUrl).toBe('');
    expect(item.actorName).toBe('');
    expect(item.actorProfileUrl).toBe('');
    expect(item.commentText).toBe('好');
    expect(item.replyText).toBe('感谢支持。');
    expect(item.reason).toBe('template:short');
  });
});
