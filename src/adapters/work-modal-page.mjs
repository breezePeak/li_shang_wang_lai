import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

export function extractModalIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/[?&]modal_id=([^&#]+)/);
  return match ? match[1] : null;
}

export async function extractWorkModalContext(page) {
  const currentUrl = page.url();
  const modalId = extractModalIdFromUrl(currentUrl);

  if (!modalId) {
    return blocking(RESULT_CODES.BLOCKED, 'URL 中没有 modal_id，不在作品 modal 中', { recoverable: false });
  }

  let workTitle = '';
  try {
    workTitle = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;

      const desc = scope.querySelector('[class*="desc"], [class*="title"], [class*="caption"], [class*="mark"]');
      if (desc) {
        const text = (desc.innerText || '').trim();
        if (text.length > 2 && text.length < 500) return text;
      }

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = (ogTitle.getAttribute('content') || '').trim();
        if (content.length > 2) return content;
      }

      const title = document.title || '';
      const cleaned = title.replace(/ - 抖音$/, '').replace(/的抖音.*$/, '').trim();
      if (cleaned.length > 2) return cleaned;

      return '';
    });
  } catch {}

  const videoMatch = currentUrl.match(/\/video\/([^/?#]+)/);
  const noteMatch = currentUrl.match(/\/note\/([^/?#]+)/);
  let workType = 'unknown';
  let workId = modalId;
  if (videoMatch) { workType = 'video'; workId = 'video-' + videoMatch[1]; }
  else if (noteMatch) { workType = 'note'; workId = 'note-' + noteMatch[1]; }

  return success({
    currentUrl,
    workId,
    workUrl: normalizeDouyinUrl(currentUrl.split('?')[0]) + '?modal_id=' + modalId,
    workTitle: workTitle || null,
    workType,
    modalId,
    isModal: true,
  });
}

export async function waitForWorkModal(page, { timeoutMs = 10000 } = {}) {
  try {
    await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: timeoutMs });
    await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
    return success({ modalVisible: true });
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `作品 modal 未出现: ${err.message}`, { recoverable: false });
  }
}

export async function findCommentInWorkModal(page, item) {
  const actorName = (item?.actorName || '').trim();
  const commentText = (item?.commentText || '').trim();
  const eventTimeText = (item?.eventTimeText || '').trim();

  if (!commentText) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, 'commentText 为空，无法定位评论', { recoverable: false });
  }

  try {
    const found = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const items = commentArea.querySelectorAll('.comment-item-info-wrap');
      for (let i = 0; i < items.length; i++) {
        const text = (items[i].innerText || '').trim();
        if (!text.includes(commentText)) continue;
        if (actorName && !text.includes(actorName)) continue;
        if (eventTimeText && !text.includes(eventTimeText)) continue;

        const rect = items[i].getBoundingClientRect();
        return {
          ok: true,
          commentIndex: i,
          previewText: text.slice(0, 200),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      }

      for (let i = 0; i < items.length; i++) {
        const text = (items[i].innerText || '').trim();
        if (!text.includes(commentText)) continue;

        const rect = items[i].getBoundingClientRect();
        return {
          ok: true,
          commentIndex: i,
          previewText: text.slice(0, 200),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          fallback: true,
        };
      }

      return { ok: false, reason: 'no matching comment', totalItems: items.length };
    }, { actorName, commentText, eventTimeText });

    if (found.ok) {
      return success(found);
    }

    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, found.reason || '评论未找到', { recoverable: true, data: found });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, `查找评论异常: ${err.message}`, { recoverable: true });
  }
}

export async function openReplyBoxInWorkModal(page, item) {
  const actorName = (item?.actorName || '').trim();
  const commentText = (item?.commentText || '').trim();
  const eventTimeText = (item?.eventTimeText || '').trim();

  console.error(`[work-modal] 定位评论: actorName="${actorName}" commentText="${commentText.slice(0, 40)}"`);

  try {
    const clicked = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const items = commentArea.querySelectorAll('.comment-item-info-wrap');
      let targetItem = null;

      for (const it of items) {
        const text = (it.innerText || '').trim();
        if (!text.includes(commentText)) continue;
        if (actorName && !text.includes(actorName)) continue;
        if (eventTimeText && !text.includes(eventTimeText)) continue;
        targetItem = it;
        break;
      }

      if (!targetItem) {
        for (const it of items) {
          const text = (it.innerText || '').trim();
          if (text.includes(commentText)) { targetItem = it; break; }
        }
      }

      if (!targetItem) return { ok: false, reason: 'comment not found' };

      const spans = targetItem.querySelectorAll('span');
      for (const span of spans) {
        if ((span.innerText || '').trim() === '回复') {
          const rect = span.getBoundingClientRect();
          span.click();
          return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
      }

      return { ok: false, reason: '回复 span not found in comment item' };
    }, { actorName, commentText, eventTimeText });

    if (!clicked.ok) {
      return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, clicked.reason, { recoverable: true });
    }

    console.error(`[work-modal] 已点击回复 span at (${clicked.x}, ${clicked.y})`);

    await page.waitForTimeout(1000);

    const inputVisible = await page.evaluate(() => {
      const commentArea = document.querySelector('.comment-mainContent');
      const scope = commentArea || document.body;
      const inputs = scope.querySelectorAll('input[type="text"]');
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 20) return true;
      }
      return false;
    });

    if (!inputVisible) {
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '点击回复后输入框未出现', { recoverable: true });
    }

    console.error(`[work-modal] 回复输入框已出现`);
    return success({ replyBoxOpened: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, `打开回复框异常: ${err.message}`, { recoverable: true });
  }
}

export async function sendReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 发送回复: "${replyText.slice(0, 60)}"`);

  try {
    const filled = await page.evaluate((text) => {
      const commentArea = document.querySelector('.comment-mainContent');
      const scope = commentArea || document.body;
      const inputs = scope.querySelectorAll('input[type="text"]');
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 20) continue;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      return { ok: false };
    }, replyText);

    if (!filled.ok) {
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '找不到回复输入框', { recoverable: true });
    }

    await page.waitForTimeout(800);

    const sent = await page.evaluate(() => {
      const commentArea = document.querySelector('.comment-mainContent');
      const scope = commentArea || document.body;

      const spans = scope.querySelectorAll('span');
      for (const span of spans) {
        if ((span.innerText || '').trim() === '发送') {
          span.click();
          return { ok: true, method: 'click_send_span' };
        }
      }

      const buttons = scope.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.innerText || '').trim() === '发送') {
          btn.click();
          return { ok: true, method: 'click_send_button' };
        }
      }

      return { ok: false, reason: 'no_send_button' };
    });

    if (sent.ok) {
      console.error(`[work-modal] 点击发送成功 (${sent.method})`);
      await page.waitForTimeout(2000);
      return success({ sent: true, method: sent.method });
    }

    const commentArea = document.querySelector('.comment-mainContent');
    const scope = commentArea || await page.evaluateHandle(() => document.body);
    const inputLocator = page.locator('.comment-mainContent input[type="text"]').first();
    await inputLocator.press('Enter');
    console.error(`[work-modal] 按 Enter 发送`);
    await page.waitForTimeout(2000);

    return success({ sent: true, method: 'enter_key' });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND, `发送回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function verifyReplyInWorkModal(page, item, replyText, { timeoutMs = 5000 } = {}) {
  const commentText = (item?.commentText || '').trim();
  const replyNeedle = replyText.trim();
  const replyPrefix = replyNeedle.slice(0, 20);

  console.error(`[work-modal] 验证回复: "${replyNeedle.slice(0, 40)}"`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await page.evaluate(({ commentText, replyNeedle, replyPrefix }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { verified: false };

      const text = (commentArea.innerText || '').trim();
      if (text.includes(replyNeedle)) return { verified: true, method: 'full' };
      if (replyPrefix.length >= 5 && text.includes(replyPrefix)) return { verified: true, method: 'prefix' };

      return { verified: false };
    }, { commentText, replyNeedle, replyPrefix });

    if (found.verified) {
      console.error(`[work-modal] 验证成功 method=${found.method}`);
      return success({ verified: true });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.error(`[work-modal] 验证超时`);
  return blocking(RESULT_CODES.COMMENT_SEND_UNCONFIRMED, '回复未出现在评论区', { recoverable: true });
}