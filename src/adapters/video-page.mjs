import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

export async function navigateToVideo(page, videoUrl, options = {}) {
  const { timeoutMs = 15000 } = options;

  try {
    console.log(`[video-page] 打开视频: ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(3000);

    const pageState = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const url = window.location.href;
      return {
        isVideoPage: url.includes('/video/'),
        hasContent: text.length > 100,
      };
    });

    if (!pageState.isVideoPage) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '未能导航到视频页面',
        { data: { url: page.url() } }
      );
    }

    return success({ url: page.url(), isVideoPage: true });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `导航到视频页异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function checkLikeState(page) {
  try {
    const state = await page.evaluate(() => {
      // Find like/heart elements
      const all = document.querySelectorAll('span, div, [role="button"], button');

      for (const el of all) {
        const text = (el.innerText || '').trim();

        // Look for like-related UI patterns
        if (text.startsWith('点赞') || text.startsWith('赞')) {
          const rect = el.getBoundingClientRect();
          // Check if the like icon/parent is in "liked" state (red color, filled, active class)
          let liked = false;

          const parent = el.parentElement;
          if (parent) {
            const parentCls = parent.className || '';
            const parentStyle = window.getComputedStyle(parent);
            // Check if parent or its child has red/pink color (liked state)
            if (parentStyle.color && (parentStyle.color.includes('rgb(255') || parentStyle.color.includes('rgb(254'))) {
              liked = true;
            }
            if (/active|liked|selected|checked/i.test(parentCls)) {
              liked = true;
            }
          }

          // Also check SVG fill for red color
          const svgs = (parent || el).querySelectorAll('svg');
          for (const svg of svgs) {
            const fill = svg.getAttribute('fill') || '';
            if (fill === '#FF0040' || fill === 'red' || fill === '#FE2C55') {
              liked = true;
            }
            const paths = svg.querySelectorAll('path');
            for (const path of paths) {
              const pf = path.getAttribute('fill') || '';
              if (pf === '#FF0040' || pf === '#FE2C55' || pf === 'currentColor') {
                const style = window.getComputedStyle(path);
                if (style.fill && (style.fill.includes('rgb(255') || style.fill.includes('rgb(254'))) {
                  liked = true;
                }
              }
            }
          }

          return { liked, text };
        }
      }

      return null;
    });

    if (!state) {
      return blocking(
        RESULT_CODES.LIKE_STATE_UNKNOWN,
        '无法判断点赞状态',
        { data: {} }
      );
    }

    console.log(`[video-page] 点赞状态: ${state.liked ? '已赞' : '未赞'}`);
    return success({ alreadyLiked: state.liked, text: state.text });
  } catch (err) {
    return blocking(
      RESULT_CODES.LIKE_STATE_UNKNOWN,
      `检查点赞状态异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function getVideoTitle(page) {
  try {
    const title = await page.evaluate(() => {
      const titleEl = document.querySelector('title');
      if (titleEl) return titleEl.innerText.trim();
      return '';
    });

    return success({ title });
  } catch {
    return success({ title: '' });
  }
}

export async function clickLike(page) {
  try {
    const result = await page.evaluate(() => {
      const all = document.querySelectorAll('span, div, [role="button"], button');

      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (!text.startsWith('点赞') && !text.startsWith('赞')) continue;

        const parent = el.parentElement;
        const target = parent || el;

        const pCls = (target.className || '') + ' ' + (target.getAttribute('style') || '');
        const isLiked = /active|liked|selected|checked|hasLiked/i.test(pCls);

        if (isLiked) return { clicked: false, reason: 'already-liked' };

        target.click();
        return { clicked: true };
      }

      return null;
    });

    if (!result) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '找不到点赞按钮',
        { data: {} }
      );
    }

    if (!result.clicked) {
      return blocking(
        RESULT_CODES.ALREADY_LIKED,
        '已经点过赞，跳过',
        { data: {} }
      );
    }

    console.log('[video-page] 已点击点赞按钮');
    await page.waitForTimeout(2000);
    return success({ clicked: true });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `点击点赞按钮异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function confirmLikeSucceeded(page) {
  try {
    const confirmed = await page.evaluate(() => {
      const all = document.querySelectorAll('span, div, [role="button"], button');
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (!text.startsWith('点赞') && !text.startsWith('赞')) continue;

        const parent = el.parentElement;
        const target = parent || el;
        const pCls = (target.className || '') + ' ' + (target.getAttribute('style') || '');
        if (/active|liked|selected|checked|hasLiked/i.test(pCls)) {
          return { confirmed: true, signal: 'liked-class' };
        }

        const svgs = target.querySelectorAll('svg');
        for (const svg of svgs) {
          const fill = svg.getAttribute('fill') || '';
          if (fill === '#FF0040' || fill === '#FE2C55') {
            return { confirmed: true, signal: 'red-fill' };
          }
        }
      }
      return { confirmed: false, signal: 'no-indicator' };
    });

    if (confirmed.confirmed) {
      return success({ signal: confirmed.signal });
    }

    return blocking(
      RESULT_CODES.BLOCKED,
      '点击点赞按钮后无法确认已赞，请检查页面状态',
      { data: { signal: confirmed.signal } }
    );
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `确认点赞异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}
