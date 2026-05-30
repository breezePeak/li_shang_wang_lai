import { describe, it, expect } from 'vitest';
import { loadVerifyItemsFromResult, mergeResultWithPlanItems } from '../../src/cli/verify-comment-replies.mjs';

describe('loadVerifyItemsFromResult', () => {
  it('筛选 sent_unverified', () => {
    const replyResult = {
      results: [
        { eventId: 1, status: 'sent_unverified', step: 'verify-reply' },
        { eventId: 2, status: 'succeeded', step: 'verify-reply' },
        { eventId: 3, status: 'blocked', step: 'verify-reply' },
        { eventId: 4, status: 'blocked', step: 'open-reply-box' },
        { eventId: 5, status: 'skipped', step: '' },
      ],
    };
    const items = loadVerifyItemsFromResult(replyResult);
    expect(items.length).toBe(2);
    expect(items[0].eventId).toBe(1);
    expect(items[1].eventId).toBe(3);
  });

  it('筛选 blocked + step=verify-reply', () => {
    const replyResult = {
      results: [
        { eventId: 10, status: 'blocked', step: 'verify-reply' },
        { eventId: 11, status: 'blocked', step: 'select-work' },
        { eventId: 12, status: 'blocked', step: 'open-reply-box' },
      ],
    };
    const items = loadVerifyItemsFromResult(replyResult);
    expect(items.length).toBe(1);
    expect(items[0].eventId).toBe(10);
  });

  it('不筛选 succeeded', () => {
    const replyResult = {
      results: [
        { eventId: 1, status: 'succeeded', step: 'verify-reply' },
      ],
    };
    expect(loadVerifyItemsFromResult(replyResult)).toEqual([]);
  });

  it('不筛选 skipped', () => {
    const replyResult = {
      results: [
        { eventId: 1, status: 'skipped', step: '' },
      ],
    };
    expect(loadVerifyItemsFromResult(replyResult)).toEqual([]);
  });

  it('不筛选普通 blocked（非 verify-reply 步骤）', () => {
    const replyResult = {
      results: [
        { eventId: 1, status: 'blocked', step: 'open-reply-box' },
        { eventId: 2, status: 'blocked', step: 'execute-reply' },
        { eventId: 3, status: 'blocked', step: 'select-work' },
      ],
    };
    expect(loadVerifyItemsFromResult(replyResult)).toEqual([]);
  });

  it('空 results 返回空数组', () => {
    expect(loadVerifyItemsFromResult({ results: [] })).toEqual([]);
    expect(loadVerifyItemsFromResult({})).toEqual([]);
  });
});

describe('mergeResultWithPlanItems', () => {
  const planItems = [
    {
      eventId: 1,
      actorName: '张三',
      workTitle: '我的作品A',
      workId: 'w001',
      workUrl: 'https://example.com/video/1',
      commentText: '写得不错',
      replyText: '感谢支持，一起交流。',
      eventTimeText: '05-30 12:00',
      actorProfileUrl: 'https://example.com/user/1',
    },
    {
      eventId: 3,
      actorName: '李四',
      workTitle: '我的作品B',
      workId: 'w002',
      workUrl: 'https://example.com/video/2',
      commentText: '求教程',
      replyText: '这个问题挺关键，后面我可以单独展开讲一下。',
      eventTimeText: '05-30 13:00',
      actorProfileUrl: 'https://example.com/user/2',
    },
  ];

  it('根据 eventId 从原 plan items 找回完整 item', () => {
    const verifyItems = [
      { eventId: 1, status: 'sent_unverified', actorName: '张三' },
      { eventId: 3, status: 'blocked', step: 'verify-reply', actorName: '李四' },
    ];
    const merged = mergeResultWithPlanItems(verifyItems, planItems);
    expect(merged.length).toBe(2);
    expect(merged[0]._merged).toBe(true);
    expect(merged[0].actorName).toBe('张三');
    expect(merged[0].workTitle).toBe('我的作品A');
    expect(merged[0].commentText).toBe('写得不错');
    expect(merged[0].replyText).toBe('感谢支持，一起交流。');
    expect(merged[1]._merged).toBe(true);
    expect(merged[1].actorName).toBe('李四');
    expect(merged[1].workTitle).toBe('我的作品B');
  });

  it('找不到 plan item 时标记 _merged=false', () => {
    const verifyItems = [
      { eventId: 99, status: 'sent_unverified', actorName: '未知用户' },
    ];
    const merged = mergeResultWithPlanItems(verifyItems, planItems);
    expect(merged.length).toBe(1);
    expect(merged[0]._merged).toBe(false);
    expect(merged[0]._skipReason).toBe('plan item not found by eventId');
  });

  it('空 planItems 时所有 item 标记 _merged=false', () => {
    const verifyItems = [
      { eventId: 1, status: 'sent_unverified' },
    ];
    const merged = mergeResultWithPlanItems(verifyItems, []);
    expect(merged[0]._merged).toBe(false);
  });

  it('null planItems 时所有 item 标记 _merged=false', () => {
    const verifyItems = [
      { eventId: 1, status: 'sent_unverified' },
    ];
    const merged = mergeResultWithPlanItems(verifyItems, null);
    expect(merged[0]._merged).toBe(false);
  });

  it('合并后保留 plan item 的所有字段', () => {
    const verifyItems = [
      { eventId: 1, status: 'sent_unverified' },
    ];
    const merged = mergeResultWithPlanItems(verifyItems, planItems);
    const item = merged[0];
    expect(item.eventId).toBe(1);
    expect(item.actorName).toBe('张三');
    expect(item.workTitle).toBe('我的作品A');
    expect(item.workId).toBe('w001');
    expect(item.workUrl).toBe('https://example.com/video/1');
    expect(item.commentText).toBe('写得不错');
    expect(item.replyText).toBe('感谢支持，一起交流。');
    expect(item.eventTimeText).toBe('05-30 12:00');
    expect(item.actorProfileUrl).toBe('https://example.com/user/1');
  });
});