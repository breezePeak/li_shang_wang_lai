import { describe, it, expect } from 'vitest';
import {
  getWorkGroupKey,
  groupApprovedItemsByWork,
} from '../../src/cli/execute-comment-replies.mjs';

describe('getWorkGroupKey', () => {
  it('prefers workId', () => {
    expect(getWorkGroupKey({ workId: 'w1', workUrl: 'u1', workTitle: 't1' })).toBe('w1');
  });

  it('falls back to workUrl', () => {
    expect(getWorkGroupKey({ workUrl: 'u1', workTitle: 't1' })).toBe('u1');
  });

  it('falls back to workTitle', () => {
    expect(getWorkGroupKey({ workTitle: 't1' })).toBe('t1');
  });

  it('returns __unknown_work__ when none present', () => {
    expect(getWorkGroupKey({})).toBe('__unknown_work__');
  });

  it('returns __unknown_work__ for null values', () => {
    expect(getWorkGroupKey({ workId: null, workUrl: null, workTitle: null })).toBe('__unknown_work__');
  });
});

describe('groupApprovedItemsByWork', () => {
  it('groups by workId', () => {
    const items = [
      { workId: 'w1', workTitle: 'A', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w1', workTitle: 'A', eventId: 'e2', approved: true, replyText: 'r2' },
      { workId: 'w2', workTitle: 'B', eventId: 'e3', approved: true, replyText: 'r3' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('w1');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].workTitle).toBe('A');
    expect(groups[1].key).toBe('w2');
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
    expect(groups[0].key).toBe('url1');
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
    expect(groups[0].key).toBe('标题A');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].key).toBe('标题B');
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
    expect(groups.map(g => g.key)).toEqual(['w3', 'w1', 'w2']);
  });

  it('returns empty array for empty input', () => {
    expect(groupApprovedItemsByWork([])).toHaveLength(0);
  });

  it('each group has key/workTitle/workId/workUrl/items', () => {
    const items = [
      { workId: 'w1', workUrl: 'u1', workTitle: 'T1', eventId: 'e1', approved: true, replyText: 'r1' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0]).toEqual({
      key: 'w1',
      workTitle: 'T1',
      workId: 'w1',
      workUrl: 'u1',
      items: [items[0]],
    });
  });

  it('separates items with same workTitle but different workId', () => {
    const items = [
      { workId: 'w1', workTitle: '同名', eventId: 'e1', approved: true, replyText: 'r1' },
      { workId: 'w2', workTitle: '同名', eventId: 'e2', approved: true, replyText: 'r2' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('w1');
    expect(groups[1].key).toBe('w2');
  });

  it('single item → single group', () => {
    const items = [
      { workId: 'w1', workTitle: 'Solo', eventId: 'e1', approved: true, replyText: 'r1' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });
});
