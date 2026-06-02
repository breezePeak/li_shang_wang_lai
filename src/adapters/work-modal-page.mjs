import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
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
  const editor = page.locator('.comment-input-container [contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 3000 });
  await editor.click({ timeout: 3000 });
  await page.keyboard.insertText(replyText);

  const typed = await page.evaluate((text) => {
    const container = document.querySelector('.comment-input-container');
    const editorEl = container?.querySelector('[contenteditable="true"]');
    const visibleText = (container?.innerText || editorEl?.innerText || '').trim();
    if (visibleText.includes(text) || visibleText.includes(text.slice(0, Math.min(10, text.length)))) {
      return { ok: true, method: 'keyboard_insertText' };
    }

    if (!editorEl) return { ok: false, reason: 'editor disappeared after insertText' };
    const rect = editorEl.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 10) return { ok: false, reason: 'editor too small after insertText' };

    editorEl.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editorEl);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));

    const fallbackText = (container?.innerText || editorEl.innerText || '').trim();
    if (fallbackText.includes(text) || fallbackText.includes(text.slice(0, Math.min(10, text.length)))) {
      return { ok: true, method: 'execCommand_fallback' };
    }
    return { ok: false, reason: 'text not reflected in reply editor' };
  }, replyText);

  return typed;
}

async function clickReplySendControl(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('.comment-input-container');
    if (!container) return { ok: false, reason: 'comment input container not found' };

    function visible(el) {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const candidates = Array.from(container.querySelectorAll('button, [role="button"], div, span'))
      .filter(visible)
      .map(el => {
        const text = (el.innerText || el.textContent || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        return { el, label: `${text} ${aria} ${title}`.trim() };
      })
      .filter(({ label }) => label === '发送' || label.includes('发送'));

    for (const { el } of candidates) {
      const target = el.closest('button,[role="button"]') || el;
      if (!visible(target)) continue;
      target.click();
      return { ok: true, method: 'send_control_click', label: (el.innerText || el.textContent || '').trim() };
    }

    return { ok: false, reason: 'send control not found' };
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
    const modal = document.querySelector('[data-e2e="modal-video-container"], .modal-video-container');
    if (!modal) return false;
    const rect = modal.getBoundingClientRect();
    return rect.width > 100 && rect.height > 100;
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
    const removed = await detectVideoRemoved(page);
    if (removed) {
      return blocking(RESULT_CODES.BLOCKED, `作品已删除/不可见: ${removed}`, { recoverable: true, videoRemoved: true });
    }

    const startedAt = Date.now();
    let modalVisible = false;
    while (Date.now() - startedAt < timeoutMs) {
      modalVisible = await isWorkModalVisible(page).catch(() => false);
      if (modalVisible) break;
      await page.waitForTimeout(300);
    }
    if (!modalVisible) {
      await page.waitForSelector('[data-e2e="modal-video-container"], .modal-video-container', { state: 'visible', timeout: 1000 });
    }

    const removedAfter = await detectVideoRemoved(page);
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
    });
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
        });
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
        });
        if (verifyOff.includes('no-auto-play')) {
          console.error('[work-modal] 连播已关闭');
          break;
        }
      }
    }

    const isCommentAreaVisible = async () => await page.evaluate(() => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (commentArea) {
        const rect = commentArea.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) return true;
      }
      return false;
    });

    async function clickCommentOpenControl() {
      return await page.evaluate(() => {
        const selectors = [
          '[data-e2e="feed-comment-icon"]',
          '[data-e2e="video-comment"]',
          '[data-e2e="comment-icon"]',
          '[aria-label*="评论"]',
          '[title*="评论"]',
          '[class*="comment-icon"]',
          '[class*="comment-btn"]',
        ];
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return { clicked: true, selector };
            }
          }
        }
        return { clicked: false };
      });
    }

    if (!(await isCommentAreaVisible())) {
      console.error('[work-modal] 评论区未展开，点击评论按钮...');
      let opened = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const clicked = await clickCommentOpenControl();
        if (!clicked.clicked) {
          console.error(`[work-modal] 未找到评论按钮 (attempt=${attempt})`);
        } else {
          console.error(`[work-modal] 已点击评论按钮 ${clicked.selector} (attempt=${attempt})`);
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

    await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 10000 });
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

export async function openReplyBoxByIndex(page, commentIndex) {
  console.error(`[work-modal] 按索引打开回复框: commentIndex=${commentIndex}`);

  try {
    const clicked = await page.evaluate((commentIndex) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const commentItems = commentArea.querySelectorAll('[data-e2e="comment-item"]');
      if (commentIndex < 0 || commentIndex >= commentItems.length) return { ok: false, reason: `index ${commentIndex} out of range (0-${commentItems.length - 1})` };

      const commentItem = commentItems[commentIndex];
      const targetInfoWrap = commentItem.querySelector('.comment-item-info-wrap') || commentItem;

      if (commentItem) {
        const statsContainer = commentItem.querySelector('.comment-item-stats-container');
        if (statsContainer) {
          const spans = statsContainer.querySelectorAll('span');
          for (const span of spans) {
            if ((span.innerText || '').trim() === '回复') {
              const rect = span.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                if (rect.y < 0 || rect.y > window.innerHeight) {
                  commentItem.scrollIntoView({ block: 'center', behavior: 'instant' });
                }
                span.click();
                const newRect = span.getBoundingClientRect();
                return { ok: true, x: Math.round(newRect.x + newRect.width / 2), y: Math.round(newRect.y + newRect.height / 2), scope: 'stats-container' };
              }
            }
          }
        }

        const allSpans = commentItem.querySelectorAll('span');
        for (const span of allSpans) {
          if ((span.innerText || '').trim() === '回复') {
            const rect = span.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (rect.y < 0 || rect.y > window.innerHeight) {
                commentItem.scrollIntoView({ block: 'center', behavior: 'instant' });
              }
              span.click();
              const newRect = span.getBoundingClientRect();
              return { ok: true, x: Math.round(newRect.x + newRect.width / 2), y: Math.round(newRect.y + newRect.height / 2), scope: 'comment-item' };
            }
          }
        }
      }

      const searchScopes = [
        targetInfoWrap.parentElement,
        targetInfoWrap.parentElement?.parentElement,
        targetInfoWrap.parentElement?.parentElement?.parentElement,
      ].filter(Boolean);

      for (const scope of searchScopes) {
        const spans = scope.querySelectorAll('span');
        for (const span of spans) {
          if ((span.innerText || '').trim() === '回复') {
            const rect = span.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              span.click();
              return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), scope: 'ancestor' };
            }
          }
        }
      }

      const allReplySpans = commentArea.querySelectorAll('span');
      const itemRect = targetInfoWrap.getBoundingClientRect();
      let closestReply = null;
      let closestDist = Infinity;
      for (const span of allReplySpans) {
        if ((span.innerText || '').trim() !== '回复') continue;
        const rect = span.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const dy = Math.abs(rect.y - itemRect.y);
        if (dy < 120 && dy < closestDist) {
          closestDist = dy;
          closestReply = span;
        }
      }
      if (closestReply) {
        const rect = closestReply.getBoundingClientRect();
        closestReply.click();
        return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), scope: 'proximity' };
      }

      return { ok: false, reason: '回复 span not found in comment item or nearby' };
    }, commentIndex);

    if (!clicked.ok) {
      return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, clicked.reason, { recoverable: true });
    }

    console.error(`[work-modal] 已点击回复 span at (${clicked.x}, ${clicked.y})`);

    await page.waitForTimeout(1000);

    const inputVisible = await page.evaluate(() => {
      const draftEditor = document.querySelector('.comment-input-container [contenteditable="true"]');
      if (draftEditor) {
        const rect = draftEditor.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 10) return true;
      }
      const commentInput = document.querySelector('.comment-input-container');
      if (commentInput) {
        const rect = commentInput.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 30) return true;
      }
      return false;
    });

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

export async function fillReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 填入回复(预演): "${replyText.slice(0, 60)}"`);

  try {
    const filled = await typeIntoReplyDraftEditor(page, replyText);

    if (!filled.ok) {
      const fallback = await page.evaluate((text) => {
        const SEARCH_PHRASES = ['搜索', 'search', '查询'];
        function isSearchInput(input) {
          const ph = (input.getAttribute('placeholder') || '').toLowerCase();
          const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
          return SEARCH_PHRASES.some(s => (ph + ' ' + ariaLabel).includes(s));
        }
        const allInputs = document.querySelectorAll('input[type="text"]');
        for (const input of allInputs) {
          const rect = input.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 20) continue;
          if (isSearchInput(input)) continue;
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.focus();
          return { ok: true, method: 'input_fallback' };
        }
        return { ok: false };
      }, replyText);

      if (!fallback.ok) {
        await captureReplyBoxDebug(page, 'fill-no-input');
        return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '找不到回复输入框', { recoverable: true });
      }
    }

    console.error(`[work-modal] 已填入回复，未点击发送 method=${filled.method || 'fallback'}`);
    return success({ filled: true, sent: false, method: filled.method || 'preview' });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, `填入回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function sendReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 发送回复: "${replyText.slice(0, 60)}"`);

  try {
    const filled = await typeIntoReplyDraftEditor(page, replyText);

    if (!filled.ok) {
      await captureReplyBoxDebug(page, 'send-no-input');
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '找不到回复输入框', { recoverable: true });
    }

    const clicked = await clickReplySendControl(page);
    if (clicked.ok) {
      console.error(`[work-modal] 点击发送控件 method=${clicked.method}`);
      await page.waitForTimeout(2000);
      return success({ sent: true, method: clicked.method, fillMethod: filled.method });
    }

    await page.keyboard.press('Enter');
    console.error(`[work-modal] 未找到发送控件，按 Enter 发送`);
    await page.waitForTimeout(2000);

    return success({ sent: true, method: 'enter_key', fillMethod: filled.method, sendControlReason: clicked.reason });
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
