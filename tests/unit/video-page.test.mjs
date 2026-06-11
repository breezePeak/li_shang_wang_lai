import { describe, it, expect, vi } from 'vitest';
import { clickLike, confirmLikeSucceeded, postVideoComment, checkLikeState, navigateToVideo } from '../../src/adapters/video-page.mjs';

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
        return createMockLocator(selector, [
          '[data-e2e="video-comment"]',
          '[contenteditable="true"][data-placeholder*="评"]',
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

  it('postVideoComment prefers comment submit api success over page fallback', async () => {
    const listeners = new Map();
    const mockPage = {
      on: vi.fn((event, handler) => listeners.set(event, handler)),
      off: vi.fn((event, handler) => {
        if (listeners.get(event) === handler) listeners.delete(event);
      }),
      locator: vi.fn().mockImplementation((selector) => {
        const locator = createMockLocator(selector, [
          '[data-e2e="video-comment"]',
          '[contenteditable="true"][data-placeholder*="评"]',
          'span.Law8JZNu',
        ]);
        if (selector === 'span.Law8JZNu') {
          locator.click = vi.fn(async () => {
            const handler = listeners.get('response');
            if (handler) {
              await handler({
                url: () => 'https://www.douyin.com/aweme/v1/web/comment/publish/?aweme_id=1',
                status: () => 200,
                request: () => ({
                  method: () => 'POST',
                  postData: () => 'text=精彩视频，点赞！',
                }),
                json: async () => ({ status_code: 0, comment: { cid: 'cid-1' } }),
              });
            }
          });
        }
        return locator;
      }),
      evaluate: vi.fn().mockResolvedValue(true),
      keyboard: {
        type: vi.fn().mockResolvedValue(undefined),
        press: vi.fn().mockResolvedValue(undefined),
      },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const res = await postVideoComment(mockPage, '精彩视频，点赞！', { execute: true });
    expect(res.ok).toBe(true);
    expect(res.data.method).toBe('submit_api_success');
    expect(res.data.submitApi.commentId).toBe('cid-1');
  });

  it('navigateToVideo 接受 jingxuan modal_id 作品页', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        isVideoPage: false,
        isNotePage: false,
        isModalPage: true,
        hasVideoElement: false,
        hasContent: true,
      }),
      url: vi.fn().mockReturnValue('https://www.douyin.com/jingxuan?modal_id=7636032429409601465'),
    };

    const res = await navigateToVideo(mockPage, 'https://www.douyin.com/jingxuan?modal_id=7636032429409601465');
    expect(res.ok).toBe(true);
    expect(res.data.isModalPage).toBe(true);
  });
});
