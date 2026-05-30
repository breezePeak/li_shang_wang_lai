import { describe, it, expect } from 'vitest';
import {
  getWorkGroupKey,
  groupApprovedItemsByWork,
  buildItemEvidenceData,
} from '../../src/cli/execute-comment-replies.mjs';

describe('getWorkGroupKey', () => {
  it('prefers workId with prefix', () => {
    expect(getWorkGroupKey({ workId: 'w1', workUrl: 'u1', workTitle: 't1' })).toBe('workId:w1');
  });

  it('falls back to workUrl with prefix', () => {
    expect(getWorkGroupKey({ workUrl: 'u1', workTitle: 't1' })).toBe('workUrl:u1');
  });

  it('falls back to workTitle with prefix', () => {
    expect(getWorkGroupKey({ workTitle: 't1' })).toBe('workTitle:t1');
  });

  it('returns __unknown_work__ when none present', () => {
    expect(getWorkGroupKey({})).toBe('__unknown_work__');
  });

  it('returns __unknown_work__ for null values', () => {
    expect(getWorkGroupKey({ workId: null, workUrl: null, workTitle: null })).toBe('__unknown_work__');
  });

  it('returns __unknown_work__ for empty strings', () => {
    expect(getWorkGroupKey({ workId: '', workUrl: '', workTitle: '' })).toBe('__unknown_work__');
  });

  it('returns __unknown_work__ for whitespace-only strings', () => {
    expect(getWorkGroupKey({ workId: '  ', workUrl: '  ', workTitle: '  ' })).toBe('__unknown_work__');
  });

  it('trims whitespace from workId', () => {
    expect(getWorkGroupKey({ workId: '  w1  ' })).toBe('workId:w1');
  });

  it('trims whitespace from workUrl', () => {
    expect(getWorkGroupKey({ workUrl: '  u1  ' })).toBe('workUrl:u1');
  });

  it('trims whitespace from workTitle', () => {
    expect(getWorkGroupKey({ workTitle: '  t1  ' })).toBe('workTitle:t1');
  });

  it('same value in workId and workTitle produces different keys', () => {
    const keyFromId = getWorkGroupKey({ workId: 'xxx' });
    const keyFromTitle = getWorkGroupKey({ workTitle: 'xxx' });
    expect(keyFromId).not.toBe(keyFromTitle);
    expect(keyFromId).toBe('workId:xxx');
    expect(keyFromTitle).toBe('workTitle:xxx');
  });

  it('same value in workUrl and workTitle produces different keys', () => {
    const keyFromUrl = getWorkGroupKey({ workUrl: 'yyy' });
    const keyFromTitle = getWorkGroupKey({ workTitle: 'yyy' });
    expect(keyFromUrl).not.toBe(keyFromTitle);
  });

  it('handles undefined values', () => {
    expect(getWorkGroupKey({ workId: undefined, workUrl: undefined, workTitle: undefined })).toBe('__unknown_work__');
  });
});

describe('groupApprovedItemsByWork', () => {
  it('groups by workId with prefix', () => {
    const items = [
      { workId: 'w1', workTitle: 'A', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: 'A', eventId: 'e2', approved: true, replyText: 'r2' },
      { workId: 'w2', workTitle: 'B', eventId: 'e3', approved: true, replyText: 'r3' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('workId:w1');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].workTitle).toBe('A');
    expect(groups[1].key).toBe('workId:w2');
    expect(groups[1].items).toHaveLength(1);
    expect(groups[1].workTitle).toBe('B');
  });

  it('groups by workUrl when no workId', () => {
    const items = [
      { workUrl: 'url1', workTitle: 'A', eventId: 'e1', approved: true, replyText: 'r1' },
      { workUrl: 'url1', workTitle: 'A', eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('workUrl:url1');
    expect(groups[0].items).toHaveLength(2);
  });

  it('groups by workTitle when no workId/workUrl', () => {
    const items = [
      { workTitle: '标题A', eventId: 'e1', approved: true, replyText: 'r1' },
      { workTitle: '标题B', eventId: 'e2', approved: true, replyText: 'r2' },
      { workTitle: '标题A', eventId: 'e3', approved: true, replyText: 'r3' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('workTitle:标题A');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].key).toBe('workTitle:标题B');
    expect(groups[1].items).toHaveLength(1);
  });

  it('groups items without any work info into __unknown_work__', () => {
    const items = [
      { eventId: 'e1', approved: true, replyText: 'r1' },
      { eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__unknown_work__');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].workTitle).toBeNull();
  });

  it('preserves insertion order of groups', () => {
    const items = [
      { workId: 'w3', workTitle: 'C', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: 'A', eventId: 'e2', approved: true, replyText: 'r2' },
      { workId: 'w3', workTitle: 'C', eventId: 'e3', approved: true, replyText: 'r3' },
      { workId: 'w2', workTitle: 'B', eventId: 'e4', approved: true, replyText: 'r4' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups.map(g => g.key)).toEqual(['workId:w3', 'workId:w1', 'workId:w2']);
  });

  it('preserves item order within groups', () => {
    const items = [
      { workId: 'w1', workTitle: 'A', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: 'A', eventId: 'e2', approved: true, replyText: 'r2' },
      { workId: 'w1', workTitle: 'A', eventId: 'e3', approved: true, replyText: 'r3' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].items.map(i => i.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('returns empty array for empty input', () => {
    expect(groupApprovedItemsByWork([])).toHaveLength(0);
  });

  it('same string value in workId and workTitle does not collide', () => {
    const items = [
      { workId: 'xxx', workTitle: 'xxx', eventId: 'e1', approved: true, replyText: 'r1' },
      { workTitle: 'xxx', eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('workId:xxx');
    expect(groups[1].key).toBe('workTitle:xxx');
  });

  it('empty string and whitespace go to __unknown_work__', () => {
    const items = [
      { workId: '', workUrl: '  ', workTitle: '\t', eventId: 'e1', approved: true, replyText: 'r1' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__unknown_work__');
  });

  it('backfills group.workTitle from later items', () => {
    const items = [
      { workId: 'w1', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: '补上标题', eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].workTitle).toBe('补上标题');
    expect(groups[0].items).toHaveLength(2);
  });

  it('does not overwrite group.workTitle if first item already has it', () => {
    const items = [
      { workId: 'w1', workTitle: '原始标题', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: '其他标题', eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].workTitle).toBe('原始标题');
  });

  it('single item → single group', () => {
    const items = [
      { workId: 'w1', workTitle: 'Solo', eventId: 'e1', approved: true, replyText: 'r1' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });

  it('each group has key/workTitle/workId/workUrl/items', () => {
    const items = [
      { workId: 'w1', workUrl: 'u1', workTitle: 'T1', eventId: 'e1', approved: true, replyText: 'r1' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0]).toEqual({
      key: 'workId:w1',
      workTitle: 'T1',
      workId: 'w1',
      workUrl: 'u1',
      items: [items[0]],
    });
  });
});

describe('buildItemEvidenceData', () => {
  const item = {
    eventId: 'evt_001',
    actorName: '张三',
    workTitle: '我的作品标题',
    workId: 'w123',
    workUrl: 'https://example.com/work/123',
    commentText: '这是一条很长很长的评论内容超过八十个字，用来测试截断功能是否正常工作，应只保留前八十个字',
    replyText: '这是一条很长很长的回复内容超过八十个字，用来测试截断功能是否正常工作，应只保留前八十个字',
  };

  it('includes all item fields with correct preview truncation', () => {
    const result = buildItemEvidenceData(item, 'test-step', { code: 'ERR', message: '测试错误' });
    expect(result.eventId).toBe('evt_001');
    expect(result.actorName).toBe('张三');
    expect(result.workTitle).toBe('我的作品标题');
    expect(result.step).toBe('test-step');
    expect(result.code).toBe('ERR');
    expect(result.message).toBe('测试错误');
  });

  it('truncates workTitle to 60 chars', () => {
    const result = buildItemEvidenceData(item, 'step', { code: 'E', message: 'm' });
    expect(result.workTitle.length).toBeLessThanOrEqual(60);
    expect(result.workTitle).toBe(item.workTitle); // still fits
  });

  it('truncates commentText to 80 chars', () => {
    const longComment = { ...item, commentText: 'a'.repeat(200) };
    const result = buildItemEvidenceData(longComment, 'step', { code: 'E', message: 'm' });
    expect(result.commentText.length).toBe(80);
    expect(result.commentText).toBe('a'.repeat(80));
  });

  it('truncates replyText to 80 chars', () => {
    const longReply = { ...item, replyText: 'b'.repeat(200) };
    const result = buildItemEvidenceData(longReply, 'step', { code: 'E', message: 'm' });
    expect(result.replyText.length).toBe(80);
    expect(result.replyText).toBe('b'.repeat(80));
  });

  it('truncates workUrl to 120 chars', () => {
    const longUrl = { ...item, workUrl: 'https://example.com/' + 'x'.repeat(200) };
    const result = buildItemEvidenceData(longUrl, 'step', { code: 'E', message: 'm' });
    expect(result.workUrl.length).toBe(120);
  });

  it('truncates message to 200 chars', () => {
    const result = buildItemEvidenceData(item, 'step', { code: 'E', message: 'x'.repeat(500) });
    expect(result.message.length).toBe(200);
  });

  it('falls back to resultOrError.reason when message is absent', () => {
    const result = buildItemEvidenceData(item, 'step', { code: 'E2', reason: '来自reason字段' });
    expect(result.message).toBe('来自reason字段');
  });

  it('returns empty strings for missing item fields', () => {
    const sparse = { eventId: 'e1' };
    const result = buildItemEvidenceData(sparse, 's', { code: 'X', message: 'm' });
    expect(result.workTitle).toBe('');
    expect(result.commentText).toBe('');
    expect(result.replyText).toBe('');
    expect(result.workId).toBe('');
    expect(result.workUrl).toBe('');
  });

  it('includes workId and workUrl', () => {
    const result = buildItemEvidenceData(item, 'step', { code: 'E', message: 'm' });
    expect(result.workId).toBe('w123');
    expect(result.workUrl).toBe('https://example.com/work/123');
  });
});
