import { describe, it, expect, vi } from 'vitest';
import { clickLike, confirmLikeSucceeded, postVideoComment, checkLikeState } from '../../src/adapters/video-page.mjs';

function createMockLocator(selector, matchedSelectors = []) {
  const isMatch = matchedSelectors.some(sel => {
    if (sel === selector) return true;
    if (selector.includes(sel) || sel.includes(selector)) return true;
    return false;
  });

  const locatorObj = {
    count: vi.fn().mockResolvedValue(isMatch ? 1 : 0),
    isVisible: vi.fn().mockResolvedValue(isMatch),
    click: vi.fn().mockResolvedValue(undefined),
    first: function() { return this; },
    nth: function() { return this; },
    evaluate: vi.fn().mockResolvedValue(true),
    filter: function() { return this; },
    locator: function() { return this; }
  };
  return locatorObj;
}

describe('video-page adapters mock testing', () => {
  it('checkLikeState returns alreadyLiked and formats data correctly', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({
        liked: true,
        confidence: 'confirmed',
        signal: 'douyin-actionbar-liked',
        diag: { tag: 'button', text: '点赞' },
        actionBarFound: true
      })
    };

    const res = await checkLikeState(mockPage);
    expect(res.ok).toBe(true);
    expect(res.data.alreadyLiked).toBe(true);
    expect(res.data.signal).toBe('douyin-actionbar-liked');
  });

  it('clickLike with execution clicks temporary tagged button', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({
        liked: false,
        confidence: 'confirmed',
        signal: 'douyin-actionbar-neutral',
        diag: { tag: 'button', text: '点赞' },
        actionBarFound: true
      }),
      locator: vi.fn().mockImplementation((selector) => {
        return createMockLocator(selector, ['[data-temp-like-btn="true"]']);
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    };

    const res = await clickLike(mockPage, { execute: true });
    expect(res.ok).toBe(true);
    expect(res.data.clicked).toBe(true);
    expect(mockPage.locator).toHaveBeenCalledWith('[data-temp-like-btn="true"]');
  });

  it('postVideoComment auto opens comment panel and types comment', async () => {
    const mockPage = {
      locator: vi.fn().mockImplementation((selector) => {
        // 匹配要打开的评论面板按钮，输入框，以及发送按钮
        return createMockLocator(selector, [
          '[data-e2e="video-comment"]',
          '[contenteditable="true"]',
          '发送',
          'submit'
        ]);
      }),
      evaluate: vi.fn().mockResolvedValue(true), // 模拟输入框清空
      keyboard: {
        type: vi.fn().mockResolvedValue(undefined),
        press: vi.fn().mockResolvedValue(undefined)
      },
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    };

    const res = await postVideoComment(mockPage, '精彩视频，点赞！', { execute: true });
    expect(res.ok).toBe(true);
    expect(res.data.text).toBe('精彩视频，点赞！');
  });
});
