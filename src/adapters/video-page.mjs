import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

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
  function _isRed(val) {
    if (!val) return false;
    const m = val.match(/rgb[va]?\(\s*(\d+)/);
    if (!m) return false;
    return parseInt(m[1], 10) >= 230;
  }
  if (_isRed(diag.color)) return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag };
  if (_isRed(diag.backgroundColor)) return { liked: true, confidence: 'confirmed', signal: 'red-bg:' + diag.tag };

  // SVG-based detection
  if ([diag.svgFill, diag.pathFill].some(f => f === '#FF0040' || f === '#FE2C55' || f === 'red')) {
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
      // ---- helpers ----
      function isRedColor(val) {
        if (!val) return false;
        const m = val.match(/rgb[va]?\(\s*(\d+)/);
        if (!m) return false;
        const r = parseInt(m[1], 10);
        return r >= 230;
      }

      function hasLikedClass(cls) {
        return /active|liked|selected|checked|hasLiked/i.test(cls);
      }

      function hasLikedSvg(el) {
        // check SVGs inside this element or itself
        const svgs = (el.tagName === 'svg' || el.tagName === 'path') ? [el] : el.querySelectorAll('svg, path');
        for (const svg of svgs) {
          const fill = svg.getAttribute('fill') || '';
          if (fill === '#FF0040' || fill === '#FE2C55' || fill === 'red') return true;
          const style = window.getComputedStyle(svg);
          if (isRedColor(style.fill)) return true;
        }
        return false;
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

      // ---- Phase 2: determine like state ----
      if (candidates.length === 0) {
        return { liked: null, confidence: 'none', signal: 'no-candidates', candidates: [] };
      }

      for (const c of candidates) {
        const { diag, fullText } = c;

        // 2a: class-based liked detection
        if (hasLikedClass(diag.className)) {
          return { liked: true, confidence: 'confirmed', signal: 'liked-class:' + diag.tag, diag };
        }

        // 2b: color-based liked detection
        if (isRedColor(diag.color)) {
          return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag, diag };
        }
        if (isRedColor(diag.backgroundColor)) {
          return { liked: true, confidence: 'confirmed', signal: 'red-bg:' + diag.tag, diag };
        }

        // 2c: SVG fill-based liked detection
        if (diag.svgFill && (diag.svgFill === '#FF0040' || diag.svgFill === '#FE2C55' || diag.svgFill === 'red')) {
          return { liked: true, confidence: 'confirmed', signal: 'red-svg-fill:' + diag.tag, diag };
        }
        if (diag.pathFill && (diag.pathFill === '#FF0040' || diag.pathFill === '#FE2C55' || diag.pathFill === 'red')) {
          return { liked: true, confidence: 'confirmed', signal: 'red-path-fill:' + diag.tag, diag };
        }

        // 2d: explicit like button with count → neutral (already checked for red)
        const t = fullText || diag.text || '';
        if (/[赞]\s*\d/.test(t)) {
          return { liked: false, confidence: 'confirmed', signal: 'like-count-neutral', diag };
        }
      }

      // ---- Phase 3: find a clear unlike button ----
      for (const c of candidates) {
        const { diag } = c;
        const hasText = diag.text && (diag.text.startsWith('点赞') || diag.text.startsWith('赞'));
        const hasAria = (diag.ariaLabel || '').includes('赞');
        if (hasText || hasAria) {
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
      } else {
        console.error(`[video-page] 点赞状态无法确认: ${state.signal === 'no-candidates' ? '页面上未找到任何点赞相关元素' : `找到 ${state.candidateCount} 个候选但无法判定`}`);
      }
      return blocking(
        RESULT_CODES.LIKE_STATE_UNKNOWN,
        state.signal === 'no-candidates' ? '页面上未找到任何点赞相关元素' : '无法明确判断点赞状态',
        { data: { candidateCount: state.candidateCount || 0, candidates: state.candidates || [], confidence: state.confidence } }
      );
    }

    console.error(`[video-page] 点赞状态: ${state.liked ? '已赞' : '未赞'} (${state.signal})`);
    return success({
      alreadyLiked: state.liked,
      text: state.diag?.text || '',
      confidence: state.confidence,
      signal: state.signal,
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

export async function clickLike(page, { execute = false } = {}) {
  try {
    if (!execute) {
      return blocking(
        RESULT_CODES.ACTION_NOT_APPROVED,
        '非 execute 模式，拒绝真实点赞操作',
        { recoverable: false }
      );
    }

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

    console.error('[video-page] 已点击点赞按钮');
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
