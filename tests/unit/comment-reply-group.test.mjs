import { describe, it, expect } from 'vitest';
import { getWorkGroupKey, groupApprovedItemsByWork } from '../../src/cli/execute-comment-replies.mjs';

describe('getWorkGroupKey', () => {
  it('uses workId as highest priority', () => {
    expect(getWorkGroupKey({ workId: 'w-a', workUrl: 'https://a.com', workTitle: 'A' }))
      .toBe('workId:w-a');
  });

  it('trims workId', () => {
    expect(getWorkGroupKey({ workId: ' w-a ' })).toBe('workId:w-a');
  });

  it('uses workUrl when no workId', () => {
    expect(getWorkGroupKey({ workUrl: 'https://a.com', workTitle: 'A' }))
      .toBe('workUrl:https://a.com');
  });

  it('trims workUrl', () => {
    expect(getWorkGroupKey({ workUrl: ' https://a.com ' })).toBe('workUrl:https://a.com');
  });

  it('uses workTitle when no workId or workUrl', () => {
    expect(getWorkGroupKey({ workTitle: '作品A' })).toBe('workTitle:作品A');
  });

  it('trims workTitle', () => {
    expect(getWorkGroupKey({ workTitle: ' 作品A ' })).toBe('workTitle:作品A');
  });

  it('returns __unknown_work__ when no identifiers', () => {
    expect(getWorkGroupKey({})).toBe('__unknown_work__');
  });

  it('returns __unknown_work__ when all fields are whitespace', () => {
    expect(getWorkGroupKey({ workId: '  ', workUrl: '', workTitle: undefined }))
      .toBe('__unknown_work__');
  });

  it('handles numeric workId', () => {
    expect(getWorkGroupKey({ workId: 12345 })).toBe('workId:12345');
  });
});

describe('groupApprovedItemsByWork', () => {
  it('groups items by workId preserving group order and item order', () => {
    const items = [
      { eventId: '1', workId: 'w-a', workTitle: '作品A' },
      { eventId: '2', workId: 'w-b', workTitle: '作品B' },
      { eventId: '3', workId: 'w-a', workTitle: '作品A' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('workId:w-a');
    expect(groups[0].items.map(i => i.eventId)).toEqual(['1', '3']);
    expect(groups[0].workTitle).toBe('作品A');
    expect(groups[0].workId).toBe('w-a');
    expect(groups[1].key).toBe('workId:w-b');
    expect(groups[1].items.map(i => i.eventId)).toEqual(['2']);
    expect(groups[1].workTitle).toBe('作品B');
    expect(groups[1].workId).toBe('w-b');
  });

  it('falls back to workUrl when no workId', () => {
    const items = [
      { eventId: '4', workUrl: 'https://example.com/c', workTitle: '作品C' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].key).toBe('workUrl:https://example.com/c');
    expect(groups[0].workUrl).toBe('https://example.com/c');
    expect(groups[0].workTitle).toBe('作品C');
  });

  it('falls back to workTitle when no workId or workUrl', () => {
    const items = [
      { eventId: '5', workTitle: '作品D' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].key).toBe('workTitle:作品D');
    expect(groups[0].workTitle).toBe('作品D');
    expect(groups[0].workId).toBeNull();
    expect(groups[0].workUrl).toBeNull();
  });

  it('uses __unknown_work__ when no identifiers exist', () => {
    const items = [
      { eventId: '6' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].key).toBe('__unknown_work__');
    expect(groups[0].workTitle).toBeNull();
    expect(groups[0].workId).toBeNull();
    expect(groups[0].workUrl).toBeNull();
  });

  it('supplements workTitle from subsequent items when first item lacks it', () => {
    const items = [
      { eventId: '1', workId: 'w-a' },
      { eventId: '2', workId: 'w-a', workTitle: '作品A' },
      { eventId: '3', workId: 'w-a', workTitle: '作品A' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('workId:w-a');
    expect(groups[0].workTitle).toBe('作品A');
    expect(groups[0].items.map(i => i.eventId)).toEqual(['1', '2', '3']);
  });

  it('trims whitespace from fields', () => {
    const items = [
      { eventId: '1', workId: ' w-a ', workTitle: ' 作品A ' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups[0].key).toBe('workId:w-a');
    expect(groups[0].workTitle).toBe('作品A');
    expect(groups[0].workId).toBe('w-a');
  });

  it('handles full sample data with all key types', () => {
    const items = [
      { eventId: '1', workId: ' w-a ', workTitle: '作品A' },
      { eventId: '2', workId: 'w-b', workTitle: '作品B' },
      { eventId: '3', workId: 'w-a', workTitle: '作品A' },
      { eventId: '4', workUrl: ' https://example.com/work/c ', workTitle: '作品C' },
      { eventId: '5', workTitle: ' 作品D ' },
      { eventId: '6' },
    ];
    const groups = groupApprovedItemsByWork(items);
    expect(groups).toHaveLength(5);
    expect(groups[0].key).toBe('workId:w-a');
    expect(groups[0].items.map(i => i.eventId)).toEqual(['1', '3']);
    expect(groups[0].workTitle).toBe('作品A');
    expect(groups[0].workId).toBe('w-a');
    expect(groups[1].key).toBe('workId:w-b');
    expect(groups[1].items.map(i => i.eventId)).toEqual(['2']);
    expect(groups[1].workTitle).toBe('作品B');
    expect(groups[1].workId).toBe('w-b');
    expect(groups[2].key).toBe('workUrl:https://example.com/work/c');
    expect(groups[2].items.map(i => i.eventId)).toEqual(['4']);
    expect(groups[2].workTitle).toBe('作品C');
    expect(groups[2].workUrl).toBe('https://example.com/work/c');
    expect(groups[3].key).toBe('workTitle:作品D');
    expect(groups[3].items.map(i => i.eventId)).toEqual(['5']);
    expect(groups[3].workTitle).toBe('作品D');
    expect(groups[4].key).toBe('__unknown_work__');
    expect(groups[4].items.map(i => i.eventId)).toEqual(['6']);
    expect(groups[4].workTitle).toBeNull();
  });
});
