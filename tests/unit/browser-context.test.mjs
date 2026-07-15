import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { resolve } from 'path';
import { replaceContextPage } from '../../src/browser/browser-context.mjs';
import { checkLoginStatus } from '../../src/browser/login-guard.mjs';
import { inspectDouyinAuthState } from '../../src/browser/douyin-auth-state.mjs';

describe('browser context page replacement', () => {
  it('creates a fresh page and closes the previous one', async () => {
    const previousPage = {
      isClosed: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const nextPage = { marker: 'next-page' };
    const context = {
      newPage: vi.fn().mockResolvedValue(nextPage),
    };

    const result = await replaceContextPage(context, previousPage);

    expect(result).toBe(nextPage);
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(previousPage.close).toHaveBeenCalledTimes(1);
  });

  it('does not try to close an already-closed page', async () => {
    const previousPage = {
      isClosed: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const nextPage = { marker: 'next-page' };
    const context = {
      newPage: vi.fn().mockResolvedValue(nextPage),
    };

    const result = await replaceContextPage(context, previousPage);

    expect(result).toBe(nextPage);
    expect(previousPage.close).not.toHaveBeenCalled();
  });
});

function fakePage({ url = 'https://creator.douyin.com/', text = '' } = {}) {
  return {
    url: vi.fn().mockReturnValue(url),
    evaluate: vi.fn().mockResolvedValue(text),
  };
}

function fakeContext({ hasCookie = true } = {}) {
  return {
    cookies: vi.fn().mockResolvedValue(hasCookie ? [{ name: 'sessionid', value: 'ok' }] : []),
  };
}

describe('douyin auth state detection', () => {
  it('does not scan ordinary page comments for verification wording', () => {
    const source = fs.readFileSync(resolve(import.meta.dirname, '../../src/browser/douyin-auth-state.mjs'), 'utf8');

    expect(source).not.toContain("        'body',");
  });

  it('treats phone verification dialog as not logged in even with cookies', async () => {
    const page = fakePage({ text: '为了账号安全，请完成手机号认证 获取验证码' });
    const context = fakeContext({ hasCookie: true });

    const result = await inspectDouyinAuthState(page, context);

    expect(result.loggedIn).toBe(false);
    expect(result.reason).toBe('security_verification_required');
  });

  it('requires login cookies when no verification blocker is present', async () => {
    const page = fakePage({ text: '创作者服务中心' });
    const context = fakeContext({ hasCookie: false });

    const result = await inspectDouyinAuthState(page, context);

    expect(result.loggedIn).toBe(false);
    expect(result.reason).toBe('missing_login_cookie');
  });

  it('keeps normal logged-in pages logged in', async () => {
    const page = fakePage({ text: '创作者服务中心' });
    const context = fakeContext({ hasCookie: true });

    const result = await inspectDouyinAuthState(page, context);

    expect(result.loggedIn).toBe(true);
  });

  it('login guard detects security verification overlays without relying on URL', async () => {
    const page = fakePage({ url: 'https://creator.douyin.com/', text: '账号安全验证 请输入短信验证码' });

    const result = await checkLoginStatus(page);

    expect(result.loggedIn).toBe(false);
    expect(result.reason).toBe('security_verification_required');
  });
});
