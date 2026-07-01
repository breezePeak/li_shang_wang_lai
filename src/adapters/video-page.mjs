import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { createCommentSubmitApiWatcher } from './comment-submit-api-listener.mjs';
import path from 'path';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { writeFileSync } from 'fs';

export const DOUYIN_PLAYER_ACTION_SELECTORS = Object.freeze({
  like: '[data-e2e="video-player-digg"]',
  comment: '[data-e2e="feed-comment-icon"]',
  collect: '[data-e2e="video-player-collect"]',
  share: '[data-e2e="video-player-share"]',
  // 右侧 action bar 容器（点赞、评论、收藏、分享都在这下面）
  actionBar: '.hOcDRkbZ.WcVcXqQb',
});

export const DOUYIN_PLAYER_ACTION_STATES = Object.freeze({
  liked: 'video-player-is-digged',
  notLiked: 'video-player-no-digged',
  notCollected: 'video-player-no-collect',
});

async function captureVideoCommentDebug(page, phase, extra = {}) {
  try {
    const dir = path.resolve('data', 'debug', 'comment-box');
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(dir, `${ts}-${phase}`);

    const data = await page.evaluate((payload) => {
      function summarize(el) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().slice(0, 120),
          className: (typeof el.className === 'string' ? el.className : '').slice(0, 200),
          id: el.id || '',
          role: el.getAttribute('role') || '',
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          dataE2e: el.getAttribute('data-e2e') || '',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      function visible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      const commentSelectors = [
        '[data-e2e="feed-comment-icon"]',
        '[data-e2e="video-comment"]',
        '[data-e2e="comment-icon"]',
        '[aria-label*="评论"]',
        '[title*="评论"]',
      ];
      const commentButtons = [];
      for (const selector of commentSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          commentButtons.push({ selector, ...summarize(el) });
        }
      }

      const visibleInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter(visible)
        .slice(0, 12)
        .map(summarize);

      const topTextNodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, a'))
        .filter(visible)
        .map(el => ({ el, text: (el.innerText || el.textContent || '').trim() }))
        .filter(item => item.text === '评论' || item.text === '问AI' || item.text === '搜索')
        .slice(0, 20)
        .map(item => summarize(item.el));

      const activeElement = summarize(document.activeElement);
      return {
        phase: payload.phase,
        extra: payload.extra || {},
        url: location.href,
        title: document.title,
        activeElement,
        commentButtons,
        visibleInputs,
        topTextNodes,
        commentContainerCount: document.querySelectorAll('[class*="comment"], [id*="comment"]').length,
        aiTextVisible: (document.body?.innerText || '').includes('问AI'),
        bodyTextPreview: (document.body?.innerText || '').slice(0, 2000),
      };
    }, { phase, extra });

    writeJSON(`${base}.json`, data);
    try {
      const html = await page.content();
      writeFileSync(`${base}.html`, html, 'utf8');
    } catch {}
    try {
      await page.screenshot({ path: `${base}.png`, fullPage: false });
    } catch {}
    console.error(`[video-page] 评论区诊断已保存: ${base}.json / ${base}.html`);
    return `${base}.json`;
  } catch (err) {
    console.error(`[video-page] 评论区诊断保存失败: ${err.message}`);
    return null;
  }
}

export async function clickVideoCommentButtonByDom(page) {
  return await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function clickAllWays(target) {
      target.click?.();
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const actionItems = Array.from(document.querySelectorAll('.t5VMknM2 .MinpposV > .AOWKbsTg'))
      .filter(visible);
    if (actionItems.length >= 2) {
      const target = actionItems[1];
      const rect = target.getBoundingClientRect();
      clickAllWays(target);
      return {
        ok: true,
        method: 'douyin_actionbar_comment_index',
        text: (target.innerText || target.textContent || '').trim().slice(0, 40),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
      };
    }

    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span, a'))
      .filter(visible)
      .map(el => ({ el, text: (el.innerText || el.textContent || '').trim(), rect: el.getBoundingClientRect() }))
      .filter(item => item.rect.left >= window.innerWidth * 0.62)
      .filter(item => item.rect.top >= 80 && item.rect.bottom <= window.innerHeight - 60)
      .filter(item => item.text === '评论' || /^(评论)?\d+$/.test(item.text.replace(/\s+/g, '')));

    nodes.sort((a, b) => {
      const aScore = (a.text.includes('评论') ? 10 : 0) + a.rect.width * a.rect.height;
      const bScore = (b.text.includes('评论') ? 10 : 0) + b.rect.width * b.rect.height;
      return bScore - aScore;
    });

    const target = nodes[0]?.el || null;
    if (!target) return { ok: false, reason: 'comment_button_not_found_by_dom' };

    const rect = target.getBoundingClientRect();
    clickAllWays(target);
    return {
      ok: true,
      method: 'right_sidebar_comment_fallback',
      text: (target.innerText || target.textContent || '').trim().slice(0, 40),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }).catch(err => ({ ok: false, reason: `comment_button_dom_exception:${err.message}` }));
}

export async function clickVideoCommentSendControl(page) {
  return await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function clickAllWays(target) {
      target.click?.();
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    function textOf(el) {
      return (el?.innerText || el?.textContent || '').trim();
    }

    function isRedLike(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized) return false;
      const match = normalized.match(/rgb[a]?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (!match) return false;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      return r >= 220 && g <= 120 && b <= 140;
    }

    function hasBlockedSemantics(el) {
      const raw = `${textOf(el)} ${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('title') || ''} ${el?.getAttribute?.('class') || ''}`;
      return /上传|投稿|选择文件|图片|相册|附件|表情|@/.test(raw);
    }

    const editor = document.activeElement?.matches?.('[contenteditable="true"], textarea, input[type="text"]')
      ? document.activeElement
      : document.querySelector('[contenteditable="true"][data-placeholder*="评"], [contenteditable="true"][placeholder*="评"], textarea[placeholder*="评"], [class*="comment"] [contenteditable="true"], [class*="comment"] textarea');
    const composer = editor?.closest?.('.comment-input-container, [class*="comment-input-container"], [class*="commentInput"], [class*="input-container"]')
      || editor?.parentElement?.parentElement
      || null;
    if (!visible(composer)) return { ok: false, reason: 'composer_not_found' };

    const composerRect = composer.getBoundingClientRect();
    const candidates = Array.from(composer.querySelectorAll('button, [role="button"], div, span, svg, img'))
      .filter(visible)
      .filter(el => !hasBlockedSemantics(el))
      .map(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = textOf(el);
        const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector?.('svg');
        const path = svg?.querySelector?.('path');
        let score = 0;
        if (text === '发送' || text === '发布' || text.includes('发送') || text.includes('发布')) score += 50;
        if (rect.left >= composerRect.left + composerRect.width * 0.65) score += 30;
        if (rect.width <= 56 && rect.height <= 56) score += 10;
        if (isRedLike(style.color) || isRedLike(style.backgroundColor)) score += 25;
        if (isRedLike(svg?.getAttribute?.('fill')) || isRedLike(path?.getAttribute?.('fill'))) score += 25;
        if (text === '' && (el.tagName.toLowerCase() === 'svg' || el.querySelector?.('svg'))) score += 10;
        return { el, rect, text, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const target = candidates[0]?.el || null;
    if (!target) return { ok: false, reason: 'video_send_control_not_found' };
    const rect = target.getBoundingClientRect();
    clickAllWays(target);
    return {
      ok: true,
      method: 'video_send_control_click',
      text: textOf(target).slice(0, 20),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }).catch(err => ({ ok: false, reason: `video_send_dom_exception:${err.message}` }));
}

/**
 * Pure function: determine like state from a single candidate's diagnostic info.
 * Returns { liked: true|false|null, confidence, signal } or null if can't determine.
 * Used by checkLikeState's page.evaluate and also testable standalone.
 */
export function assessCandidateLikeState(diag) {
  if (!diag) return null;

  // class-based detection
  if (/active|liked|selected|checked|hasLiked/i.test(diag.className || '')) {
    return { liked: true, confidence: 'confirmed', signal: 'liked-class:' + diag.tag };
  }

  // color-based detection
  function _isDouyinRed(val) {
    if (!val) return false;
    const normalized = String(val).trim().toLowerCase();
    if (normalized === 'red') return true;
    const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
      let raw = hex[1];
      if (raw.length === 3) raw = raw.split('').map(ch => ch + ch).join('');
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      return r >= 230 && g <= 90 && b <= 130;
    }
    const m = normalized.match(/rgb[va]?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return false;
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    return r >= 230 && g <= 90 && b <= 130;
  }
  if (_isDouyinRed(diag.color)) return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag };
  if (_isDouyinRed(diag.backgroundColor)) return { liked: true, confidence: 'confirmed', signal: 'red-bg:' + diag.tag };

  // SVG-based detection
  if ([diag.svgFill, diag.pathFill, diag.svgStroke, diag.pathStroke].some(f => _isDouyinRed(f))) {
    return { liked: true, confidence: 'confirmed', signal: 'red-svg:' + diag.tag };
  }

  // neutral unlike button
  const hasLikeText = diag.text && (diag.text.startsWith('点赞') || diag.text.startsWith('赞'));
  const hasLikeAria = (diag.ariaLabel || '').includes('赞');
  if (hasLikeText || hasLikeAria) {
    return { liked: false, confidence: 'confirmed', signal: 'neutral-like-btn' };
  }

  return null;
}

export function assessDouyinPlayerDiggState(diag) {
  if (!diag) return null;
  const state = String(diag.dataE2eState || '').toLowerCase();
  if (state.includes('no-digg') || state.includes('no-digged') || state.includes('not-digged')) {
    return { liked: false, confidence: 'confirmed', signal: 'douyin-player-digg-state' };
  }
  if (state.includes('is-digged') || state.includes('digged') || state.includes('liked')) {
    return { liked: true, confidence: 'confirmed', signal: 'douyin-player-digg-state' };
  }
  if (diag.hasRedSvg) {
    return { liked: true, confidence: 'confirmed', signal: 'douyin-player-digg-red-svg' };
  }
  if (diag.found) {
    return { liked: false, confidence: 'confirmed', signal: 'douyin-player-digg-neutral' };
  }
  return null;
}

export async function navigateToVideo(page, videoUrl, options = {}) {
  const { timeoutMs = 15000 } = options;

  try {
    console.error(`[video-page] 打开视频: ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(3000);

    const pageState = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const url = window.location.href;
      return {
        isVideoPage: url.includes('/video/'),
        isNotePage: url.includes('/note/'),
        isModalPage: /[?&]modal_id=/.test(url),
        hasVideoElement: !!document.querySelector('video'),
        hasContent: text.length > 100,
      };
    });

    if (!pageState.isVideoPage && !pageState.isNotePage && !pageState.isModalPage) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '未能导航到视频页面',
        { data: { url: page.url() } }
      );
    }

    if (pageState.isNotePage) {
      console.error(`[video-page] 页面重定向到 note: ${page.url()}`);
    } else if (pageState.isModalPage) {
      console.error(`[video-page] 页面打开为 modal_id 作品页: ${page.url()}`);
    }

    return success({
      url: page.url(),
      isVideoPage: pageState.isVideoPage,
      isNotePage: pageState.isNotePage,
      isModalPage: pageState.isModalPage,
      hasVideoElement: pageState.hasVideoElement,
    });
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
      document.querySelectorAll('[data-temp-like-btn]').forEach(el => el.removeAttribute('data-temp-like-btn'));

      // ---- helpers ----
      function isDouyinRedColor(val) {
        if (!val) return false;
        const normalized = String(val).trim().toLowerCase();
        if (normalized === 'red') return true;
        const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
        if (hex) {
          let raw = hex[1];
          if (raw.length === 3) raw = raw.split('').map(ch => ch + ch).join('');
          const r = parseInt(raw.slice(0, 2), 16);
          const g = parseInt(raw.slice(2, 4), 16);
          const b = parseInt(raw.slice(4, 6), 16);
          return r >= 230 && g <= 90 && b <= 130;
        }
        const m = normalized.match(/rgb[va]?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (!m) return false;
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        return r >= 230 && g <= 90 && b <= 130;
      }

      function isVisibleEl(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      }

      function intersectsViewport(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      }

      function pickVisibleActionBar(selector, requiredSelector = '') {
        const viewportCenterY = window.innerHeight / 2;
        const candidates = Array.from(document.querySelectorAll(selector))
          .map(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            const intersects = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
            const centerY = rect.top + rect.height / 2;
            return {
              el,
              visible,
              intersects,
              hasRequired: requiredSelector ? Boolean(el.querySelector(requiredSelector)) : true,
              distanceToViewportCenter: Math.abs(centerY - viewportCenterY),
              top: rect.top,
            };
          })
          .filter(item => item.visible && item.hasRequired);

        candidates.sort((a, b) => {
          if (a.intersects !== b.intersects) return a.intersects ? -1 : 1;
          return a.distanceToViewportCenter - b.distanceToViewportCenter || a.top - b.top;
        });
        return candidates[0]?.el || null;
      }

      function pickVisibleElement(selector) {
        const viewportCenterY = window.innerHeight / 2;
        const candidates = Array.from(document.querySelectorAll(selector))
          .filter(el => isVisibleEl(el) && intersectsViewport(el))
          .map(el => {
            const rect = el.getBoundingClientRect();
            return { el, distanceToViewportCenter: Math.abs(rect.top + rect.height / 2 - viewportCenterY), top: rect.top };
          });
        candidates.sort((a, b) => a.distanceToViewportCenter - b.distanceToViewportCenter || a.top - b.top);
        return candidates[0]?.el || null;
      }

      function hasLikedClass(cls) {
        return /active|liked|selected|checked|hasLiked|\bf7caOKG9\b/i.test(cls);
      }

      function collectClassNames(root) {
        const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
        return nodes
          .map(node => typeof node.className === 'string' ? node.className : '')
          .filter(Boolean)
          .join(' ');
      }

      function hasPressedOrCheckedState(root) {
        const nodes = [root, ...Array.from(root.querySelectorAll('[aria-pressed], [aria-selected], [aria-checked], [data-state], [data-status]'))];
        return nodes.some(node => {
          const values = [
            node.getAttribute('aria-pressed'),
            node.getAttribute('aria-selected'),
            node.getAttribute('aria-checked'),
            node.getAttribute('data-state'),
            node.getAttribute('data-status'),
          ].filter(Boolean).map(v => String(v).toLowerCase());
          return values.some(v => v === 'true' || v === 'checked' || v === 'selected' || v === 'active' || v === 'liked');
        });
      }

      function hasRedSvgSignal(root) {
        const nodes = Array.from(root.querySelectorAll('svg, path, use'));
        for (const node of nodes) {
          const style = window.getComputedStyle(node);
          const values = [
            node.getAttribute('fill'),
            node.getAttribute('stroke'),
            node.getAttribute('color'),
            style.fill,
            style.stroke,
            style.color,
          ];
          if (values.some(isDouyinRedColor)) return true;
        }
        return false;
      }

      function assessPlayerDiggState(diag) {
        const state = String(diag.dataE2eState || '').toLowerCase();
        if (state.includes('no-digg') || state.includes('no-digged') || state.includes('not-digged')) {
          return { liked: false, confidence: 'confirmed', signal: 'douyin-player-digg-state' };
        }
        if (state.includes('is-digged') || state.includes('digged') || state.includes('liked')) {
          return { liked: true, confidence: 'confirmed', signal: 'douyin-player-digg-state' };
        }
        if (diag.hasRedSvg) {
          return { liked: true, confidence: 'confirmed', signal: 'douyin-player-digg-red-svg' };
        }
        if (diag.found) {
          return { liked: false, confidence: 'confirmed', signal: 'douyin-player-digg-neutral' };
        }
        return null;
      }

      function hasLikedSvg(el) {
        // check SVGs inside this element or itself
        const svgs = (el.tagName === 'svg' || el.tagName === 'path') ? [el] : el.querySelectorAll('svg, path');
        for (const svg of svgs) {
          if (!isVisibleEl(svg)) continue;
          const fill = svg.getAttribute('fill') || '';
          const stroke = svg.getAttribute('stroke') || '';
          if (isDouyinRedColor(fill) || isDouyinRedColor(stroke)) return true;
          const style = window.getComputedStyle(svg);
          if (isDouyinRedColor(style.fill) || isDouyinRedColor(style.stroke) || isDouyinRedColor(style.color)) return true;
        }
        return false;
      }

      function elementInfo(el, maxTextLen) {
        const tag = (el.tagName || '').toLowerCase();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const svgEls = el.querySelectorAll('svg');
        let svgFill = '', pathFill = '', svgStroke = '', pathStroke = '';
        for (const svg of svgEls) {
          const f = svg.getAttribute('fill') || '';
          if (f) svgFill = f;
          const s = svg.getAttribute('stroke') || '';
          if (s) svgStroke = s;
          const paths = svg.querySelectorAll('path');
          for (const p of paths) {
            const pf = p.getAttribute('fill') || '';
            if (pf) pathFill = pf;
            const ps = p.getAttribute('stroke') || '';
            if (ps) pathStroke = ps;
          }
        }
        return {
          tag,
          text: ((el.innerText || '') + '').slice(0, maxTextLen || 20).trim(),
          ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 40),
          title: (el.getAttribute('title') || '').slice(0, 40),
          className: ((typeof el.className === 'string' ? el.className : '') + '').slice(0, 60),
          dataE2e: (el.getAttribute('data-e2e') || '').slice(0, 30),
          href: (el.getAttribute('href') || el.closest('a')?.getAttribute?.('href') || '').slice(0, 100),
          role: el.getAttribute('role') || '',
          cursor: style.cursor || '',
          color: style.color || '',
          backgroundColor: style.backgroundColor || '',
          svgFill,
          pathFill,
          svgStroke,
          pathStroke,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      }

      function collectPageDiagnostics() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const bodyText = (document.body?.innerText || '').slice(0, 2000);

        // right side (x > 55% of viewport)
        const rightSide = [];
        const interactive = [];
        const svgParents = [];
        const seenEI = new Set();

        const allEls = document.querySelectorAll('button, [role="button"], a, svg, [tabindex], div, span');

        for (const el of allEls) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;

          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const style = window.getComputedStyle(el);
          const hasPointer = style.cursor === 'pointer';
          const isInteractive = tag === 'button' || role === 'button' || tag === 'a' || tag === 'svg' || el.hasAttribute('tabindex') || hasPointer;

          if (!isInteractive) continue;

          const info = elementInfo(el, 30);
          if (interactive.length < 50) {
            if (!seenEI.has(el)) { seenEI.add(el); interactive.push(info); }
          }
          if (rightSide.length < 50 && rect.x > vw * 0.55) {
            rightSide.push(info);
          }
        }

        // visible SVG parents
        const allSvgs = document.querySelectorAll('svg');
        for (const svg of allSvgs) {
          const rect = svg.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          let parent = svg.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            const tag = parent.tagName.toLowerCase();
            if (tag === 'body' || tag === 'html') break;
            const pr = parent.getBoundingClientRect();
            if (pr.width < 10) { parent = parent.parentElement; continue; }
            svgParents.push({
              level: i + 1,
              ...elementInfo(parent, 60),
              svgTag: svg.tagName.toLowerCase(),
              hasChildren: (parent.querySelectorAll?.('*')?.length || 0),
            });
            parent = parent.parentElement;
          }
          if (svgParents.length >= 50) break;
        }

        const buttons = document.querySelectorAll('button');
        const svgs = document.querySelectorAll('svg');
        const roleBtns = document.querySelectorAll('[role="button"]');

        return {
          liked: null,
          confidence: 'none',
          signal: 'no-candidates',
          candidates: [],
          candidateCount: 0,
          pageDiagnostics: {
            url: window.location.href,
            title: (document.title || '').slice(0, 200),
            bodyTextLength: bodyText.length,
            bodyTextSample: bodyText.slice(0, 500),
            viewport: { w: vw, h: vh },
            scrollY: Math.round(window.scrollY),
            interactiveCount: interactive.length,
            buttonCount: buttons.length,
            svgCount: svgs.length,
            roleButtonCount: roleBtns.length,
            rightSideElements: rightSide,
            visibleInteractiveElements: interactive,
            visibleSvgParents: svgParents.slice(0, 50),
          },
        };
      }

      // ---- Phase -1: current Douyin PC player action row ----
      // Evidence DOM:
      //   <div data-e2e="video-player-digg" data-e2e-state="video-player-is-digged">...</div>
      // The same action row contains:
      //   data-e2e="feed-comment-icon"
      //   data-e2e="video-player-collect"
      //   data-e2e="video-player-share"
      const playerActionBar = pickVisibleActionBar('.hOcDRkbZ.WcVcXqQb', '[data-e2e="video-player-digg"]');
      const playerDigg = Array.from(playerActionBar?.querySelectorAll('[data-e2e="video-player-digg"]') || [])
        .find(el => isVisibleEl(el) && intersectsViewport(el))
        || pickVisibleElement('[data-e2e="video-player-digg"]');
      if (playerDigg) {
        const rect = playerDigg.getBoundingClientRect();
        const style = window.getComputedStyle(playerDigg);
        const diag = {
          found: true,
          tag: playerDigg.tagName.toLowerCase(),
          text: ((playerDigg.innerText || '').trim()).slice(0, 40),
          className: (typeof playerDigg.className === 'string' ? playerDigg.className : '').slice(0, 160),
          dataE2e: playerDigg.getAttribute('data-e2e') || '',
          dataE2eState: playerDigg.getAttribute('data-e2e-state') || '',
          color: style.color || '',
          backgroundColor: style.backgroundColor || '',
          hasRedSvg: hasRedSvgSignal(playerDigg),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
        const assessed = assessPlayerDiggState(diag);
        if (assessed) {
          playerDigg.setAttribute('data-temp-like-btn', 'true');
          return {
            ...assessed,
            diag,
            actionBarFound: true,
            actionItemCount: (playerActionBar || document).querySelectorAll('[data-e2e="video-player-digg"], [data-e2e="feed-comment-icon"], [data-e2e="video-player-collect"], [data-e2e="video-player-share"]').length,
            actionItemsDiag: Array.from((playerActionBar || document).querySelectorAll('[data-e2e="video-player-digg"], [data-e2e="feed-comment-icon"], [data-e2e="video-player-collect"], [data-e2e="video-player-share"]')).map((el, i) => ({
              index: i,
              dataE2e: el.getAttribute('data-e2e') || '',
              dataE2eState: el.getAttribute('data-e2e-state') || '',
              className: (typeof el.className === 'string' ? el.className : '').slice(0, 160),
              text: ((el.innerText || '').trim()).slice(0, 40),
            })),
          };
        }
      }

      // ---- Phase 0: Douyin PC action bar like button detection ----
      // Real DOM: .t5VMknM2 > .MinpposV > .AOWKbsTg[0] is the like button.
      // No aria/title/data-e2e=like/digg. Count in span.Z4B2hGGG.
      // Liked state: class f7caOKG9 appears on the like container.
      const actionBarCheck = (() => {
        const container = pickVisibleActionBar('.t5VMknM2 .MinpposV');
        if (!container) return null;
        const items = Array.from(container.querySelectorAll(':scope > .AOWKbsTg'));
        if (items.length === 0) return null;
        const likeItem = items[0];

        const diag = (() => {
          const tag = likeItem.tagName.toLowerCase();
          const rect = likeItem.getBoundingClientRect();
          const cls = collectClassNames(likeItem);
          const countEl = likeItem.querySelector('.Z4B2hGGG');
          const countText = countEl ? (countEl.innerText || '').trim() : '';
          const style = window.getComputedStyle(likeItem);
          let svgFill = '', pathFill = '', svgStroke = '', pathStroke = '';
          const svgs = likeItem.querySelectorAll('svg');
          for (const svg of svgs) {
            if (!isVisibleEl(svg)) continue;
            const f = svg.getAttribute('fill') || '';
            if (f) svgFill = f;
            const s = svg.getAttribute('stroke') || '';
            if (s) svgStroke = s;
            const cs = window.getComputedStyle(svg);
            if (isDouyinRedColor(cs.fill)) svgFill = cs.fill;
            if (isDouyinRedColor(cs.stroke)) svgStroke = cs.stroke;
            if (isDouyinRedColor(cs.color) && f === 'currentColor') svgFill = cs.color;
            const paths = svg.querySelectorAll('path');
            for (const p of paths) {
              const pf = p.getAttribute('fill') || '';
              if (pf) pathFill = pf;
              const ps = p.getAttribute('stroke') || '';
              if (ps) pathStroke = ps;
              const pcs = window.getComputedStyle(p);
              if (isDouyinRedColor(pcs.fill)) pathFill = pcs.fill;
              if (isDouyinRedColor(pcs.stroke)) pathStroke = pcs.stroke;
              if (isDouyinRedColor(pcs.color) && pf === 'currentColor') pathFill = pcs.color;
              const pstroke = p.getAttribute('stroke') || '';
              if (isDouyinRedColor(pstroke)) pathStroke = pstroke;
            }
          }
          return {
            tag,
            className: (typeof likeItem.className === 'string' ? likeItem.className : '').slice(0, 120),
            allClassName: cls.slice(0, 500),
            text: ((likeItem.innerText || '').trim()).slice(0, 20),
            countText,
            color: style.color || '',
            backgroundColor: style.backgroundColor || '',
            svgFill,
            pathFill,
            svgStroke,
            pathStroke,
            pressedOrChecked: hasPressedOrCheckedState(likeItem),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          };
        })();

        // collect sibling diagnostics
        const actionItemsDiag = items.slice(0, 4).map((el, i) => {
          const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 60);
          const countEl = el.querySelector('.Z4B2hGGG');
          const countText = countEl ? (countEl.innerText || '').trim() : '';
          const dataE2e = el.getAttribute('data-e2e') || el.querySelector('[data-e2e]')?.getAttribute?.('data-e2e') || '';
          let svgFill = '', pathFill = '', svgStroke = '', pathStroke = '';
          const svgs = el.querySelectorAll('svg');
          for (const svg of svgs) {
            const f = svg.getAttribute('fill') || ''; if (f) svgFill = f;
            const s = svg.getAttribute('stroke') || ''; if (s) svgStroke = s;
            const paths = svg.querySelectorAll('path');
            for (const p of paths) {
              const pf = p.getAttribute('fill') || ''; if (pf) pathFill = pf;
              const ps = p.getAttribute('stroke') || ''; if (ps) pathStroke = ps;
            }
          }
          return {
            index: i,
            className: cls,
            text: ((el.innerText || '').trim()).slice(0, 20),
            countText,
            dataE2e,
            svgFill,
            pathFill,
            svgStroke,
            pathStroke,
          };
        });

        return { likeItem, diag, actionItemCount: items.length, actionItemsDiag };
      })();

      if (actionBarCheck) {
        const { likeItem, diag, actionItemCount, actionItemsDiag } = actionBarCheck;
        likeItem.setAttribute('data-temp-like-btn', 'true');
        // check liked signals — f7caOKG9 class OR douyin red via isDouyinRedColor
        const cls = `${diag.className || ''} ${diag.allClassName || ''}`;
        const hasLikedClassSignal = hasLikedClass(cls);
        const svgRed = diag.svgFill && isDouyinRedColor(diag.svgFill);
        const pathRed = diag.pathFill && isDouyinRedColor(diag.pathFill);
        const svgStrokeRed = diag.svgStroke && isDouyinRedColor(diag.svgStroke);
        const pathStrokeRed = diag.pathStroke && isDouyinRedColor(diag.pathStroke);
        const colorRed = isDouyinRedColor(diag.color);
        const bgRed = isDouyinRedColor(diag.backgroundColor);
        const descendantSvgRed = hasRedSvgSignal(likeItem);

        if (hasLikedClassSignal || diag.pressedOrChecked || svgRed || pathRed || svgStrokeRed || pathStrokeRed || colorRed || bgRed || descendantSvgRed) {
          return {
            liked: true,
            confidence: 'confirmed',
            signal: 'douyin-actionbar-liked',
            diag,
            actionBarFound: true,
            actionItemCount,
            actionItemsDiag,
          };
        }

        // confirmed structure: like button exists, not red → neutral
        return {
          liked: false,
          confidence: 'confirmed',
          signal: 'douyin-actionbar-neutral',
          diag,
          countText: diag.countText,
          actionBarFound: true,
          actionItemCount,
          actionItemsDiag,
        };
      }

      // ---- Phase 1: targeted candidate search ----
      const candidates = [];
      const seen = new Set();
      let processedCount = 0;
      const MAX_PROCESS = 2000;

      const QUERIES = [
        // high-signal attributes
        ...Array.from(document.querySelectorAll('[aria-label*="赞"]')),
        ...Array.from(document.querySelectorAll('[title*="赞"]')),
        ...Array.from(document.querySelectorAll('[data-e2e*="like"]')),
        ...Array.from(document.querySelectorAll('[data-e2e*="digg"]')),
        // class-based
        ...Array.from(document.querySelectorAll('[class*="like"]')),
        ...Array.from(document.querySelectorAll('[class*="digg"]')),
        // interactive elements (limited — only check visible ones)
        ...Array.from(document.querySelectorAll('button, [role="button"]')),
      ];

      // Also check spans/divs with like-related text (use TreeWalker for efficiency)
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: function(node) {
            if (node.nodeType !== 1) return NodeFilter.FILTER_SKIP;
            const tag = node.tagName;
            if (tag !== 'SPAN' && tag !== 'DIV' && tag !== 'BUTTON') return NodeFilter.FILTER_SKIP;
            const rect = node.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      while (walker.nextNode() && processedCount < MAX_PROCESS) {
        const el = walker.currentNode;
        const text = (el.innerText || '').trim();
        if (text.startsWith('点赞') || text.startsWith('赞')) {
          if (!seen.has(el)) {
            QUERIES.push(el);
          }
        }
        processedCount++;
      }

      for (const el of QUERIES) {
        if (seen.has(el)) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;

        const text = (el.innerText || '').trim();
        const tag = el.tagName.toLowerCase();
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const dataE2e = el.getAttribute('data-e2e') || '';
        const cls = (typeof el.className === 'string') ? el.className : '';

        // check if this is like-related
        const isLikeRelated =
          text.startsWith('点赞') || text.startsWith('赞') ||
          ariaLabel.includes('赞') ||
          title.includes('赞') ||
          /like|digg/i.test(dataE2e) ||
          /like|digg/i.test(cls);

        if (!isLikeRelated) continue;

        const style = window.getComputedStyle(el);
        const diag = {
          tag, text: text.slice(0, 20),
          ariaLabel: ariaLabel.slice(0, 30),
          title: title.slice(0, 30),
          className: cls.slice(0, 60),
          dataE2e: dataE2e.slice(0, 30),
          color: style.color || '',
          backgroundColor: style.backgroundColor || '',
          svgFill: '',
          pathFill: '',
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          visible: rect.width > 10 && rect.height > 10,
        };

        // collect svg/path fill info
        const svgs = el.querySelectorAll('svg');
        for (const svg of svgs) {
          const f = svg.getAttribute('fill') || '';
          if (f) diag.svgFill = f;
          const paths = svg.querySelectorAll('path');
          for (const p of paths) {
            const pf = p.getAttribute('fill') || '';
            if (pf) diag.pathFill = pf;
          }
        }

        candidates.push({ el, diag, rect, fullText: text });
        if (candidates.length >= 20) break; // safety limit
      }

      // ---- Phase 2: heuristic detection via right-side SVG containers ----
      // Douyin's like button has no aria/title/data-e2e with "like"/"赞".
      // It's a clickable container in the right sidebar that contains an SVG.
      // Detection: check SVG fill color (red=liked, white/gray=neutral).
      if (candidates.length === 0) {
        // Find right-side interactive containers that contain SVGs
        const panel = [];
        const vw = window.innerWidth;
        const all = document.querySelectorAll('[tabindex], [cursor="pointer"]');
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) continue;
          if (rect.x < vw * 0.55) continue;
          const svgs = el.querySelectorAll('svg');
          if (svgs.length === 0) continue;
          const anyRed = Array.from(svgs).some(svg => {
            if (!isVisibleEl(svg)) return false;
            const fill = svg.getAttribute('fill') || '';
            const style = window.getComputedStyle(svg);
            return fill === '#FF0040' || fill === '#FE2C55' || fill === 'red' ||
              isDouyinRedColor(style.fill);
          });
          const text = (el.innerText || '').trim();
          panel.push({ el, rect, anyRed, text: text.slice(0, 10) });
          if (panel.length >= 6) break;
        }

        if (panel.length > 0) {
          // First non-red SVG container is likely the neutral like button
          const neutral = panel.find(p => !p.anyRed);
          const redItem = panel.find(p => p.anyRed);

          if (redItem) {
            redItem.el.setAttribute('data-temp-like-btn', 'true');
            return { liked: true, confidence: 'confirmed', signal: 'rightside-svg-red', diag: { tag: redItem.el.tagName.toLowerCase(), text: redItem.text } };
          }
          if (neutral) {
            neutral.el.setAttribute('data-temp-like-btn', 'true');
            return { liked: false, confidence: 'confirmed', signal: 'rightside-svg-neutral', diag: { tag: neutral.el.tagName.toLowerCase(), text: neutral.text } };
          }
        }
      }

      // ---- Phase 3: no heuristic match → collect page diagnostics ----
      if (candidates.length === 0) {
        return collectPageDiagnostics();
      }

      for (const c of candidates) {
        const { el, diag, fullText } = c;

        // 2a: class-based liked detection
        if (hasLikedClass(diag.className)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'liked-class:' + diag.tag, diag };
        }

        // 2b: color-based liked detection
        if (isDouyinRedColor(diag.color)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag, diag };
        }
        if (isDouyinRedColor(diag.backgroundColor)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-bg:' + diag.tag, diag };
        }

        // 2c: SVG fill-based liked detection
        if (diag.svgFill && isDouyinRedColor(diag.svgFill)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-svg-fill:' + diag.tag, diag };
        }
        if (diag.pathFill && isDouyinRedColor(diag.pathFill)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-path-fill:' + diag.tag, diag };
        }
        if (diag.svgStroke && isDouyinRedColor(diag.svgStroke)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-svg-stroke:' + diag.tag, diag };
        }
        if (diag.pathStroke && isDouyinRedColor(diag.pathStroke)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-path-stroke:' + diag.tag, diag };
        }

        // 2d: explicit like button with count → neutral (already checked for red)
        const t = fullText || diag.text || '';
        if (/[赞]\s*\d/.test(t)) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: false, confidence: 'confirmed', signal: 'like-count-neutral', diag };
        }
      }

      // ---- Phase 3: find a clear unlike button ----
      for (const c of candidates) {
        const { el, diag } = c;
        const hasText = diag.text && (diag.text.startsWith('点赞') || diag.text.startsWith('赞'));
        const hasAria = (diag.ariaLabel || '').includes('赞');
        if (hasText || hasAria) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: false, confidence: 'confirmed', signal: 'neutral-like-btn', diag };
        }
      }

      // ---- Phase 4: unclear → return diagnostics ----
      const top10 = candidates.slice(0, 10).map(c => c.diag);
      return {
        liked: null,
        confidence: 'unknown',
        signal: 'ambiguous',
        candidateCount: candidates.length,
        candidates: top10,
      };
    });

    if (state.liked === null) {
      // Log diagnostics to stderr for human debugging
      if (state.candidates && state.candidates.length > 0) {
        console.error(`[video-page] 点赞状态无法确认，候选元素诊断 (前${state.candidates.length}个):`);
        for (const c of state.candidates) {
          const colorInfo = c.color ? ` color=${c.color}` : '';
          const classInfo = c.className ? ` class=${c.className.slice(0, 40)}` : '';
          console.error(`  <${c.tag}> text="${c.text}" aria="${c.ariaLabel}" svgFill="${c.svgFill}" pathFill="${c.pathFill}"${colorInfo}${classInfo}`);
        }
      } else if (state.pageDiagnostics) {
        const pd = state.pageDiagnostics;
        console.error(`[video-page] 点赞候选=0，页面诊断:`);
        console.error(`  url=${pd.url} title="${pd.title.slice(0, 60)}"`);
        console.error(`  bodyText=${pd.bodyTextLength} viewport=${pd.viewport.w}x${pd.viewport.h}`);
        console.error(`  buttons=${pd.buttonCount} svgs=${pd.svgCount} roleBtns=${pd.roleButtonCount}`);
        console.error(`  rightSide=${pd.rightSideElements.length} interactive=${pd.visibleInteractiveElements.length} svgParents=${pd.visibleSvgParents.length}`);
        if (pd.bodyTextSample) {
          console.error(`  bodySample: ${pd.bodyTextSample.slice(0, 200)}`);
        }
      } else {
        console.error(`[video-page] 点赞状态无法确认: ${state.signal === 'no-candidates' ? '页面上未找到任何点赞相关元素' : `找到 ${state.candidateCount} 个候选但无法判定`}`);
      }
      return blocking(
        RESULT_CODES.LIKE_STATE_UNKNOWN,
        state.signal === 'no-candidates' ? '页面上未找到任何点赞相关元素' : '无法明确判断点赞状态',
        { data: { candidateCount: state.candidateCount || 0, candidates: state.candidates || [], confidence: state.confidence, pageDiagnostics: state.pageDiagnostics || null } }
      );
    }

    console.error(`[video-page] 点赞状态: ${state.liked ? '已赞' : '未赞'} (${state.signal})`);
    return success({
      alreadyLiked: state.liked,
      text: state.diag?.text || '',
      countText: state.countText || state.diag?.countText || '',
      confidence: state.confidence,
      signal: state.signal,
      diag: state.diag || null,
      actionBarFound: state.actionBarFound || false,
      actionItemCount: state.actionItemCount || 0,
      actionItemsDiag: state.actionItemsDiag || null,
    });
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

export async function findDouyinActionBarLikeItem(page) {
  try {
    const info = await page.evaluate(() => {
      function isDouyinRedColor(val) {
        if (!val) return false;
        const m = val.match(/rgb[va]?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (!m) return false;
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        return r >= 230 && g <= 90 && b <= 130;
      }

      function isVisibleEl(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      }

      const container = document.querySelector('.t5VMknM2 .MinpposV');
      if (!container) return null;
      const items = Array.from(container.querySelectorAll(':scope > .AOWKbsTg'));
      if (items.length === 0) return null;
      const likeItem = items[0];

      const cls = (typeof likeItem.className === 'string' ? likeItem.className : '');
      const isLikedClass = /\bf7caOKG9\b/.test(cls);

      let pathFill = '';
      const svgs = likeItem.querySelectorAll('svg');
      for (const svg of svgs) {
        if (!isVisibleEl(svg)) continue;
        const paths = svg.querySelectorAll('path');
        for (const p of paths) {
          if (!isVisibleEl(p)) continue;
          const pf = p.getAttribute('fill') || '';
          if (pf && isDouyinRedColor(pf)) pathFill = pf;
          const pcs = window.getComputedStyle(p);
          if (isDouyinRedColor(pcs.fill)) pathFill = pcs.fill;
        }
      }

      return {
        className: cls.slice(0, 80),
        isLiked: isLikedClass || isDouyinRedColor(pathFill),
        pathFill: pathFill || '',
        found: true,
      };
    });

    if (!info) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '找不到点赞按钮 (action bar not found)',
        { data: {} }
      );
    }

    return success(info);
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `查找点赞按钮异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function clickLike(page, { execute = false } = {}) {
  try {
    if (!execute) {
      return blocking(
        RESULT_CODES.ACTION_NOT_READY,
        '非 execute 模式，拒绝真实点赞操作',
        { recoverable: false }
      );
    }

    const likeState = await checkLikeState(page);
    if (!likeState.ok) {
      return blocking(
        RESULT_CODES.BLOCKED,
        `找不到点赞按钮或状态未知: ${likeState.message}`,
        { data: {} }
      );
    }

    if (likeState.data?.alreadyLiked) {
      return blocking(
        RESULT_CODES.ALREADY_LIKED,
        '已经点过赞，跳过',
        { data: {} }
      );
    }

    const clickExactLikeButton = async () => {
      const exactLikeSelectors = [
        '[data-temp-like-btn="true"]',
        '[data-e2e="video-player-digg"]',
      ];

      for (const selector of exactLikeSelectors) {
        const matches = page.locator(selector);
        const count = await matches.count();
        console.error(`[like-click] 尝试选择器: ${selector} count=${count}`);
        if (count === 0) continue;

        let targetBtn = null;
        for (let i = 0; i < count; i++) {
          const candidate = matches.nth(i);
          const vis = await candidate.isVisible().catch(() => false);
          if (vis) {
            targetBtn = candidate;
            break;
          }
        }
        if (!targetBtn) {
          console.error(`[like-click] ${selector} 没有可见匹配项, 跳过`);
          continue;
        }

        // 诊断打印
        try {
          const diag = await targetBtn.evaluate(el => ({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
            e2e: el.getAttribute('data-e2e') || '',
            e2eState: el.getAttribute('data-e2e-state') || '',
            text: (el.innerText || '').trim().slice(0, 20),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
          }));
          console.error(`[like-click] 目标元素:`, JSON.stringify(diag));
        } catch {}

        try {
          console.error(`[like-click] 执行 locator.click...`);
          await targetBtn.click({ timeout: 5000 });
          console.error(`[like-click] locator.click 完成`);
        } catch (err) {
          console.error(`[like-click] locator.click 失败: ${err.message}, 尝试 evaluate.click`);
          const clicked = await page.evaluate((sel) => {
            const marked = document.querySelector(sel);
            if (!marked) return false;
            const innerButton = marked.querySelector('button, [role="button"]');
            (innerButton || marked).click();
            return true;
          }, selector).catch(() => false);
          console.error(`[like-click] evaluate.click: ${clicked}`);
          if (!clicked) {
            console.error(`[like-click] 尝试 force click...`);
            await targetBtn.click({ force: true, timeout: 5000 });
          }
        }

        console.error(`[like-click] 已点击点赞按钮 (${selector})`);
        await page.waitForTimeout(2000);
        return true;
      }

      return false;
    };

    if (await clickExactLikeButton()) {
      return success({ clicked: true });
    }

    return blocking(
      RESULT_CODES.BLOCKED,
      '找不到点赞按钮，且所有兜底策略失效',
      { data: {} }
    );
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
    const state = await checkLikeState(page);
    if (state.ok && state.data?.alreadyLiked) {
      return success({ signal: state.data.signal });
    }

    return blocking(
      RESULT_CODES.BLOCKED,
      '点击点赞按钮后无法确认已赞，请检查页面状态',
      { data: { state: state.data || null } }
    );
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `确认点赞异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function extractVideoCommentContext(page) {
  try {
    const ctx = await page.evaluate(() => {
      const titleEl = document.querySelector('title');
      const targetWorkTitle = titleEl ? titleEl.innerText.trim() : '';

      const captionEl = document.querySelector('[data-e2e="video-desc"], .caption, .desc');
      const captionText = captionEl ? captionEl.innerText.trim().slice(0, 500) : '';

      const hashtagEls = document.querySelectorAll('a[href*="/tag/"], [data-e2e="search-common"] a');
      const hashtags = [];
      for (const el of hashtagEls) {
        const t = (el.innerText || '').trim().replace(/^#/, '');
        if (t && t.length <= 30 && hashtags.length < 10) hashtags.push(t);
      }

      const authorEl = document.querySelector('[data-e2e="video-author"], .author-name, a[data-e2e="video-user-name"]');
      const authorName = authorEl ? authorEl.innerText.trim().slice(0, 50) : '';

      const bodyText = (document.body?.innerText || '').slice(0, 3000);
      const visibleTextSample = bodyText.slice(0, 500);

      function parseCount(text) {
        if (!text) return null;
        const s = text.replace(/[,\s]/g, '');
        const m = s.match(/^([\d.]+)([万wW]?)/);
        if (!m) return null;
        let v = parseFloat(m[1]);
        if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') v *= 10000;
        return Math.round(v);
      }

      let likeCount = null;
      let commentCount = null;
      let shareCount = null;

      const actionItems = document.querySelectorAll('.t5VMknM2 .MinpposV > .AOWKbsTg');
      if (actionItems.length >= 3) {
        const countEls = actionItems[0].querySelectorAll('span');
        for (const sp of countEls) {
          const t = sp.innerText.trim();
          if (/\d/.test(t) && likeCount === null) { likeCount = parseCount(t); break; }
        }
        const commentCountEls = actionItems[1].querySelectorAll('span');
        for (const sp of commentCountEls) {
          const t = sp.innerText.trim();
          if (/\d/.test(t) && commentCount === null) { commentCount = parseCount(t); break; }
        }
        const shareCountEls = actionItems[2].querySelectorAll('span');
        for (const sp of shareCountEls) {
          const t = sp.innerText.trim();
          if (/\d/.test(t) && shareCount === null) { shareCount = parseCount(t); break; }
        }
      }

      const hasTitle = targetWorkTitle.length > 0;
      const hasCaption = captionText.length > 10;
      const hasHashtags = hashtags.length > 0;
      const canGenerateContextualComment = hasTitle || hasCaption || hasHashtags;

      return {
        targetWorkTitle,
        captionText,
        hashtags,
        authorName,
        visibleTextSample,
        likeCount,
        commentCount,
        shareCount,
        canGenerateContextualComment,
      };
    });

    console.error(`[video-page] 上下文提取: title="${ctx.targetWorkTitle.slice(0, 40)}" hashtags=${ctx.hashtags.length} canGen=${ctx.canGenerateContextualComment}`);
    return success(ctx);
  } catch (err) {
    return success({
      targetWorkTitle: '',
      captionText: '',
      hashtags: [],
      authorName: '',
      visibleTextSample: '',
      likeCount: null,
      commentCount: null,
      shareCount: null,
      canGenerateContextualComment: false,
    });
  }
}

export async function ensureCommentPanelOpen(page) {
  try {
    const isOpen = async () => await page.evaluate(() => {
      const selectors = [
        '.comment-mainContent',
        '[class*="comment-main"]',
        '[class*="comment-list"]',
        '[class*="comment-container"]',
        '[contenteditable="true"]',
        '[contenteditable="true"][data-placeholder*="评"]',
        '[contenteditable="true"][placeholder*="评"]',
        'textarea[placeholder*="评"]',
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 30 && rect.height > 20) return true;
        }
      }
      return false;
    }).catch(() => false);

    if (await isOpen()) return true;

    const commentBtns = [
      { label: 'actionbar-feed-comment', locator: page.locator('.hOcDRkbZ.WcVcXqQb [data-e2e="feed-comment-icon"]') },
      { label: 'feed-comment-icon', locator: page.locator('[data-e2e="feed-comment-icon"]') },
      { label: 'legacy-comment-icon', locator: page.locator('.swmK_9e_.PWegAy8W.LDWpmlY0') },
      { label: 'video-comment', locator: page.locator('[data-e2e="video-comment"]') },
      { label: 'comment-icon', locator: page.locator('[data-e2e="comment-icon"]') },
      { label: 'aria-comment', locator: page.locator('[aria-label*="评论"]') },
      { label: 'title-comment', locator: page.locator('[title*="评论"]') },
    ];

    for (let attempt = 1; attempt <= 4; attempt++) {
      console.error(`[video-page] 打开评论区 attempt=${attempt} start`);
      for (const btn of commentBtns) {
        console.error(`[video-page] 检查评论按钮 attempt=${attempt} selector=${btn.label}`);
        const locator = btn.locator;
        if (await locator.count() > 0 && await locator.first().isVisible()) {
          let clicked = false;
          try {
            await locator.first().click({ timeout: 3000 });
            clicked = true;
          } catch {
            try {
              await locator.first().click({ force: true, timeout: 3000 });
              clicked = true;
            } catch {
              try {
                const handle = await locator.first().elementHandle();
                if (handle) {
                  await handle.evaluate((el) => el.click());
                  clicked = true;
                }
              } catch {}
            }
          }

          if (!clicked) continue;

          console.error(`[video-page] 已点击评论按钮 selector=${btn.label}，尝试打开评论面板 (attempt=${attempt})`);

          // 新版抖音点击评论图标默认打开"问问AI"，需要再点"评论"tab切换到真实评论区
          await page.waitForTimeout(800);
          const tabResult = await page.evaluate(() => {
            function visible(el) {
              if (!el) return false;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const s = window.getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            }
            const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, a'));
            for (const el of nodes) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text === '评论' && visible(el)) {
                const r = el.getBoundingClientRect();
                if (r.top <= window.innerHeight * 0.5) {
                  el.click();
                  return { clicked: true, text, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60) };
                }
              }
            }
            return { clicked: false };
          }).catch(() => ({ clicked: false }));
          if (tabResult.clicked) {
            console.error(`[video-page] 已点击评论Tab text="${tabResult.text}" tag=${tabResult.tag} class="${tabResult.cls}"`);
          } else {
            console.error(`[video-page] 未找到评论Tab按钮 (attempt=${attempt})`);
          }

          const deadline = Date.now() + (attempt < 3 ? 2500 : 5000);
          while (Date.now() < deadline) {
            if (await isOpen()) return true;
            await page.waitForTimeout(500);
          }
          console.error(`[video-page] 评论面板仍未打开 selector=${btn.label} (attempt=${attempt})`);
        }
      }

      const domClick = await clickVideoCommentButtonByDom(page);
      if (domClick?.ok) {
        console.error(`[video-page] 已通过 DOM 兜底点击评论按钮 method=${domClick.method} text="${domClick.text || ''}" (attempt=${attempt})`);
        await page.waitForTimeout(800);
        const deadline = Date.now() + (attempt < 3 ? 2500 : 5000);
        while (Date.now() < deadline) {
          if (await isOpen()) return true;
          await page.waitForTimeout(500);
        }
        console.error(`[video-page] DOM 兜底点击后评论面板仍未打开 method=${domClick.method} (attempt=${attempt})`);
      }
      await page.waitForTimeout(700 * attempt);
    }
  } catch (err) {
    console.error(`[video-page] 展开评论面板异常: ${err.message}`);
  }
  return false;
}

const inputSelectors = [
  '[contenteditable="true"][data-placeholder*="评"]',
  '[contenteditable="true"][placeholder*="评"]',
  '[contenteditable="true"][data-placeholder*="说点什么"]',
  '[contenteditable="true"][placeholder*="说点什么"]',
  '[contenteditable="true"][data-placeholder*="善语"]',
  '[contenteditable="true"][placeholder*="善语"]',
  '[contenteditable="true"][data-placeholder*="留下"]',
  '[contenteditable="true"][placeholder*="留下"]',
  'textarea[placeholder*="评"]',
  'textarea[placeholder*="说点什么"]',
  'textarea[placeholder*="善语"]',
  'textarea[placeholder*="留下"]',
  '[class*="comment"] [contenteditable="true"]',
  '[class*="comment"] textarea',
  '[id*="comment"] [contenteditable="true"]',
  '[id*="comment"] textarea'
];

export async function findCommentInput(page) {
  const isSearchInput = async (el) => {
    try {
      const ph = await el.evaluate(node => {
        const p = node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || '';
        const id = node.id || '';
        const cls = typeof node.className === 'string' ? node.className : '';
        return `${p} ${id} ${cls}`;
      });
      return /搜|search/i.test(ph);
    } catch {
      return false;
    }
  };

  for (const selector of inputSelectors) {
    const el = page.locator(selector).first();
    if (await el.count() > 0 && await el.isVisible()) {
      if (!(await isSearchInput(el))) {
        return el;
      }
    }
  }

  // 尝试滚动评论区容器
  console.error('[video-page] 尝试滚动以寻找评论输入框...');
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const containers = document.querySelectorAll('[class*="comment"], [id*="comment"]');
    for (const c of containers) {
      c.scrollIntoView?.({ block: 'end' });
    }
  });
  await page.waitForTimeout(1000);

  // 滚动后再试一次
  for (const selector of inputSelectors) {
    const el = page.locator(selector).first();
    if (await el.count() > 0 && await el.isVisible()) {
      if (!(await isSearchInput(el))) {
        return el;
      }
    }
  }

  return null;
}

export async function activateCommentComposer(page) {
  return await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function clickFirst(selector) {
      const el = document.querySelector(selector);
      if (el && visible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        el.click();
        return { ok: true, text: (el.innerText || el.textContent || '').trim().slice(0, 40) };
      }
      return null;
    }

    // --- Tier 1: 按 HTML 结构直接定位（不依赖文字匹配）---
    const structuralSelectors = [
      '.comment-input-inner-container',
      '.LpZjb4Yg',
      '.j_kd_P_l',
    ];
    for (const sel of structuralSelectors) {
      const result = clickFirst(sel);
      if (result) return result;
    }

    // --- Tier 2: 文字匹配兜底 ---
    const patterns = ['善语结善缘', '说点什么', '留下评论', '发表评论', '写评论', '评论'];
    const selectors = [
      '[class*="comment"]',
      '[id*="comment"]',
      '[data-e2e*="comment"]',
      'button',
      'div',
      'span',
    ];
    const nodes = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (/没有更多|暂无/.test(text)) continue;
        const placeholder = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
        const combined = `${text} ${placeholder}`.trim();
        if (!combined || combined.length > 80) continue;
        if (patterns.some(p => combined.includes(p))) nodes.push(el);
      }
    }

    nodes.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.top - ar.top;
    });

    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
      el.click();
      return { ok: true, text: (el.innerText || el.textContent || '').trim().slice(0, 40) };
    }

    return { ok: false, reason: 'composer_placeholder_not_found' };
  });
}

export async function postVideoComment(page, text, { execute = false, expectedWorkId = '' } = {}) {
  let submitWatcher = null;
  try {
    if (!text || !text.trim()) {
      return blocking(
        RESULT_CODES.EMPTY_REPLY_TEXT,
        '评论内容为空',
        { recoverable: false }
      );
    }

    if (!execute) {
      return blocking(
        RESULT_CODES.ACTION_NOT_READY,
        '非 execute 模式，拒绝真实评论操作',
        { recoverable: false }
      );
    }

    const trimmed = text.trim();
    submitWatcher = createCommentSubmitApiWatcher(page, { expectedText: trimmed, expectedAwemeId: expectedWorkId });

    // 1. 尝试打开评论面板
    let clickCommentPanelSuccess = await ensureCommentPanelOpen(page);

    // 2. 寻找输入框
    let input = await findCommentInput(page);
    if (!input) {
      const activateResult = await activateCommentComposer(page);
      if (activateResult.ok) {
        console.error(`[video-page] 已点击评论输入入口 (${activateResult.text || 'placeholder'})`);
        await page.waitForTimeout(1200);
        input = await findCommentInput(page);
      } else {
        // 兜底：直接点击评论输入容器
        const inputContainer = page.locator('.comment-input-inner-container').first();
        if (await inputContainer.count() > 0 && await inputContainer.isVisible()) {
          console.error('[video-page] 直接点击评论输入容器激活');
          await inputContainer.click();
          await page.waitForTimeout(1500);
          input = await findCommentInput(page);
        }
      }
    }

    // 3. 收集 Debug 诊断信息
    if (!input) {
      const debugInfo = await page.evaluate(() => {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        const textareas = document.querySelectorAll('textarea');
        const inputs = document.querySelectorAll('input');
        const placeHolders = [];
        
        const collect = (el) => {
          const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
          if (ph) placeHolders.push(ph);
        };
        editables.forEach(collect);
        textareas.forEach(collect);
        inputs.forEach(collect);
        
        return {
          url: window.location.href,
          title: document.title,
          editableCount: editables.length,
          textareaCount: textareas.length,
          inputCount: inputs.length,
          placeholders: placeHolders,
          commentContainers: document.querySelectorAll('[class*="comment"], [id*="comment"]').length
        };
      });

      console.error('[video-page] 评论框未找到！当前页面 DOM Debug 诊断信息:', JSON.stringify(debugInfo));
      const debugPath = await captureVideoCommentDebug(page, 'comment-input-not-found', { clickCommentPanelSuccess, debugInfo });

      return blocking(
        RESULT_CODES.COMMENT_INPUT_NOT_FOUND,
        '找不到视频评论区输入框',
        { data: { clickCommentPanelSuccess, debugInfo, debugPath } }
      );
    }

    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(trimmed, { delay: 50 });
    await page.waitForTimeout(500);

    const sendBtnSelectors = [
      'span.Law8JZNu',
      'span.FbVIhLlK',
      'button:has-text("发送")',
      'button:has-text("发布")',
      '[data-e2e="comment-submit"]',
      'button[class*="submit"]',
      'button[class*="send"]',
      'button[class*="publish"]'
    ];

    let clickedSend = false;
    for (const sel of sendBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible()) {
        await btn.click();
        clickedSend = true;
        console.error(`[video-page] 已通过按钮发送评论 (${sel})`);
        break;
      }
    }

    if (!clickedSend) {
      const domSend = await clickVideoCommentSendControl(page);
      if (domSend?.ok) {
        clickedSend = true;
        console.error(`[video-page] 已通过 DOM 发送控件发送评论 (${domSend.method})`);
      }
    }

    if (!clickedSend) {
      console.error('[video-page] 找不到发送按钮，尝试 Control+Enter / Enter 兜底发送');
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      clickedSend = true;
    }

    console.error('[video-page] 已提交评论');
    const apiConfirmed = await submitWatcher.waitForSuccess({ timeoutMs: 2500 });
    if (apiConfirmed) {
      console.error(`[video-page] 评论请求已成功 matchedBy=${apiConfirmed.matchedBy} commentId=${apiConfirmed.commentId || ''}`);
      return success({ text: trimmed, verified: true, unconfirmed: false, method: 'submit_api_success', submitApi: apiConfirmed });
    }

    await page.waitForTimeout(600);

    const isEmpty = await input.evaluate(el => {
      const text = el.textContent || '';
      return text.trim().length === 0;
    });

    if (!isEmpty) {
      return success({ text: trimmed, unconfirmed: true });
    }

    return success({ text: trimmed, verified: true, unconfirmed: false, method: 'editor_cleared_after_send' });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `发表评论异常: ${err.message}`,
      { data: { error: err.message } }
    );
  } finally {
    submitWatcher?.stop?.();
  }
}
