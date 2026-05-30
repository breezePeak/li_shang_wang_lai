import { describe, it, expect } from 'vitest';
import { normalizeDouyinUrl } from '../../src/utils/douyin-url.mjs';

describe('normalizeDouyinUrl', () => {
  // --- basic normalization ---
  it('absolute https URL normalizes cleanly', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('http URL gets upgraded to https', () => {
    expect(normalizeDouyinUrl('http://www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('protocol-relative URL gets https prefix', () => {
    expect(normalizeDouyinUrl('//www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('root-relative path gets domain prefix', () => {
    expect(normalizeDouyinUrl('/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('bare domain path gets https protocol', () => {
    expect(normalizeDouyinUrl('www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  // --- double-domain patterns ---
  it('double-domain URL with //www.douyin.com nested inside', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com//www.douyin.com/user/MS4wLjABAAAAZhnT'))
      .toBe('https://www.douyin.com/user/MS4wLjABAAAAZhnT');
  });

  it('double-domain URL with protocol nested inside', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/https://www.douyin.com/user/abc'))
      .toBe('https://www.douyin.com/user/abc');
  });

  it('double-domain URL strips query params', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com//www.douyin.com/user/abc?enter_from=interact_cell'))
      .toBe('https://www.douyin.com/user/abc');
  });

  // --- video URLs ---
  it('/video URL gets domain prefix', () => {
    expect(normalizeDouyinUrl('/video/12345')).toBe('https://www.douyin.com/video/12345');
  });

  it('//www.douyin.com/video URL normalized', () => {
    expect(normalizeDouyinUrl('//www.douyin.com/video/12345')).toBe('https://www.douyin.com/video/12345');
  });

  it('double-domain video URL normalized', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com//www.douyin.com/video/12345'))
      .toBe('https://www.douyin.com/video/12345');
  });

  // --- query param stripping ---
  it('strips query params from actor URL', () => {
    expect(normalizeDouyinUrl('/user/abc?enter_from=interact_cell&from_tab_name=main'))
      .toBe('https://www.douyin.com/user/abc');
  });

  it('strips query params from absolute URL', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/user/abc?enter_from=interact_cell'))
      .toBe('https://www.douyin.com/user/abc');
  });

  it('strips query params from protocol-relative URL', () => {
    expect(normalizeDouyinUrl('//www.douyin.com/user/abc?enter_from=interact_cell'))
      .toBe('https://www.douyin.com/user/abc');
  });

  it('strips hash fragment', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/user/abc#comment-1'))
      .toBe('https://www.douyin.com/user/abc');
  });

  it('strips both query and hash', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/user/abc?tab=main#section'))
      .toBe('https://www.douyin.com/user/abc');
  });

  // --- edge cases ---
  it('empty string returns empty string', () => {
    expect(normalizeDouyinUrl('')).toBe('');
  });

  it('null returns empty string', () => {
    expect(normalizeDouyinUrl(null)).toBe('');
  });

  it('undefined returns empty string', () => {
    expect(normalizeDouyinUrl(undefined)).toBe('');
  });

  it('whitespace-only returns empty string', () => {
    expect(normalizeDouyinUrl('   ')).toBe('');
  });

  // --- notification-page re-exports same function ---
  it('bare douyin.com URL (no www) normalized', () => {
    expect(normalizeDouyinUrl('https://douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('notification-page re-exports the same normalizeDouyinUrl', async () => {
    const { normalizeDouyinUrl: fromNotif } = await import('../../src/adapters/notification-page.mjs');
    expect(fromNotif('https://www.douyin.com//www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });
});
