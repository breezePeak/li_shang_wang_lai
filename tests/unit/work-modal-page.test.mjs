import { describe, it, expect } from 'vitest';
import { extractModalIdFromUrl, parseDouyinTimeText } from '../../src/adapters/work-modal-page.mjs';
import { checkWorkOwner } from '../../src/adapters/work-context-page.mjs';

describe('extractModalIdFromUrl', () => {
  it('从 URL 提取 modal_id', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=7643770606596888954')).toBe('7643770606596888954');
  });

  it('modal_id 在中间', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=123&foo=bar')).toBe('123');
  });

  it('无 modal_id 返回 null', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self')).toBeNull();
  });

  it('空 URL 返回 null', () => {
    expect(extractModalIdFromUrl('')).toBeNull();
    expect(extractModalIdFromUrl(null)).toBeNull();
  });

  it('modal_id 作为 workId', () => {
    const modalId = extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=7643770606596888954');
    expect(modalId).toBe('7643770606596888954');
    const workId = modalId;
    expect(workId).toBe('7643770606596888954');
  });
});

describe('replyText 前缀匹配逻辑', () => {
  it('完整匹配', () => {
    const replyText = '感谢支持，一起交流。';
    const pageText = '感谢支持，一起交流。';
    expect(pageText.includes(replyText)).toBe(true);
  });

  it('前20字符前缀匹配', () => {
    const replyText = '这个问题挺关键，后面我可以单独展开讲一下。';
    const prefix = replyText.slice(0, 20);
    const pageText = '这个问题挺关键，后面我可以单独展开讲一下。';
    expect(prefix.length).toBe(20);
    expect(pageText.includes(prefix)).toBe(true);
  });

  it('前缀至少5字符才匹配', () => {
    const replyText = '感谢';
    const prefix = replyText.slice(0, 20);
    expect(prefix.length).toBeLessThan(5);
    const shouldUsePrefix = prefix.length >= 5;
    expect(shouldUsePrefix).toBe(false);
  });
});

describe('parseDouyinTimeText', () => {
  it('支持 昨天00:11', () => {
    const iso = parseDouyinTimeText('昨天00:11');
    expect(iso).toBeTruthy();
    const date = new Date(iso);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(11);
  });

  it('支持 1小时前', () => {
    const iso = parseDouyinTimeText('1小时前');
    expect(iso).toBeTruthy();
  });

  it('支持 刚刚', () => {
    const iso = parseDouyinTimeText('刚刚');
    expect(iso).toBeTruthy();
  });
});

describe('ownerCheck 分支', () => {
  it('high: profileKey 匹配', () => {
    const self = { profileKey: 'MY_KEY', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'MY_KEY', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('high: profileUrl 匹配', () => {
    const self = { profileKey: '', profileUrl: 'https://www.douyin.com/user/MY_KEY', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '//www.douyin.com/user/MY_KEY', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('medium: authorName 匹配', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '我的昵称' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '我的昵称' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('medium');
  });

  it('null: 无 self 配置', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'some', authorProfileUrl: 'some', authorName: 'some' }, self);
    expect(result.isOwnWork).toBeNull();
    expect(result.ownerCheckConfidence).toBe('low');
  });

  it('false: profileKey 不匹配', () => {
    const self = { profileKey: 'MY_KEY', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'OTHER_KEY', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(false);
    expect(result.ownerCheckConfidence).toBe('high');
  });
});
