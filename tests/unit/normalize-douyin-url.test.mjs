import { describe, it, expect, beforeAll } from 'vitest';

describe('normalizeDouyinUrl', () => {
  let normalizeDouyinUrl = null;

  beforeAll(async () => {
    const mod = await import('../../src/adapters/notification-page.mjs');
    normalizeDouyinUrl = mod.normalizeDouyinUrl;
  });

  it('absolute https URL passes through', () => {
    expect(normalizeDouyinUrl('https://www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });

  it('absolute http URL passes through', () => {
    expect(normalizeDouyinUrl('http://www.douyin.com/user/abc')).toBe('http://www.douyin.com/user/abc');
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

  it('empty string returns empty string', () => {
    expect(normalizeDouyinUrl('')).toBe('');
  });

  it('null returns empty string', () => {
    expect(normalizeDouyinUrl(null)).toBe('');
  });

  it('undefined returns empty string', () => {
    expect(normalizeDouyinUrl(undefined)).toBe('');
  });

  it('handles query strings after path', () => {
    expect(normalizeDouyinUrl('/user/abc?enter_from=interact_cell&from_tab_name=main')).toBe(
      'https://www.douyin.com/user/abc?enter_from=interact_cell&from_tab_name=main'
    );
  });

  it('protocol-relative with query string', () => {
    expect(normalizeDouyinUrl('//www.douyin.com/user/abc?enter_from=interact_cell')).toBe(
      'https://www.douyin.com/user/abc?enter_from=interact_cell'
    );
  });
});