import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { findScrollableContainerBox, scrollContainerByWheel } from './scroll-container.mjs';
import path from 'path';

async function captureReplyBoxDebug(page, phase) {
  try {
    const dir = path.resolve('data', 'debug', 'reply-box');
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(dir, `${ts}-${phase}`);

    const data = await page.evaluate(() => {
      function summarize(el) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const parent = el.parentElement;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: (el.getAttribute('class') || '').slice(0, 300),
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          text: (el.innerText || el.textContent || '').trim().slice(0, 300),
          value: typeof el.value === 'string' ? el.value.slice(0, 200) : '',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.width > 0 && rect.height > 0,
          html: el.outerHTML.slice(0, 1000),
          parentClassName: parent ? (parent.getAttribute('class') || '').slice(0, 300) : '',
          parentText: parent ? (parent.innerText || parent.textContent || '').trim().slice(0, 300) : '',
          parentHtml: parent ? parent.outerHTML.slice(0, 1200) : '',
        };
      }

      const inputSelector = 'input, textarea, [contenteditable="true"], [role="textbox"]';
      const inputs = Array.from(document.querySelectorAll(inputSelector)).map(summarize);

      const actionEls = Array.from(document.querySelectorAll('button, [role="button"], span, div'))
        .map(el => ({ el, text: (el.innerText || el.textContent || '').trim() }))
        .filter(({ el, text }) => {
          if (!text) return false;
          if (!['回复', '回复中', '发送', '评论', '取消'].some(t => text === t || text.includes(t))) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 80)
        .map(({ el }) => summarize(el));

      const containers = Array.from(document.querySelectorAll('[class*="comment"], [class*="reply"], [class*="input"], [class*="editor"]'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 80)
        .map(summarize);

      return {
        url: location.href,
        title: document.title,
        activeElement: summarize(document.activeElement),
        bodyTextPreview: (document.body?.innerText || '').slice(-2000),
        inputs,
        actionEls,
        containers,
      };
    });

    writeJSON(`${base}.json`, data);
    try {
      await page.screenshot({ path: `${base}.png`, fullPage: false });
    } catch {}
    console.error(`[work-modal] 回复框诊断已保存: ${base}.json`);
    return `${base}.json`;
  } catch (err) {
    console.error(`[work-modal] 回复框诊断保存失败: ${err.message}`);
    return null;
  }
}

async function typeIntoReplyDraftEditor(page, replyText) {
  async function prepareStrictEditor() {
    return page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 18) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      document.querySelectorAll('[data-return-visit-editor="true"]').forEach(el => el.removeAttribute('data-return-visit-editor'));
      document.querySelectorAll('[data-return-visit-comment-host="true"]').forEach(el => el.removeAttribute('data-return-visit-comment-host'));

      const commentInputContainer = document.querySelector('.comment-input-container');
      if (!visible(commentInputContainer)) return { ok: false, reason: 'comment_input_container_not_found' };

      commentInputContainer.setAttribute('data-return-visit-comment-host', 'true');

      const editorSelectors = [
        '.public-DraftEditor-content[contenteditable="true"]',
        '.DraftEditor-editorContainer .public-DraftEditor-content[contenteditable="true"]',
        '[contenteditable="true"]',
        '[role="combobox"][contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
      ];

      let target = null;
      for (const selector of editorSelectors) {
        const match = commentInputContainer.querySelector(selector);
        if (visible(match)) {
          target = match;
          break;
        }
      }

      if (target) {
        target.setAttribute('data-return-visit-editor', 'true');
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.focus?.();
        target.click?.();
        return { ok: true };
      }

      const activators = [
        commentInputContainer.querySelector('.comment-input-inner-container'),
        commentInputContainer.querySelector('.LpZjb4Yg'),
        commentInputContainer.querySelector('.j_kd_P_l'),
        commentInputContainer,
      ].filter(Boolean);

      for (const el of activators) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        el.click?.();
      }

      const rect = commentInputContainer.getBoundingClientRect();
      return {
        ok: false,
        reason: 'editor_not_activated_yet',
        clickPoint: {
          x: Math.round(rect.left + Math.min(40, rect.width * 0.2)),
          y: Math.round(rect.top + rect.height / 2),
        },
      };
    }).catch(() => ({ ok: false, reason: 'prepare_editor_failed' }));
  }

  let editorPrepared = await prepareStrictEditor();
  for (let attempt = 0; attempt < 3 && !editorPrepared.ok; attempt++) {
    if (editorPrepared.clickPoint?.x > 0 && editorPrepared.clickPoint?.y > 0) {
      await page.mouse.click(editorPrepared.clickPoint.x, editorPrepared.clickPoint.y).catch(() => {});
    } else {
      const host = page.locator('[data-return-visit-comment-host="true"]').last();
      await host.click({ timeout: 1500 }).catch(() => {});
    }
    await page.waitForTimeout(300);
    editorPrepared = await prepareStrictEditor();
  }

  if (!editorPrepared.ok) {
    return { ok: false, reason: editorPrepared.reason || 'prepare_editor_failed' };
  }

  const editor = page.locator('[data-return-visit-editor="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 3000 });
  await editor.click({ timeout: 3000 }).catch(() => {});

  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(replyText);
  await page.waitForTimeout(300).catch(() => {});

  const typed = await page.evaluate((text) => {
    const container = document.querySelector('.comment-input-container');
    const editorEl = document.querySelector('[data-return-visit-editor="true"]')
      || container?.querySelector('.public-DraftEditor-content[contenteditable="true"]')
      || container?.querySelector('[contenteditable="true"]');
    if (!editorEl) return { ok: false, reason: 'editor disappeared after insertText' };
    const rect = editorEl.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 10) return { ok: false, reason: 'editor too small after insertText' };

    const fallbackRaw = editorEl.innerText;
    const fallbackText = (container?.innerText || fallbackRaw || '').trim();
    const sendButton = container?.querySelector('.commentInput-right-ct .FbVIhLlK');
    if (fallbackText.includes(text) || fallbackText.includes(text.slice(0, Math.min(10, text.length)))) {
      return {
        ok: true,
        method: 'keyboard_insert_text',
        sendButtonVisible: !!sendButton,
      };
    }
    return { ok: false, reason: 'text not reflected in reply editor' };
  }, replyText);

  return typed;
}

async function clickReplySendControl(page) {
  return await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    const container = document.querySelector('.comment-input-container');
    if (!visible(container)) return { ok: false, reason: 'comment_input_container_not_found' };

    const sendArea = container.querySelector('.commentInput-right-ct');
    if (!visible(sendArea)) return { ok: false, reason: 'comment_send_area_not_found' };

    const iconTargets = ['.FbVIhLlK'];
    for (const selector of iconTargets) {
      const matches = Array.from(sendArea.querySelectorAll(selector)).filter(visible);
      for (const el of matches) {
        const target = el.closest('button,[role="button"],span,div') || el;
        if (!visible(target)) continue;
        target.click?.();
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, method: 'send_control_click', label: selector };
      }
    }

    return { ok: false, reason: 'strict_send_control_not_found' };
  });
}

export function parseDouyinTimeText(text) {
  if (!text) return null;
  const now = new Date();
  const trimmed = String(text || '').trim();
  const weekdayMatch = trimmed.match(/^(?:星期|周)([一二三四五六日天])$/);
  if (weekdayMatch) {
    const weekdayMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    const targetDay = weekdayMap[weekdayMatch[1]];
    const currentDay = now.getDay();
    let diffDays = (currentDay - targetDay + 7) % 7;
    if (diffDays === 0) diffDays = 7;
    return new Date(now.getTime() - diffDays * 86400000).toISOString();
  }
  const dayWithClock = trimmed.match(/^(昨天|前天)\s*(\d{1,2}):(\d{2})$/);
  if (dayWithClock) {
    const days = dayWithClock[1] === '昨天' ? 1 : 2;
    const dt = new Date(now.getTime() - days * 86400000);
    dt.setHours(parseInt(dayWithClock[2], 10), parseInt(dayWithClock[3], 10), 0, 0);
    return dt.toISOString();
  }
  const m = text.match(/(\d+)天前/);
  if (m) return new Date(now.getTime() - parseInt(m[1]) * 86400000).toISOString();
  const h = text.match(/(\d+)小时前/);
  if (h) return new Date(now.getTime() - parseInt(h[1]) * 3600000).toISOString();
  const min = text.match(/(\d+)分钟前/);
  if (min) return new Date(now.getTime() - parseInt(min[1]) * 60000).toISOString();
  const sec = text.match(/(\d+)秒前/);
  if (sec) return new Date(now.getTime() - parseInt(sec[1]) * 1000).toISOString();
  if (text.startsWith('刚刚')) return now.toISOString();
  if (text.startsWith('昨天')) return new Date(now.getTime() - 86400000).toISOString();
  if (text.startsWith('前天')) return new Date(now.getTime() - 2 * 86400000).toISOString();
  const md = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (md) return new Date(now.getFullYear(), parseInt(md[1]) - 1, parseInt(md[2])).toISOString();
  const dash = text.match(/(\d{2})-(\d{2})/);
  if (dash) return new Date(now.getFullYear(), parseInt(dash[1]) - 1, parseInt(dash[2])).toISOString();
  const full = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (full) return new Date(parseInt(full[1]), parseInt(full[2]) - 1, parseInt(full[3])).toISOString();
  return null;
}

export function extractModalIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/[?&]modal_id=([^&#]+)/);
  return match ? match[1] : null;
}

async function isWorkModalVisible(page) {
  return await page.evaluate(() => {
    const modals = document.querySelectorAll('[data-e2e="modal-video-container"], .modal-video-container');
    for (const modal of modals) {
      const rect = modal.getBoundingClientRect();
      const inViewport = rect.bottom > 80 && rect.right > 80 && rect.top < window.innerHeight - 80 && rect.left < window.innerWidth - 80;
      if (rect.width > 100 && rect.height > 100 && inViewport) return true;
    }
    return false;
  });
}

export async function extractWorkModalContext(page) {
  const currentUrl = page.url();
  const modalId = extractModalIdFromUrl(currentUrl);

  if (!modalId) {
    return blocking(RESULT_CODES.BLOCKED, 'URL 中没有 modal_id，不在作品 modal 中', { recoverable: false });
  }

  let workTitle = '';
  let workText = '';
  try {
    const textData = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;

      const specificSelectors = [
        'div.title[data-e2e="video-desc"]',
        '[data-e2e="video-desc"]',
        '[class*="video-desc"]',
        '[class*="desc-info"]',
        '[class*="work-desc"]',
        '[class*="aweme-desc"]',
        '[class*="publish-desc"]',
        '[class*="video-info"] [class*="desc"]',
        '[class*="detail-desc"]',
      ];
      const descriptions = [];
      for (const sel of specificSelectors) {
        const el = scope.querySelector(sel);
        if (el) {
          const text = (el.innerText || '').trim();
          if (text.length > 2 && text.length < 500 && !text.includes('回复') && !text.includes('评论')) descriptions.push(text);
        }
      }

      const genericDesc = scope.querySelector('[class*="desc"], [class*="caption"], [class*="mark"]');
      if (genericDesc) {
        const text = (genericDesc.innerText || '').trim();
        if (text.length > 2 && text.length < 500 && !text.includes('回复') && !text.includes('评论')) descriptions.push(text);
      }

      const metaDescription = document.querySelector('meta[name="description"], meta[property="og:description"]');
      const metaText = (metaDescription?.getAttribute('content') || '').trim();
      if (metaText.length > 2) descriptions.push(metaText);

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = (ogTitle.getAttribute('content') || '').trim();
        if (content.length > 2) descriptions.push(content);
      }

      const title = document.title || '';
      const cleaned = title.replace(/ - 抖音$/, '').replace(/的抖音.*$/, '').trim();
      if (cleaned.length > 2) descriptions.push(cleaned);

      const unique = [];
      const seen = new Set();
      for (const item of descriptions) {
        const normalized = item.replace(/\s+/g, ' ').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
      }

      const titleText = unique[0] || '';
      const bodyText = unique.join('\n').slice(0, 1200);
      return { titleText, bodyText };
    });
    workTitle = textData.titleText || '';
    workText = textData.bodyText || workTitle || '';
  } catch {}

  const videoMatch = currentUrl.match(/\/video\/([^/?#]+)/);
  const noteMatch = currentUrl.match(/\/note\/([^/?#]+)/);
  let workType = 'unknown';
  let workId = modalId;
  if (videoMatch) { workType = 'video'; workId = 'video-' + videoMatch[1]; }
  else if (noteMatch) { workType = 'note'; workId = 'note-' + noteMatch[1]; }

  let authorName = '', authorProfileKey = '', authorProfileUrl = '', workTypeFromDom = '';
  try {
    const authorData = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;
      let name = '', key = '', url = '', typeText = '';

      const nicknameEl = scope.querySelector('[data-e2e="feed-video-nickname"]');
      if (nicknameEl) {
        const text = (nicknameEl.innerText || '').trim().replace(/^@/, '');
        if (text.length > 0 && text.length < 50) name = text;
      }

      if (!name) {
        const authorLink = scope.querySelector('a[href*="/user/"]');
        if (authorLink) {
          const href = authorLink.getAttribute('href') || '';
          const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
          if (match) { key = match[1]; url = href; }
          const text = (authorLink.innerText || '').trim().replace(/^@/, '');
          if (text.length > 0 && text.length < 50) name = text;
        }
      }

      if (!name) {
        const authorEl = scope.querySelector('[class*="author"], [class*="nickname"], [class*="userName"]');
        if (authorEl) {
          const text = (authorEl.innerText || '').trim().replace(/^@/, '');
          if (text.length > 0 && text.length < 50) name = text;
        }
      }

      if (!key) {
        const authorLink = scope.querySelector('a[href*="/user/"]');
        if (authorLink) {
          const href = authorLink.getAttribute('href') || '';
          const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
          if (match) { key = match[1]; url = href; }
        }
      }

      const accountCard = scope.querySelector('.account-card');
      if (accountCard) {
        const text = (accountCard.innerText || '').trim();
        if (text.includes('图文')) typeText = 'note';
        else if (text.includes('视频')) typeText = 'video';
      }

      return { name, key, url, typeText };
    });
    authorName = authorData.name;
    authorProfileKey = authorData.key;
    authorProfileUrl = authorData.url;
    workTypeFromDom = authorData.typeText;
  } catch {}

  if (workTypeFromDom) workType = workTypeFromDom;

  const isOwnWorkByUrl = currentUrl.includes('/user/self');

  let publishedAtText = '';
  try {
    publishedAtText = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;
      const directSelectors = [
        '.video-create-time span.time',
        '.video-create-time',
        'span.time',
      ];
      for (const sel of directSelectors) {
        const el = scope.querySelector(sel);
        if (el) {
          const text = (el.innerText || '').trim().replace(/^·\s*/, '');
          if (text.length > 0 && text.length < 30) return text;
        }
      }
      const timeSelectors = [
        '[class*="publish-time"]',
        '[class*="create-time"]',
        '[class*="aweme-time"]',
        '[class*="time-text"]',
        '[class*="date-text"]',
      ];
      for (const sel of timeSelectors) {
        const el = scope.querySelector(sel);
        if (el) {
          const text = (el.innerText || '').trim().replace(/^·\s*/, '');
          if (text.length > 0 && text.length < 30) return text;
        }
      }
      return '';
    });
  } catch {}

  let thumbnailSrc = '';
  try {
    thumbnailSrc = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;
      const img = scope.querySelector('img[class*="poster"], img[class*="cover"], video');
      if (img) return img.src || img.poster || '';
      return '';
    });
  } catch {}

  return success({
    currentUrl,
    workId,
    workUrl: normalizeDouyinUrl(currentUrl.split('?')[0]) + '?modal_id=' + modalId,
    workTitle: workTitle || null,
    workText: workText || null,
    workType,
    modalId,
    isModal: true,
    isOwnWorkByUrl,
    authorName: authorName || null,
    authorProfileKey: authorProfileKey || null,
    authorProfileUrl: authorProfileUrl || null,
    publishedAtText: publishedAtText || null,
    thumbnailSrc: thumbnailSrc || null,
  });
}

export async function waitForWorkModal(page, { timeoutMs = 10000, closeAutoPlay = false } = {}) {
  try {
    const removed = await detectVideoRemoved(page).catch(() => null);
    if (removed) {
      return blocking(RESULT_CODES.BLOCKED, `作品已删除/不可见: ${removed}`, { recoverable: true, videoRemoved: true });
    }

    const startedAt = Date.now();
    let modalVisible = false;
    while (Date.now() - startedAt < timeoutMs) {
      modalVisible = await isWorkModalVisible(page).catch(() => false);
      if (modalVisible) break;
      await page.waitForTimeout(300).catch(() => {});
    }
    if (!modalVisible) {
      await page.waitForSelector('[data-e2e="modal-video-container"], .modal-video-container', { state: 'visible', timeout: 1000 }).catch(() => {});
    }

    const removedAfter = await detectVideoRemoved(page).catch(() => null);
    if (removedAfter) {
      return blocking(RESULT_CODES.BLOCKED, `作品已删除/不可见: ${removedAfter}`, { recoverable: true, videoRemoved: true });
    }

    // Check for "加载失败" error in modal
    const loadFailed = await page.evaluate(() => {
      const errorPages = document.querySelectorAll('[data-e2e="error-page"]');
      for (const errorPage of errorPages) {
        if (errorPage.closest('#videoSideCard, #relatedVideoCard')) continue;
        const text = (errorPage.innerText || '').trim();
        if (text.includes('加载失败') || text.includes('网络') || text.includes('稍后重试')) return text.slice(0, 80);
      }
      return null;
    }).catch(() => null);
    if (loadFailed) {
      return blocking(RESULT_CODES.BLOCKED, `作品加载失败: ${loadFailed}`, { recoverable: true });
    }

    if (closeAutoPlay) {
      await page.waitForTimeout(1500);
      for (let retry = 0; retry < 2; retry++) {
        const autoPlayResult = await page.evaluate(() => {
          const autoPlayEl = document.querySelector('.xgplayer-autoplay-setting');
          if (!autoPlayEl) return { found: false };
          const e2eState = autoPlayEl.querySelector('[data-e2e-state]')?.getAttribute('data-e2e-state') || '';
          const isOff = e2eState.includes('no-auto-play');
          if (isOff) return { found: true, alreadyOff: true };
          const switchBtn = autoPlayEl.querySelector('.xg-switch');
          if (switchBtn) { switchBtn.click(); return { found: true, alreadyOff: false, method: 'switch' }; }
          autoPlayEl.click();
          return { found: true, alreadyOff: false, method: 'parent' };
        }).catch(() => ({ found: false }));
        if (!autoPlayResult.found) break;
        if (autoPlayResult.alreadyOff) {
          console.error('[work-modal] 连播已关闭');
          break;
        }
        console.error(`[work-modal] 尝试关闭连播 (method=${autoPlayResult.method})`);
        await page.waitForTimeout(800);
        const verifyOff = await page.evaluate(() => {
          const el = document.querySelector('.xgplayer-autoplay-setting [data-e2e-state]');
          return el ? el.getAttribute('data-e2e-state') : '';
        }).catch(() => '');
        if (verifyOff.includes('no-auto-play')) {
          console.error('[work-modal] 连播已关闭');
          break;
        }
      }
    }

    const isCommentAreaVisible = async () => await page.evaluate(() => {
      const commentAreas = document.querySelectorAll('.comment-mainContent');
      for (const commentArea of commentAreas) {
        const rect = commentArea.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        if (rect.width > 50 && rect.height > 50 && inViewport) return true;
      }
      return false;
    }).catch(() => false);

    async function clickTopCommentTab() {
      return await page.evaluate(() => {
        function visible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        }

        const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, a'));
        const candidates = [];
        for (const el of nodes) {
          const text = (el.innerText || el.textContent || '').trim();
          if (!text) continue;
          if (!(text === '评论' || text.startsWith('评论\n') || text.startsWith('评论 ') || text.startsWith('评论\t') || text.startsWith('评论\r') || text.startsWith('评论'))) continue;
          if (!visible(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top > window.innerHeight * 0.45) continue;
          if (rect.width < 20 || rect.height < 20) continue;
          if (el.closest('[data-e2e="feed-comment-icon"], [data-e2e="video-comment"], [data-e2e="comment-icon"]')) continue;
          candidates.push({
            el,
            rect,
            text,
            className: typeof el.className === 'string' ? el.className : '',
            tagName: el.tagName,
          });
        }

        candidates.sort((a, b) => {
          const scoreA = (a.text === '评论' ? 0 : 1) + a.rect.top / 1000 + Math.abs(a.rect.left - window.innerWidth * 0.5) / window.innerWidth;
          const scoreB = (b.text === '评论' ? 0 : 1) + b.rect.top / 1000 + Math.abs(b.rect.left - window.innerWidth * 0.5) / window.innerWidth;
          return scoreA - scoreB;
        });
        const target = candidates[0]?.el;
        if (!target) {
          return {
            clicked: false,
            candidates: [],
          };
        }

        target.click();
        return {
          clicked: true,
          text: (target.innerText || target.textContent || '').trim(),
          className: typeof target.className === 'string' ? target.className.slice(0, 120) : '',
          tagName: target.tagName,
          candidates: candidates.slice(0, 5).map(candidate => ({
            text: candidate.text.slice(0, 80),
            className: candidate.className.slice(0, 120),
            tagName: candidate.tagName,
            top: Math.round(candidate.rect.top),
            left: Math.round(candidate.rect.left),
          })),
        };
      }).catch(() => ({ clicked: false }));
    }

    async function clickCommentOpenControl(attempt = 1) {
      const prepared = await page.evaluate(() => {
        function visible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        }

        function pickActionBar() {
          const candidates = Array.from(document.querySelectorAll('.hOcDRkbZ.WcVcXqQb'));
          if (candidates.length === 0) return null;

          const viewportCenterY = window.innerHeight / 2;
          const scored = candidates
            .map(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              const intersectsViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
              const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              const centerY = rect.top + rect.height / 2;
              return {
                el,
                rect,
                intersectsViewport,
                isVisible,
                distanceToViewportCenter: Math.abs(centerY - viewportCenterY),
              };
            })
            .filter(item => item.isVisible);

          scored.sort((a, b) => {
            if (a.intersectsViewport !== b.intersectsViewport) return a.intersectsViewport ? -1 : 1;
            return a.distanceToViewportCenter - b.distanceToViewportCenter;
          });
          return scored[0]?.el || null;
        }

        document.querySelectorAll('[data-return-visit-comment-button="true"]')
          .forEach(el => el.removeAttribute('data-return-visit-comment-button'));

        // 限定在右侧 action bar 容器内查找，避免误点其他元素（如问问AI）
        const actionBar = pickActionBar();
        const searchScope = actionBar || document;

        // 诊断：打印 action bar 内的所有 data-e2e 元素
        const diagAll = [];
        if (actionBar) {
          actionBar.querySelectorAll('[data-e2e]').forEach(el => {
            diagAll.push({
              e2e: el.getAttribute('data-e2e') || '',
              e2eState: el.getAttribute('data-e2e-state') || '',
              tag: el.tagName.toLowerCase(),
              cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
              rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
              text: (el.innerText || '').trim().slice(0, 20),
            });
          });
        }

        const commentContainer = searchScope.querySelector('[data-e2e="feed-comment-icon"]');
        if (commentContainer && visible(commentContainer)) {
          commentContainer.scrollIntoView({ block: 'center', behavior: 'instant' });
          const rect = commentContainer.getBoundingClientRect();
          commentContainer.setAttribute('data-return-visit-comment-button', 'true');

          // 诊断：该元素下方的子元素
          const children = [];
          commentContainer.querySelectorAll('*').forEach(child => {
            children.push({
              tag: child.tagName.toLowerCase(),
              cls: (typeof child.className === 'string' ? child.className : '').slice(0, 60),
              text: (child.innerText || '').trim().slice(0, 30),
            });
          });

          return {
            found: true,
            selector: '[data-e2e="feed-comment-icon"]',
            tag: commentContainer.tagName,
            className: typeof commentContainer.className === 'string' ? commentContainer.className.slice(0, 120) : '',
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            searchScopeSelector: actionBar ? '.hOcDRkbZ.WcVcXqQb' : 'document',
            diagActionBarElements: diagAll.slice(0, 10),
            diagChildren: children.slice(0, 8),
          };
        }
        return {
          found: false,
          searchScopeSelector: actionBar ? '.hOcDRkbZ.WcVcXqQb' : 'document',
          diagActionBarElements: diagAll.slice(0, 10),
          diagReason: commentContainer ? 'not_visible' : 'element_not_found',
        };
      }).catch((err) => {
        console.error(`[click-comment] 查找评论按钮异常: ${err.message}`);
        return { found: false, diagReason: 'evaluate_exception' };
      });

      if (!prepared.found) {
        console.error(`[click-comment] 未找到评论按钮 attempt=${attempt} reason=${prepared.diagReason}`);
        if (prepared.diagActionBarElements?.length > 0) {
          console.error(`[click-comment] action bar 内 data-e2e 元素:`, JSON.stringify(prepared.diagActionBarElements));
        }
        return { clicked: false };
      }

      console.error(`[click-comment] 找到评论按钮 attempt=${attempt} tag=${prepared.tag} class="${prepared.className}"` +
        ` rect=${JSON.stringify(prepared.rect)} scope=${prepared.searchScopeSelector}`);
      console.error(`[click-comment] 按钮内部子元素:`, JSON.stringify(prepared.diagChildren));
      console.error(`[click-comment] action bar 元素列表:`, JSON.stringify(prepared.diagActionBarElements));

      let clickMethod = '';
      if (prepared.y < 0 || prepared.y > 800 || prepared.x < 0 || prepared.x > 1280) {
        console.error(`[click-comment] 坐标异常 (${prepared.x},${prepared.y})，使用 locator.click 兜底`);
        clickMethod = 'locator';
        const button = page.locator('[data-return-visit-comment-button="true"]').last();
        await button.scrollIntoViewIfNeeded().catch(() => {});
        await button.click({ timeout: 3000, force: true }).catch(() => {});
      } else {
        console.error(`[click-comment] 使用 mouse.click 坐标 (${prepared.x},${prepared.y})`);
        clickMethod = 'mouse';
        await page.mouse.click(prepared.x, prepared.y).catch(async (err) => {
          console.error(`[click-comment] mouse.click 失败: ${err.message}，改用 locator.click`);
          clickMethod = 'locator_fallback';
          const button = page.locator('[data-return-visit-comment-button="true"]').last();
          await button.scrollIntoViewIfNeeded().catch(() => {});
          await button.click({ timeout: 3000, force: true });
        });
      }

      console.error(`[click-comment] 点击完成 method=${clickMethod}`);

      return {
        clicked: true,
        selector: prepared.selector,
        tag: prepared.tag,
        className: prepared.className,
        rect: prepared.rect,
      };
    }

    if (!(await isCommentAreaVisible())) {
      console.error('[work-modal] 评论区未展开，点击评论按钮...');
      let opened = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const clicked = await clickCommentOpenControl();
        if (!clicked.clicked) {
          console.error(`[work-modal] 未找到评论按钮 (attempt=${attempt})`);
        } else {
          const rect = clicked.rect ? ` rect=${JSON.stringify(clicked.rect)}` : '';
          const detail = clicked.tag ? ` tag=${clicked.tag} class="${String(clicked.className || '').slice(0, 60)}"${rect}` : '';
          console.error(`[work-modal] 已点击评论按钮 ${clicked.selector} (attempt=${attempt})${detail}`);
        }

        // 新版抖音点击评论图标默认打开"问问AI"，需要再点"评论"tab切换到真实评论区
        if (clicked.clicked) {
          await page.waitForTimeout(800);
          const tabClicked = await clickTopCommentTab();
          if (tabClicked.clicked) {
            console.error(`[work-modal] 已点击评论Tab text="${tabClicked.text}" tag=${tabClicked.tagName} class="${tabClicked.className}" (attempt=${attempt})`);
          } else {
            console.error(`[work-modal] 未找到评论Tab按钮 (attempt=${attempt}), candidates=`, JSON.stringify(tabClicked.candidates || []));
          }
        }

        const deadline = Date.now() + (attempt < 3 ? 2500 : 5000);
        while (Date.now() < deadline) {
          if (await isCommentAreaVisible()) {
            opened = true;
            break;
          }
          await page.waitForTimeout(500);
        }

        if (opened) break;
        await page.waitForTimeout(700 * attempt);
      }
    }

    await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 10000 }).catch(() => {});
    if (!(await isCommentAreaVisible())) {
      return blocking(RESULT_CODES.BLOCKED, '评论区始终未展开', { recoverable: true });
    }
    return success({ modalVisible: true });
  } catch (err) {
    const removed = await detectVideoRemoved(page).catch(() => '');
    if (removed) {
      return blocking(RESULT_CODES.BLOCKED, `作品已删除/不可见: ${removed}`, { recoverable: true, videoRemoved: true });
    }
    return blocking(RESULT_CODES.BLOCKED, `作品 modal 未出现: ${err.message}`, { recoverable: false });
  }
}

export async function detectVideoRemoved(page) {
  return await page.evaluate(() => {
    const REMOVED_PATTERNS = ['视频不见了', '作品已删除', '该作品已删除', '视频已删除', '内容不可见', '该内容不可见', '作品不可见', '视频无法播放', '看看其他推荐'];
    const allText = (document.body?.innerText || '');
    for (const pat of REMOVED_PATTERNS) {
      if (allText.includes(pat)) return pat;
    }
    const overlays = document.querySelectorAll('[class*="error"], [class*="empty"], [class*="removed"], [class*="deleted"], [class*="not-found"]');
    for (const el of overlays) {
      if (el.closest('#videoSideCard, #relatedVideoCard')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 100) {
        const text = (el.innerText || '').trim();
        if (text.length > 0) return text.slice(0, 80);
      }
    }
    return null;
  });
}

export async function findCommentInWorkModal(page, item, { maxScrolls = 10 } = {}) {
  const actorName = (item?.actorName || '').trim();
  const commentText = (item?.commentText || '').trim();
  const eventTimeText = (item?.eventTimeText || '').trim();

  if (!commentText) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, 'commentText 为空，无法定位评论', { recoverable: false });
  }

  try {
    console.error(`[work-modal] 查找评论 actor="${actorName}" comment="${commentText.slice(0, 40)}" time="${eventTimeText}"`);

    const found = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
      function normalizeTimeHint(value) {
        return String(value || '').split('·')[0].trim();
      }

      function collectCommentItems(commentArea) {
        const items = commentArea.querySelectorAll('[data-e2e="comment-item"]');
        const comments = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const text = (item.innerText || '').trim();
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length < 1) continue;

          let parsedActorName = '';
          let parsedCommentText = '';
          let parsedEventTimeText = '';

          const nameLine = lines[0];
          if (nameLine.length > 0 && nameLine.length < 50) parsedActorName = nameLine;

          for (const line of lines) {
            if (/^刚刚$/.test(line) || /^昨天/.test(line) || /^前天/.test(line) || /^\d+[秒分时天周月年]前/.test(line) || /^\d+月\d+日/.test(line) || /^\d{4}-\d{2}-\d{2}/.test(line)) {
              parsedEventTimeText = line;
              break;
            }
          }

          for (let k = 1; k < lines.length; k++) {
            const line = lines[k];
            if (line === '回复' || line === '赞' || line === '分享' || line === '回复中' || line === '...') continue;
            if (line === '互相关注' || line === '朋友' || line === '关注' || line === '作者' || line === '作者赞过') continue;
            if (/^\d+$/.test(line) || (/^[刚昨前天周月年]/.test(line) && line.length < 10)) continue;
            if (/^\d+[秒分时天周月年]前/.test(line) || /^\d{1,2}:\d{2}/.test(line) || /^\d+月\d+日/.test(line)) continue;
            if (line.includes('·') && line.length < 30) continue;
            if (!parsedCommentText && line.length > 0) {
              parsedCommentText = line;
              break;
            }
          }

          if (!parsedCommentText) {
            for (let k = lines.length - 1; k >= 1; k--) {
              const line = lines[k];
              if (line === '回复' || line === '赞' || line === '分享' || line === '回复中' || line === '...' || line === '作者') continue;
              if (line === '互相关注' || line === '朋友' || line === '关注' || line === '作者赞过') continue;
              if (/^\d+$/.test(line) || (/^[刚昨前天周月年]/.test(line) && line.length < 10)) continue;
              if (/^\d+[秒分时天周月年]前/.test(line) || /^\d{1,2}:\d{2}/.test(line)) continue;
              if (line.includes('·') && line.length < 30) continue;
              if (line.length > 2 && line.length < 300) {
                parsedCommentText = line;
                break;
              }
            }
          }

          const rect = item.getBoundingClientRect();
          comments.push({
            commentIndex: i,
            actorName: parsedActorName,
            commentText: parsedCommentText.slice(0, 300),
            eventTimeText: parsedEventTimeText,
            previewText: text.slice(0, 200),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
        return comments;
      }

      function matchComment(comments, actorName, commentText, eventTimeText) {
        const normalizedTime = normalizeTimeHint(eventTimeText);
        for (const comment of comments) {
          if (!comment.commentText || !comment.commentText.includes(commentText)) continue;
          if (actorName && comment.actorName !== actorName) continue;
          if (normalizedTime && normalizeTimeHint(comment.eventTimeText) && normalizeTimeHint(comment.eventTimeText) !== normalizedTime) continue;
          return { ok: true, ...comment };
        }
        for (const comment of comments) {
          if (!comment.commentText || !comment.commentText.includes(commentText)) continue;
          return { ok: true, fallback: true, ...comment };
        }
        return null;
      }

      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const comments = collectCommentItems(commentArea);
      const match = matchComment(comments, actorName, commentText, eventTimeText);
      if (match) return match;

      const canScroll = commentArea.scrollHeight > commentArea.clientHeight + 10;
      return { ok: false, reason: 'no matching comment', totalItems: comments.length, canScroll, samples: comments.slice(0, 5) };
    }, { actorName, commentText, eventTimeText });

    if (found.ok) {
      console.error(`[work-modal] 找到评论 index=${found.commentIndex} preview="${String(found.previewText || '').slice(0, 60)}"`);
      return success(found);
    }

    if (Array.isArray(found.samples) && found.samples.length > 0) {
      for (const sample of found.samples.slice(0, 3)) {
        console.error(`[work-modal] 样本评论 index=${sample.commentIndex} actor="${sample.actorName}" comment="${String(sample.commentText || '').slice(0, 40)}" time="${sample.eventTimeText || ''}"`);
      }
    }

    if (!found.canScroll) {
      return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, found.reason || '评论未找到', { recoverable: true, data: found });
    }

    console.error(`[work-modal] 评论区可滚动，开始滚动查找 (max ${maxScrolls})`);

    for (let s = 0; s < maxScrolls; s++) {
      const scrolled = await page.evaluate(() => {
        const commentArea = document.querySelector('.comment-mainContent');
        if (!commentArea) return { scrolled: false, atEnd: true };
        const prev = commentArea.scrollTop;
        const step = Math.min(150 + Math.floor(Math.random() * 150), commentArea.scrollHeight - commentArea.scrollTop);
        commentArea.scrollTop += step;
        return { scrolled: true, atEnd: commentArea.scrollTop === prev };
      });

      if (scrolled.atEnd) break;

      await page.waitForTimeout(1500 + Math.floor(Math.random() * 2500));

      const foundAfterScroll = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
        function normalizeTimeHint(value) {
          return String(value || '').split('·')[0].trim();
        }
        function collectCommentItems(commentArea) {
          const items = commentArea.querySelectorAll('[data-e2e="comment-item"]');
          const comments = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const text = (item.innerText || '').trim();
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 1) continue;
            let parsedActorName = '';
            let parsedCommentText = '';
            let parsedEventTimeText = '';
            const nameLine = lines[0];
            if (nameLine.length > 0 && nameLine.length < 50) parsedActorName = nameLine;
            for (const line of lines) {
              if (/^刚刚$/.test(line) || /^昨天/.test(line) || /^前天/.test(line) || /^\d+[秒分时天周月年]前/.test(line) || /^\d+月\d+日/.test(line) || /^\d{4}-\d{2}-\d{2}/.test(line)) {
                parsedEventTimeText = line;
                break;
              }
            }
            for (let k = 1; k < lines.length; k++) {
              const line = lines[k];
              if (line === '回复' || line === '赞' || line === '分享' || line === '回复中' || line === '...') continue;
              if (line === '互相关注' || line === '朋友' || line === '关注' || line === '作者' || line === '作者赞过') continue;
              if (/^\d+$/.test(line) || (/^[刚昨前天周月年]/.test(line) && line.length < 10)) continue;
              if (/^\d+[秒分时天周月年]前/.test(line) || /^\d{1,2}:\d{2}/.test(line) || /^\d+月\d+日/.test(line)) continue;
              if (line.includes('·') && line.length < 30) continue;
              if (!parsedCommentText && line.length > 0) {
                parsedCommentText = line;
                break;
              }
            }
            if (!parsedCommentText) continue;
            const rect = item.getBoundingClientRect();
            comments.push({
              commentIndex: i,
              actorName: parsedActorName,
              commentText: parsedCommentText.slice(0, 300),
              eventTimeText: parsedEventTimeText,
              previewText: text.slice(0, 200),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
          }
          return comments;
        }
        function matchComment(comments, actorName, commentText, eventTimeText) {
          const normalizedTime = normalizeTimeHint(eventTimeText);
          for (const comment of comments) {
            if (!comment.commentText || !comment.commentText.includes(commentText)) continue;
            if (actorName && comment.actorName !== actorName) continue;
            if (normalizedTime && normalizeTimeHint(comment.eventTimeText) && normalizeTimeHint(comment.eventTimeText) !== normalizedTime) continue;
            return { ok: true, ...comment };
          }
          for (const comment of comments) {
            if (!comment.commentText || !comment.commentText.includes(commentText)) continue;
            return { ok: true, fallback: true, ...comment };
          }
          return null;
        }
        const commentArea = document.querySelector('.comment-mainContent');
        if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };
        const comments = collectCommentItems(commentArea);
        const match = matchComment(comments, actorName, commentText, eventTimeText);
        if (match) { match.scrolled = true; return match; }
        return { ok: false, reason: 'no matching comment', totalItems: comments.length, samples: comments.slice(0, 5) };
      }, { actorName, commentText, eventTimeText });

      if (foundAfterScroll.ok) {
        console.error(`[work-modal] 滚动 ${s + 1} 次后找到评论`);
        return success(foundAfterScroll);
      }
    }

    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, '滚动后仍未找到评论', { recoverable: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, `查找评论异常: ${err.message}`, { recoverable: true });
  }
}

export async function findUnrepliedCommentsInModal(page, { maxScrolls = 50, alreadyRepliedKeys = new Set(), selfNickname = '', maxAgeDays = null, oldCommentStopCount = 3 } = {}) {
  const allComments = [];
  const cutoffMs = maxAgeDays ? Date.now() - maxAgeDays * 86400000 : null;

  const isOlderThanWindow = (comment) => {
    if (!cutoffMs || !comment.eventTimeText) return false;
    const parsed = parseDouyinTimeText(comment.eventTimeText);
    if (!parsed) return false;
    return new Date(parsed).getTime() < cutoffMs;
  };

  const hasConsecutiveOldAtTail = () => {
    if (!cutoffMs || oldCommentStopCount <= 0 || allComments.length < oldCommentStopCount) return false;
    const tail = allComments.slice(-oldCommentStopCount);
    return tail.length === oldCommentStopCount && tail.every(isOlderThanWindow);
  };

  try {
    const collect = () => page.evaluate(({ alreadyRepliedKeysArr, selfNickname }) => {
      const alreadyRepliedKeys = new Set(alreadyRepliedKeysArr);
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { comments: [], canScroll: false };

      const items = commentArea.querySelectorAll('[data-e2e="comment-item"]');
      const comments = [];

      for (let i = 0; i < items.length; i++) {
        const text = (items[i].innerText || '').trim();
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 1) continue;

        let actorName = '';
        let commentText = '';
        let eventTimeText = '';
        let hasMyReply = false;
        let isSelfComment = false;
        let commentKey = '';

        const nameLine = lines[0];
        if (nameLine.length > 0 && nameLine.length < 50) actorName = nameLine;
        isSelfComment = !!(selfNickname && actorName === selfNickname);

        for (const line of lines) {
          if (/^刚刚$/.test(line) || /^昨天/.test(line) || /^前天/.test(line) || /^\d+[秒分时天周月年]前/.test(line) || /^\d+月\d+日/.test(line) || /^\d{4}-\d{2}-\d{2}/.test(line)) {
            eventTimeText = line;
            break;
          }
        }

        for (let k = 1; k < lines.length; k++) {
          const line = lines[k];
          if (line === '回复' || line === '赞' || line === '分享' || line === '回复中' || line === '...') continue;
          if (line === '互相关注' || line === '朋友' || line === '关注' || line === '作者' || line === '作者赞过') continue;
          if (line.includes('该评论被折叠')) continue;
          if (/^\d{1,2}$/.test(line) || (/^[刚昨前天周月年]/.test(line) && line.length < 10)) continue;
          if (/^\d+[秒分时天周月年]前/.test(line) || /^\d{1,2}:\d{2}/.test(line) || /^\d+月\d+日/.test(line)) continue;
          if (line.includes('·') && line.length < 30) continue;
          if (!commentText && line.length > 0) {
            commentText = line;
            break;
          }
        }

        if (!commentText) {
          for (let k = lines.length - 1; k >= 1; k--) {
            const line = lines[k];
            if (line === '回复' || line === '赞' || line === '分享' || line === '回复中' || line === '...' || line === '作者') continue;
            if (line === '互相关注' || line === '朋友' || line === '关注' || line === '作者赞过') continue;
            if (line.includes('该评论被折叠')) continue;
            if (/^\d{1,2}$/.test(line) || (/^[刚昨前天周月年]/.test(line) && line.length < 10)) continue;
            if (/^\d+[秒分时天周月年]前/.test(line) || /^\d{1,2}:\d{2}/.test(line)) continue;
            if (line.includes('·') && line.length < 30) continue;
            if (line.length > 2 && line.length < 300) {
              commentText = line;
              break;
            }
          }
        }

        const commentItem = items[i];
        const subReplyContainers = commentItem.querySelectorAll('.comment-item-info-wrap');
        const allSubReplies = [...subReplyContainers];
        if (allSubReplies.length > 1 && selfNickname) {
          for (const sub of allSubReplies) {
            if (sub === items[i].querySelector('.comment-item-info-wrap')) continue;
            const subText = (sub.innerText || '').trim();
            const subLines = subText.split('\n').map(l => l.trim()).filter(Boolean);
            if (subLines.length > 0 && subLines[0] === selfNickname) {
              hasMyReply = true;
              break;
            }
          }
        }

        if (!hasMyReply && selfNickname) {
          for (let li = 0; li < lines.length; li++) {
            if (lines[li] === selfNickname && li > 0) {
              hasMyReply = true;
              break;
            }
          }
        }

        commentKey = `${actorName}::${commentText.slice(0, 60)}`;
        if (!commentText || commentText.includes('该评论被折叠')) continue;

        const rect = items[i].getBoundingClientRect();
        comments.push({
          commentIndex: i,
          actorName,
          commentText: commentText.slice(0, 300),
          eventTimeText,
          hasMyReply,
          isSelfComment,
          alreadyReplied: alreadyRepliedKeys.has(commentKey),
          commentKey,
          y: Math.round(rect.y),
          visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
        });
      }

      const canScroll = commentArea.scrollHeight > commentArea.clientHeight + 10;
      return { comments, canScroll };
    }, { alreadyRepliedKeysArr: [...alreadyRepliedKeys], selfNickname });

    let result = await collect();
    allComments.push(...result.comments);
    console.error(`[work-modal] 首轮采集 ${result.comments.length} 条评论:`);
    result.comments.forEach(c => console.error(`  [${c.commentKey}] actor="${c.actorName}" isSelf=${c.isSelfComment} hasReply=${c.hasMyReply} text="${c.commentText.slice(0, 40)}"`));

    if (hasConsecutiveOldAtTail()) {
      console.error(`[work-modal] 连续 ${oldCommentStopCount} 条评论超过 ${maxAgeDays} 天，停止该作品评论采集`);
    } else if (result.canScroll) {
      for (let s = 0; s < maxScrolls; s++) {
        const scrolled = await page.evaluate(() => {
          const commentArea = document.querySelector('.comment-mainContent');
          if (!commentArea) return { atEnd: true, noMore: false };
          const END_PATTERNS = ['暂时没有更多评论', '没有更多评论', '暂无更多评论', '已经到底了', '没有更多了', '— 已到底 —'];
          const areaText = (commentArea.innerText || '').trim();
          for (const pat of END_PATTERNS) {
            if (areaText.includes(pat)) return { atEnd: true, noMore: true };
          }
          const prev = commentArea.scrollTop;
          const step = Math.min(150 + Math.floor(Math.random() * 150), commentArea.scrollHeight - commentArea.scrollTop);
          commentArea.scrollTop += step;
          return { atEnd: commentArea.scrollTop === prev, noMore: false };
        });
        if (scrolled.noMore) {
          console.error(`[work-modal] 检测到"没有更多评论"，停止滚动`);
          break;
        }
        if (scrolled.atEnd) {
          await page.waitForTimeout(2000);
          const recheck = await page.evaluate(() => {
            const commentArea = document.querySelector('.comment-mainContent');
            if (!commentArea) return { atEnd: true, noMore: false };
            const END_PATTERNS = ['暂时没有更多评论', '没有更多评论', '暂无更多评论', '已经到底了', '没有更多了'];
            const areaText = (commentArea.innerText || '').trim();
            for (const pat of END_PATTERNS) {
              if (areaText.includes(pat)) return { atEnd: true, noMore: true };
            }
            const prev = commentArea.scrollTop;
            const step = Math.min(150 + Math.floor(Math.random() * 150), commentArea.scrollHeight - commentArea.scrollTop);
            commentArea.scrollTop += step;
            return { atEnd: commentArea.scrollTop === prev, noMore: false };
          });
          if (recheck.noMore) {
            console.error(`[work-modal] 重检: 没有更多评论`);
            break;
          }
          if (recheck.atEnd) break;
        }

        await page.waitForTimeout(1500 + Math.floor(Math.random() * 2500));

        const hasError = await page.evaluate(() => {
          const errorPages = document.querySelectorAll('[data-e2e="error-page"]');
          for (const errorPage of errorPages) {
            if (errorPage.closest('#videoSideCard, #relatedVideoCard')) continue;
            const text = (errorPage.innerText || '').trim();
            if (text.includes('加载失败')) return true;
          }
          return false;
        });
        if (hasError) {
          console.error(`[work-modal] 检测到加载失败，停止滚动`);
          break;
        }

        result = await collect();
        const newComments = result.comments.filter(c => !allComments.some(e => e.commentKey === c.commentKey));
        allComments.push(...newComments);
        if (newComments.length > 0) {
          console.error(`[work-modal] 本轮新增 ${newComments.length} 条评论:`);
          newComments.forEach(c => console.error(`  [${c.commentKey}] actor=${c.actorName} isSelf=${c.isSelfComment} hasReply=${c.hasMyReply} text="${c.commentText.slice(0, 40)}"`));
        }

        if (hasConsecutiveOldAtTail()) {
          console.error(`[work-modal] 连续 ${oldCommentStopCount} 条评论超过 ${maxAgeDays} 天，停止该作品评论采集`);
          break;
        }

        if (s % 10 === 9) {
          console.error(`[work-modal] 滚动 ${s + 1} 次，累计 ${allComments.length} 条评论`);
        }

        if (!result.canScroll) break;
      }
    }

    const inWindowComments = cutoffMs
      ? allComments.filter(c => !isOlderThanWindow(c))
      : allComments;
    const pageUnreplied = inWindowComments.filter(c => !c.isSelfComment && !c.hasMyReply && c.commentText.length > 0);
    const trackedAsReplied = pageUnreplied.filter(c => c.alreadyReplied);

    console.error(
      `[work-modal] 评论扫描: 总 ${allComments.length} 条，时间窗口内 ${inWindowComments.length} 条，页面未回复 ${pageUnreplied.length} 条，库中已标记 ${trackedAsReplied.length} 条`
    );

    return success({
      total: allComments.length,
      comments: inWindowComments,
      unreplied: pageUnreplied,
      trackedAsReplied,
      allKeys: allComments.map(c => c.commentKey),
    });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, `扫描未回复评论异常: ${err.message}`, { recoverable: true });
  }
}

export const WORK_COMMENT_CONTAINER_SELECTORS = [
  '.comment-mainContent',
  '[class*="comment-main"]',
  '[class*="comment-list"]',
  '[class*="commentList"]',
  '[class*="comment"]',
];

export const WORK_COMMENT_ITEM_SELECTORS = [
  '[data-e2e="comment-item"]',
  '[class*="comment-item"]',
  '[class*="commentItem"]',
];

const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
const DAY_RELATIVE_RE = /^(昨天|前天)\s*\d{1,2}:\d{2}$/;
const EPOCH_TIME_RE = /^\d{10,13}$/;

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeActorName(value) {
  return normalizeInlineText(value).replace(/^@+/, '');
}

function normalizeTimeHint(value) {
  return normalizeInlineText(String(value || '').split('·')[0]);
}

function isRelativeTimeText(value) {
  const text = normalizeTimeHint(value);
  if (EPOCH_TIME_RE.test(text)) return true;
  return RELATIVE_TIME_RE.test(text) || DAY_RELATIVE_RE.test(text);
}

function sameTextMatch(actual, expected) {
  const left = normalizeInlineText(actual);
  const right = normalizeInlineText(expected);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function sameTimeHint(actual, expected) {
  const left = normalizeTimeHint(actual);
  const right = normalizeTimeHint(expected);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function buildWorkReplyTarget(item = {}, apiComment = null) {
  const api = apiComment || {};
  return {
    targetCommentId: String(
      item.targetCommentId ??
      item.commentTargetId ??
      item.commentCid ??
      item.cid ??
      item.comment_id ??
      item.platformEventId ??
      api.commentId ??
      api.cid ??
      ''
    ).trim(),
    actorName: normalizeActorName(item.actorName ?? item.actor_name ?? api.actorName ?? ''),
    commentText: normalizeInlineText(item.commentText ?? item.comment_text ?? api.commentText ?? ''),
    eventTimeText: normalizeInlineText(item.eventTimeText ?? item.event_time_text ?? ''),
  };
}

export function pickWorkCommentCandidate(candidates = [], target = {}) {
  const targetCommentId = String(target.targetCommentId || '').trim();
  const actorName = normalizeActorName(target.actorName);
  const commentText = normalizeInlineText(target.commentText);
  const eventTimeText = normalizeInlineText(target.eventTimeText);
  const strictTime = eventTimeText && !isRelativeTimeText(eventTimeText);

  const visibleCandidates = (candidates || []).filter(candidate => candidate && candidate.hasReplyButton);
  if (visibleCandidates.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  if (targetCommentId) {
    const cidMatches = visibleCandidates.filter(candidate => String(candidate.cid || '').trim() === targetCommentId);
    if (cidMatches.length === 1) {
      return { ok: true, candidate: cidMatches[0], matchedBy: 'cid' };
    }
    if (cidMatches.length > 1) {
      return { ok: false, reason: 'not_unique', total: cidMatches.length, matchedBy: 'cid' };
    }
  }

  let matched = visibleCandidates.filter(candidate => sameTextMatch(candidate.commentText, commentText));
  if (matched.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  if (actorName) {
    const actorMatched = matched.filter(candidate => sameTextMatch(candidate.actorName, actorName));
    if (actorMatched.length === 0) {
      return { ok: false, reason: 'actor_not_verified', total: matched.length };
    }
    matched = actorMatched;
  }

  if (strictTime) {
    const candidatesWithTime = matched.filter(candidate => normalizeTimeHint(candidate.timeText));
    if (candidatesWithTime.length > 0) {
      const timeMatched = candidatesWithTime.filter(candidate => sameTimeHint(candidate.timeText, eventTimeText));
      if (timeMatched.length === 0) {
        return { ok: false, reason: 'time_not_verified', total: matched.length };
      }
      matched = timeMatched;
    }
  }

  if (matched.length > 1) {
    return { ok: false, reason: 'not_unique', total: matched.length, matchedBy: actorName ? 'actor+text' : 'text' };
  }

  return { ok: true, candidate: matched[0], matchedBy: actorName ? 'actor+text' : 'text' };
}

export async function collectVisibleWorkCommentCandidates(page) {
  return page.evaluate(({ containerSelectors, itemSelectors }) => {
    const TIME_PATTERNS = [
      /^\d{1,2}:\d{2}(?:·.*)?$/,
      /^\d+[秒分时天周月年]前(?:·.*)?$/,
      /^\d{2}-\d{2}(?:·.*)?$/,
      /^\d+月\d+日(?:·.*)?$/,
      /^(昨天|前天)\s*\d{1,2}:\d{2}(?:·.*)?$/,
      /^(?:星期|周)[一二三四五六日天](?:·.*)?$/,
    ];
    const IGNORE_LINES = new Set([
      '互相关注',
      '作者',
      '分享',
      '回复',
      '点赞',
      '评论',
      '置顶',
      '展开',
      '收起',
      '该评论被折叠',
      '暂时没有更多评论',
      '...',
    ]);

    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function findContainer() {
      for (const selector of containerSelectors) {
        const el = document.querySelector(selector);
        if (visible(el)) return el;
      }
      return null;
    }

    function findReplyButton(root) {
      const nodes = root.querySelectorAll('button, [role="button"], span, div');
      for (const node of nodes) {
        if (!visible(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        if (text === '回复' || text.startsWith('回复')) {
          return node.closest('button,[role="button"]') || node;
        }
      }
      return null;
    }

    function isTimeLine(line) {
      return TIME_PATTERNS.some(pattern => pattern.test(line));
    }

    function isIgnorableLine(line, actorName = '') {
      const text = String(line || '').trim();
      if (!text) return true;
      if (text === actorName) return true;
      if (IGNORE_LINES.has(text)) return true;
      if (text === '0') return true;
      if (text.endsWith('赞过')) return true;
      return false;
    }

    function extractCid(el) {
      const attrs = ['data-comment-id', 'data-commentid', 'data-id', 'data-cid', 'id'];
      let current = el;
      for (let depth = 0; depth < 4 && current && current !== document.body; depth++) {
        for (const attr of attrs) {
          const value = current.getAttribute?.(attr);
          if (value && String(value).trim()) return String(value).trim();
        }
        current = current.parentElement;
      }
      return '';
    }

    function extractActorName(item, lines) {
      const selectors = [
        '[data-e2e*="nickname"]',
        '[class*="nickname"]',
        '[class*="user-name"]',
        '[class*="userName"]',
        '[class*="author"]',
      ];
      for (const selector of selectors) {
        const el = item.querySelector(selector);
        const text = (el?.innerText || '').trim().replace(/^@+/, '');
        if (text) return text;
      }
      return (lines[0] || '').replace(/^@+/, '');
    }

    function extractCommentText(item, actorName, timeText, lines) {
      const selectors = [
        '[class*="comment-content"]',
        '[class*="commentContent"]',
        '[class*="comment-text"]',
        '[class*="commentText"]',
      ];
      let best = '';
      for (const selector of selectors) {
        for (const el of item.querySelectorAll(selector)) {
          const text = (el.innerText || '').trim();
          if (text && text.length > best.length && !isIgnorableLine(text, actorName) && text !== timeText && !text.includes('回复')) {
            best = text;
          }
        }
      }
      if (best) return best;

      const timeIndex = lines.findIndex(line => isTimeLine(line));
      const scanLines = timeIndex >= 0 ? lines.slice(0, timeIndex) : lines;
      let lastUseful = '';
      for (const line of scanLines) {
        if (isIgnorableLine(line, actorName)) continue;
        lastUseful = line;
      }
      if (lastUseful) return lastUseful;

      const fallback = lines.filter(line => !isIgnorableLine(line, actorName) && !isTimeLine(line));
      return fallback[fallback.length - 1] || '';
    }

    function extractTimeText(lines) {
      return lines.find(line => isTimeLine(line)) || '';
    }

    const commentArea = findContainer();
    if (!commentArea) return { ok: false, reason: 'comment_area_not_found', candidates: [] };

    const itemList = [];
    const seen = new Set();
    for (const selector of itemSelectors) {
      for (const item of commentArea.querySelectorAll(selector)) {
        if (!visible(item) || seen.has(item)) continue;
        seen.add(item);
        itemList.push(item);
      }
    }

    if (itemList.length === 0) {
      for (const replyButton of commentArea.querySelectorAll('button, [role="button"], span, div')) {
        const text = (replyButton.innerText || replyButton.textContent || '').trim();
        if (text !== '回复' && !text.startsWith('回复')) continue;
        let current = replyButton.parentElement;
        for (let depth = 0; depth < 4 && current && current !== commentArea; depth++) {
          if (!seen.has(current) && visible(current)) {
            seen.add(current);
            itemList.push(current);
            break;
          }
          current = current.parentElement;
        }
      }
    }

    const rawCandidates = itemList.map((item, domIndex) => {
      const containerText = (item.innerText || '').trim();
      const lines = containerText.split('\n').map(line => line.trim()).filter(Boolean);
      const replyButton = findReplyButton(item);
      const actorName = extractActorName(item, lines);
      const timeText = extractTimeText(lines);
      const commentText = extractCommentText(item, actorName, timeText, lines);
      return {
        domIndex,
        cid: extractCid(item),
        actorName,
        commentText,
        timeText,
        containerText,
        containerTextLength: containerText.length,
        hasReplyButton: !!replyButton,
      };
    }).filter(candidate => candidate.commentText || candidate.cid || candidate.hasReplyButton);

    rawCandidates.sort((a, b) => a.containerTextLength - b.containerTextLength);
    const deduped = [];
    const seenKeys = new Set();
    for (const candidate of rawCandidates) {
      const key = `${candidate.cid || ''}|${candidate.actorName || ''}|${candidate.commentText || ''}|${candidate.timeText || ''}`;
      if (seenKeys.has(key)) continue;
      if (!candidate.commentText && !candidate.cid) continue;
      seenKeys.add(key);
      deduped.push(candidate);
    }

    return {
      ok: true,
      candidates: deduped.map(({ containerTextLength, ...candidate }) => candidate),
    };
  }, {
    containerSelectors: WORK_COMMENT_CONTAINER_SELECTORS,
    itemSelectors: WORK_COMMENT_ITEM_SELECTORS,
  });
}

async function clickReplyButtonForCandidate(page, candidate) {
  return page.evaluate(({ domIndex, cid, actorName, commentText }) => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getItems() {
      const selectors = [
        '[data-e2e="comment-item"]',
        '[class*="comment-item"]',
        '[class*="commentItem"]',
      ];
      const area = document.querySelector('.comment-mainContent')
        || document.querySelector('[class*="comment-main"]')
        || document.querySelector('[class*="comment-list"]')
        || document.querySelector('[class*="commentList"]');
      const items = [];
      const seen = new Set();
      if (!area) return items;
      for (const selector of selectors) {
        for (const item of area.querySelectorAll(selector)) {
          if (!visible(item) || seen.has(item)) continue;
          seen.add(item);
          items.push(item);
        }
      }
      return items;
    }

    function findReplyButton(root) {
      const nodes = root.querySelectorAll('button, [role="button"], span, div');
      for (const node of nodes) {
        if (!visible(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        if (text === '回复' || text.startsWith('回复')) {
          return node.closest('button,[role="button"]') || node;
        }
      }
      return null;
    }

    const items = getItems();
    const item = items[domIndex];
    if (!item) return { ok: false, reason: 'candidate_dom_missing' };

    const text = (item.innerText || '').trim();
    if (commentText && !text.includes(commentText)) return { ok: false, reason: 'candidate_text_changed' };
    if (actorName && !text.includes(actorName)) return { ok: false, reason: 'candidate_actor_changed' };
    if (cid) {
      const attrs = ['data-comment-id', 'data-commentid', 'data-id', 'data-cid', 'id'];
      let foundCid = '';
      let current = item;
      for (let depth = 0; depth < 4 && current && current !== document.body; depth++) {
        for (const attr of attrs) {
          const value = current.getAttribute?.(attr);
          if (value && String(value).trim()) {
            foundCid = String(value).trim();
            break;
          }
        }
        if (foundCid) break;
        current = current.parentElement;
      }
      if (foundCid && foundCid !== cid) return { ok: false, reason: 'candidate_cid_changed' };
    }

    item.scrollIntoView({ block: 'center', behavior: 'instant' });
    const replyButton = findReplyButton(item);
    if (!replyButton) return { ok: false, reason: 'reply_button_not_found' };

    const rect = replyButton.getBoundingClientRect();
    return {
      ok: true,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }, candidate);
}

async function ensureWorkReplyEditorReady(page, { timeoutMs = 3000 } = {}) {
  const startedAt = Date.now();
  let activatedContainer = false;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const commentInput = document.querySelector('.comment-input-container');
      if (commentInput) {
        const rect = commentInput.getBoundingClientRect();
        const editor = commentInput.querySelector('[contenteditable="true"], textarea, input[type="text"]');
        if (visible(editor)) {
          const placeholder = editor.getAttribute?.('placeholder') || '';
          return { ready: true, placeholder, x: 0, y: 0 };
        }
        if (rect.width > 100 && rect.height > 30) {
          return {
            ready: false,
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
            text: (commentInput.innerText || '').trim(),
          };
        }
      }
      return { ready: false, x: 0, y: 0, text: '' };
    }).catch(() => ({ ready: false, x: 0, y: 0, text: '' }));

    if (state.ready) return true;

    if (!activatedContainer && state.x > 0 && state.y > 0) {
      await page.mouse.click(state.x, state.y);
      activatedContainer = true;
      await page.waitForTimeout(300).catch(() => {});
      continue;
    }

    await page.waitForTimeout(200);
  }
  return false;
}

export async function waitForWorkCommentArea(page, { timeoutMs = 8000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await getWorkCommentContainerBox(page);
    if (found.ok && found.box) return success({ box: found.box });
    await page.waitForTimeout(300);
  }
  return blocking(RESULT_CODES.COMMENT_LIST_NOT_FOUND, '未找到作品评论区', { recoverable: true });
}

export async function getWorkCommentContainerBox(page) {
  return findScrollableContainerBox(page, {
    selectors: WORK_COMMENT_CONTAINER_SELECTORS,
    requiredText: ['回复'],
    minWidth: 300,
    minHeight: 250,
    logPrefix: '[work-modal]',
  });
}

/**
 * @deprecated 旧流程按 commentIndex 点击回复，仅兼容保留。评论回复主流程已改为作品评论区唯一定位后点击回复。
 */
export async function openReplyBoxByIndex(page, commentIndex) {
  console.error(`[work-modal] 按索引打开回复框: commentIndex=${commentIndex}`);

  try {
    const clicked = await page.evaluate((commentIndex) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const commentItems = commentArea.querySelectorAll('[data-e2e="comment-item"]');
      if (commentIndex < 0 || commentIndex >= commentItems.length) return { ok: false, reason: `index ${commentIndex} out of range (0-${commentItems.length - 1})` };

      const commentItem = commentItems[commentIndex];
      const spans = commentItem.querySelectorAll('span');
      for (const span of spans) {
        if ((span.innerText || '').trim() !== '回复') continue;
        const rect = span.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        commentItem.scrollIntoView({ block: 'center', behavior: 'instant' });
        span.click();
        return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      }
      return { ok: false, reason: 'reply_button_not_found' };
    }, commentIndex);

    if (!clicked.ok) {
      return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, clicked.reason, { recoverable: true });
    }

    const inputVisible = await ensureWorkReplyEditorReady(page);
    if (!inputVisible) {
      await captureReplyBoxDebug(page, 'open-no-input');
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '点击回复后输入框未出现', { recoverable: true });
    }

    await captureReplyBoxDebug(page, 'open-success');
    console.error(`[work-modal] 回复输入框已出现`);
    return success({ replyBoxOpened: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, `打开回复框异常: ${err.message}`, { recoverable: true });
  }
}

export async function openReplyBoxForWorkComment(page, target, { maxScrollRounds = 12 } = {}) {
  const replyTarget = buildWorkReplyTarget(target);
  const preview = replyTarget.commentText.slice(0, 40);
  console.error(`[work-modal] 定位作品评论并打开回复框 actor="${replyTarget.actorName}" comment="${preview}" cid=${replyTarget.targetCommentId || '-'}`);

  for (let round = 0; round <= maxScrollRounds; round++) {
    const collected = await collectVisibleWorkCommentCandidates(page);
    if (collected.ok) {
      const picked = pickWorkCommentCandidate(collected.candidates, replyTarget);
      if (picked.ok && picked.candidate) {
        return openReplyBoxForMatchedWorkComment(page, replyTarget, picked.candidate, { matchedBy: picked.matchedBy });
      }

      if (picked.reason === 'not_unique') {
        return blocking(
          RESULT_CODES.COMMENT_MATCH_NOT_UNIQUE,
          `评论 "${preview}" 匹配到 ${picked.total} 条候选，无法唯一定位。`,
          { recoverable: true, data: { matchCount: picked.total, target: preview } }
        );
      }

      if (picked.reason === 'actor_not_verified') {
        return blocking(
          RESULT_CODES.ACTOR_NAME_NOT_VERIFIED,
          `评论 "${preview}" 的候选均不匹配用户 "${replyTarget.actorName}"。`,
          { recoverable: true, data: { target: preview, actorName: replyTarget.actorName } }
        );
      }

      if (picked.reason === 'time_not_verified') {
        return blocking(
          RESULT_CODES.COMMENT_MATCH_NOT_UNIQUE,
          `已找到评论 "${preview}"，但时间 "${replyTarget.eventTimeText}" 无法确认。`,
          { recoverable: true, data: { target: preview, eventTimeText: replyTarget.eventTimeText } }
        );
      }
    }

    if (round === maxScrollRounds) break;

    const scrollResult = await scrollCommentAreaOnce(page);
    if (!scrollResult.ok || scrollResult.atEnd) {
      break;
    }
  }

  return blocking(
    RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND,
    `滚动评论区 ${maxScrollRounds} 轮后仍未找到目标评论 "${preview}"`,
    { recoverable: true, data: { target: preview, actorName: replyTarget.actorName } }
  );
}

export async function openReplyBoxForMatchedWorkComment(page, target, candidate, { matchedBy = 'unknown' } = {}) {
  const clicked = await clickReplyButtonForCandidate(page, candidate);
  if (!clicked.ok) {
    return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, clicked.reason, { recoverable: true });
  }

  await page.mouse.click(clicked.x, clicked.y).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});

  const inputVisible = await ensureWorkReplyEditorReady(page);
  if (!inputVisible) {
    await captureReplyBoxDebug(page, 'open-no-input');
    return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '点击回复后输入框未出现', { recoverable: true });
  }

  await captureReplyBoxDebug(page, 'open-success');
  console.error(
    `[work-modal] 已唯一定位评论并打开回复框 matchedBy=${matchedBy} actor="${target?.actorName || ''}" comment="${String(target?.commentText || '').slice(0, 40)}"`
  );
  return success({ replyBoxOpened: true, matchedBy, candidate });
}

export async function fillWorkReplyText(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 填入回复内容: "${replyText.slice(0, 60)}"`);

  try {
    const filled = await typeIntoReplyDraftEditor(page, replyText);

    if (!filled.ok) {
      await captureReplyBoxDebug(page, 'fill-no-input');
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, `找不到严格评论输入框: ${filled.reason || 'unknown'}`, { recoverable: true });
    }

    await captureReplyBoxDebug(page, 'fill-success');
    console.error(`[work-modal] 已填入回复，未点击发送 method=${filled.method}`);
    return success({ filled: true, sent: false, method: filled.method });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, `填入回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function clickSendWorkReply(page) {
  try {
    const clicked = await clickReplySendControl(page);
    if (clicked.ok) {
      console.error(`[work-modal] 点击发送控件 method=${clicked.method}`);
      await captureReplyBoxDebug(page, 'send-clicked');
      await page.waitForTimeout(2000);
      return success({ sent: true, method: clicked.method });
    }
    return blocking(RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND, `严格发送控件未找到: ${clicked.reason}`, { recoverable: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND, `发送回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function verifyWorkReplyVisible(page, item, replyText, { timeoutMs = 5000 } = {}) {
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
    }, { commentText, replyNeedle, replyPrefix }).catch(() => ({ verified: false }));

    if (found.verified) {
      console.error(`[work-modal] 验证成功 method=${found.method}`);
      return success({ verified: true });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.error(`[work-modal] 验证超时`);
  return blocking(RESULT_CODES.COMMENT_SEND_UNCONFIRMED, '回复未出现在评论区', { recoverable: true });
}

/**
 * DOM 仅负责滚动评论区触发网络请求，不解析评论内容。
 * 滚动统一复用 bounding box -> 鼠标移入 -> wheel 的真实滚动。
 */
export async function scrollCommentAreaOnce(page) {
  const found = await getWorkCommentContainerBox(page);
  if (!found.ok || !found.box) {
    return {
      ok: false,
      reason: found.reason || 'comment_container_not_found',
    };
  }

  return scrollContainerByWheel(page, {
    box: found.box,
    profile: 'commentArea',
    logPrefix: '[work-modal]',
  });
}

export async function openWorkPageForReply(page, workUrl, { timeoutMs = 30000 } = {}) {
  if (!workUrl) {
    return blocking(RESULT_CODES.WRONG_PAGE, 'work_url 为空，无法打开作品页', { recoverable: false });
  }

  await page.goto(workUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForTimeout(1500);
  return success({ workUrl });
}

export async function fillReplyInWorkModal(page, replyText) {
  return fillWorkReplyText(page, replyText);
}

export async function sendReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 发送回复: "${replyText.slice(0, 60)}"`);

  const filled = await fillWorkReplyText(page, replyText);
  if (!filled.ok) return filled;

  const clicked = await clickSendWorkReply(page);
  if (!clicked.ok) return clicked;

  return success({ ...filled.data, ...clicked.data });
}

export async function postWorkModalComment(page, commentText) {
  if (!commentText || !commentText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '评论内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 发送顶层评论: "${commentText.slice(0, 60)}"`);
  const sent = await sendReplyInWorkModal(page, commentText);
  if (!sent.ok) return sent;

  const replyNeedle = commentText.trim();
  const replyPrefix = replyNeedle.slice(0, 20);
  const startedAt = Date.now();
  let lastState = { visible: false, inputCleared: false };

  while (Date.now() - startedAt < 5000) {
    const state = await page.evaluate(({ replyNeedle, replyPrefix }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      const commentTextVisible = (commentArea?.innerText || '').trim();
      const visible = commentTextVisible.includes(replyNeedle)
        || (replyPrefix.length >= 5 && commentTextVisible.includes(replyPrefix));

      const container = document.querySelector('.comment-input-container') || document.querySelector('.comment-input-inner-container');
      const editorEl = document.querySelector('[data-return-visit-editor="true"]')
        || container?.querySelector('[contenteditable="true"], textarea, input[type="text"]');
      const editorText = (typeof editorEl?.value === 'string' ? editorEl.value : (editorEl?.innerText || editorEl?.textContent || '')).trim();
      const containerText = (container?.innerText || '').trim();
      const inputCleared = !editorText.includes(replyPrefix) && !containerText.includes(replyPrefix);

      return {
        visible,
        inputCleared,
        commentPreview: commentTextVisible.slice(0, 200),
      };
    }, { replyNeedle, replyPrefix }).catch(() => ({ visible: false, inputCleared: false }));

    lastState = state;
    if (state.visible) {
      console.error('[work-modal] 顶层评论已在评论区可见');
      return success({ ...sent.data, verified: true, unconfirmed: false });
    }

    await page.waitForTimeout(400).catch(() => {});
  }

  console.error(`[work-modal] 顶层评论发送未确认 visible=${lastState.visible} inputCleared=${lastState.inputCleared}`);
  return success({
    ...sent.data,
    verified: false,
    unconfirmed: true,
    verification: lastState,
  });
}

export async function verifyReplyInWorkModal(page, item, replyText, options = {}) {
  return verifyWorkReplyVisible(page, item, replyText, options);
}

/**
 * 在当前作品弹窗中，通过监听 /aweme/v1/web/comment/list/ 按 cid 精确查找评论。
 *
 * 调用时机：必须在 waitForWorkModal() 之后，且 collector 应在打开作品页之前就已创建。
 * 如果评论已在首页 response 中出现，直接返回；否则滚动评论区触发更多分页，最多滚动 maxScrollPages 次。
 *
 * @param {Page} page - Playwright page
 * @param {Object} opts
 * @param {string} opts.targetCommentId - 目标 cid
 * @param {number} [opts.maxScrollPages=5] - 最大滚动页数
 * @param {number} [opts.waitTimeoutMs=5000] - 首次等待超时
 * @param {Object} [opts.collector] - 预创建的 collector（必须在 modal 打开前创建）
 * @returns {Object} { ok, reason, comment?, stats?, scrollCount? }
 */
export async function findCommentByCidViaCommentListApi(page, {
  targetCommentId,
  maxScrollPages = 5,
  waitTimeoutMs = 5000,
  collector = null,
} = {}) {
  if (!targetCommentId) {
    return { ok: false, reason: 'missing_target_comment_id' };
  }

  const target = String(targetCommentId).trim();
  console.error(`[comment-list-api] start target cid=${target}`);

  let ownCollector = null;
  let coll = collector;

  if (!coll) {
    const { createCommentListApiCollector } = await import('./comment-list-api-listener.mjs');
    ownCollector = createCommentListApiCollector(page);
    coll = ownCollector;
  }

  try {
    // 先等待一下，看是否已在首次响应中捕获到目标评论
    let found = await coll.waitForComment(target, { timeoutMs: waitTimeoutMs });
    if (found) {
      console.error(`[comment-list-api] found cid=${target} source=comment-list-api text=${found.commentText}`);
      return { ok: true, reason: 'found_by_comment_list_api', comment: found, stats: coll.getStats() };
    }

    // 未找到，滚动评论区触发分页
    for (let i = 0; i < maxScrollPages; i++) {
      const scrollResult = await scrollCommentAreaOnce(page);
      if (!scrollResult.ok) {
        console.error(`[comment-list-api] 评论区不可滚动: ${scrollResult.reason}`);
        break;
      }

      // 等待新接口数据
      found = await coll.waitForComment(target, { timeoutMs: 2500 });

      if (found) {
        console.error(`[comment-list-api] found cid=${target} source=comment-list-api_after_scroll text=${found.commentText}`);
        return {
          ok: true,
          reason: 'found_by_comment_list_api_after_scroll',
          comment: found,
          stats: coll.getStats(),
          scrollCount: i + 1,
        };
      }

      const stats = coll.getStats();
      // has_more 明确为 0 时不再滚动
      if (Number(stats.hasMore) === 0) {
        console.error(`[comment-list-api] has_more=0 停止滚动，已捕获 ${stats.commentCount} 条评论`);
        break;
      }

      if (scrollResult.atEnd) {
        console.error(`[comment-list-api] 评论区已滚动到底部`);
        break;
      }
    }

    const stats = coll.getStats();
    console.error(`[comment-list-api] not found cid=${target} responses=${stats.responseCount} comments=${stats.commentCount} has_more=${stats.hasMore}`);
    return {
      ok: false,
      reason: 'comment_not_found_in_comment_list_api',
      stats,
      sampleComments: coll.getAllComments().slice(0, 5),
    };
  } finally {
    if (ownCollector) {
      ownCollector.stop();
    }
  }
}
