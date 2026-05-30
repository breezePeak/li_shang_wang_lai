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
  function _isDouyinRed(val) {
    if (!val) return false;
    const m = val.match(/rgb[va]?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return false;
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    return r >= 230 && g <= 90 && b <= 130;
  }
  if (_isDouyinRed(diag.color)) return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag };
  if (_isDouyinRed(diag.backgroundColor)) return { liked: true, confidence: 'confirmed', signal: 'red-bg:' + diag.tag };

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

      function hasLikedClass(cls) {
        return /active|liked|selected|checked|hasLiked/i.test(cls);
      }

      function hasLikedSvg(el) {
        // check SVGs inside this element or itself
        const svgs = (el.tagName === 'svg' || el.tagName === 'path') ? [el] : el.querySelectorAll('svg, path');
        for (const svg of svgs) {
          if (!isVisibleEl(svg)) continue;
          const fill = svg.getAttribute('fill') || '';
          if (fill === '#FF0040' || fill === '#FE2C55' || fill === 'red') return true;
          const style = window.getComputedStyle(svg);
          if (isDouyinRedColor(style.fill)) return true;
        }
        return false;
      }

      function elementInfo(el, maxTextLen) {
        const tag = (el.tagName || '').toLowerCase();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const svgEls = el.querySelectorAll('svg');
        let svgFill = '', pathFill = '';
        for (const svg of svgEls) {
          const f = svg.getAttribute('fill') || '';
          if (f) svgFill = f;
          const paths = svg.querySelectorAll('path');
          for (const p of paths) { const pf = p.getAttribute('fill') || ''; if (pf) pathFill = pf; }
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

      // ---- Phase 0: Douyin PC action bar like button detection ----
      // Real DOM: .t5VMknM2 > .MinpposV > .AOWKbsTg[0] is the like button.
      // No aria/title/data-e2e=like/digg. Count in span.Z4B2hGGG.
      // Liked state: class f7caOKG9 appears on the like container.
      const actionBarCheck = (() => {
        const container = document.querySelector('.t5VMknM2 .MinpposV');
        if (!container) return null;
        const items = Array.from(container.querySelectorAll(':scope > .AOWKbsTg'));
        if (items.length === 0) return null;
        const likeItem = items[0];

        const diag = (() => {
          const tag = likeItem.tagName.toLowerCase();
          const rect = likeItem.getBoundingClientRect();
          const cls = (typeof likeItem.className === 'string' ? likeItem.className : '');
          const countEl = likeItem.querySelector('.Z4B2hGGG');
          const countText = countEl ? (countEl.innerText || '').trim() : '';
          const style = window.getComputedStyle(likeItem);
          let svgFill = '', pathFill = '';
          const svgs = likeItem.querySelectorAll('svg');
          for (const svg of svgs) {
            if (!isVisibleEl(svg)) continue;
            const f = svg.getAttribute('fill') || '';
            if (f) svgFill = f;
            const cs = window.getComputedStyle(svg);
            if (isDouyinRedColor(cs.fill)) svgFill = cs.fill;
            const paths = svg.querySelectorAll('path');
            for (const p of paths) {
              if (!isVisibleEl(p)) continue;
              const pf = p.getAttribute('fill') || '';
              if (pf && isDouyinRedColor(pf)) pathFill = pf;
              const pcs = window.getComputedStyle(p);
              if (isDouyinRedColor(pcs.fill)) pathFill = pcs.fill;
              const pstroke = p.getAttribute('stroke') || '';
              if (pstroke === '#FF0040' || pstroke === '#FE2C55' || pstroke === 'red') pathFill = pstroke;
            }
          }
          return {
            tag, className: cls.slice(0, 60),
            text: ((likeItem.innerText || '').trim()).slice(0, 20),
            countText,
            color: style.color || '',
            backgroundColor: style.backgroundColor || '',
            svgFill,
            pathFill,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          };
        })();

        // collect sibling diagnostics
        const actionItemsDiag = items.slice(0, 4).map((el, i) => {
          const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 60);
          const countEl = el.querySelector('.Z4B2hGGG');
          const countText = countEl ? (countEl.innerText || '').trim() : '';
          const dataE2e = el.getAttribute('data-e2e') || el.querySelector('[data-e2e]')?.getAttribute?.('data-e2e') || '';
          let svgFill = '', pathFill = '';
          const svgs = el.querySelectorAll('svg');
          for (const svg of svgs) {
            const f = svg.getAttribute('fill') || ''; if (f) svgFill = f;
            const paths = svg.querySelectorAll('path');
            for (const p of paths) { const pf = p.getAttribute('fill') || ''; if (pf) pathFill = pf; }
          }
          return {
            index: i,
            className: cls,
            text: ((el.innerText || '').trim()).slice(0, 20),
            countText,
            dataE2e,
            svgFill,
            pathFill,
          };
        });

        return { likeItem, diag, actionItemCount: items.length, actionItemsDiag };
      })();

      if (actionBarCheck) {
        const { diag, actionItemCount, actionItemsDiag } = actionBarCheck;
        // check liked signals — f7caOKG9 class OR douyin red via isDouyinRedColor
        const cls = diag.className || '';
        const hasLikedClass = /\bf7caOKG9\b/.test(cls);
        const svgRed = diag.svgFill && isDouyinRedColor(diag.svgFill);
        const pathRed = diag.pathFill && isDouyinRedColor(diag.pathFill);
        const colorRed = isDouyinRedColor(diag.color);
        const bgRed = isDouyinRedColor(diag.backgroundColor);

        if (hasLikedClass || svgRed || pathRed || colorRed || bgRed) {
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
            return { liked: true, confidence: 'confirmed', signal: 'rightside-svg-red', diag: { tag: redItem.el.tagName.toLowerCase(), text: redItem.text } };
          }
          if (neutral) {
            return { liked: false, confidence: 'confirmed', signal: 'rightside-svg-neutral', diag: { tag: neutral.el.tagName.toLowerCase(), text: neutral.text } };
          }
        }
      }

      // ---- Phase 3: no heuristic match → collect page diagnostics ----
      if (candidates.length === 0) {
        return collectPageDiagnostics();
      }

      for (const c of candidates) {
        const { diag, fullText } = c;

        // 2a: class-based liked detection
        if (hasLikedClass(diag.className)) {
          return { liked: true, confidence: 'confirmed', signal: 'liked-class:' + diag.tag, diag };
        }

        // 2b: color-based liked detection
        if (isDouyinRedColor(diag.color)) {
          return { liked: true, confidence: 'confirmed', signal: 'red-color:' + diag.tag, diag };
        }
        if (isDouyinRedColor(diag.backgroundColor)) {
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
        RESULT_CODES.ACTION_NOT_APPROVED,
        '非 execute 模式，拒绝真实点赞操作',
        { recoverable: false }
      );
    }

    const barResult = await findDouyinActionBarLikeItem(page);
    if (!barResult.ok) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '找不到点赞按钮',
        { data: {} }
      );
    }

    if (barResult.data.isLiked) {
      return blocking(
        RESULT_CODES.ALREADY_LIKED,
        '已经点过赞，跳过',
        { data: {} }
      );
    }

    const likeItem = page.locator('.t5VMknM2 .MinpposV > .AOWKbsTg').first();
    await likeItem.click();
    console.error('[video-page] 已点击点赞按钮 (action bar)');
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
    const barResult = await findDouyinActionBarLikeItem(page);
    if (!barResult.ok) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '点击点赞按钮后无法确认已赞 (action bar not found)',
        { data: {} }
      );
    }

    const info = barResult.data;
    if (info.isLiked) {
      const signal = /\bf7caOKG9\b/.test(info.className) ? 'liked-class' : 'red-fill';
      return success({ signal });
    }

    return blocking(
      RESULT_CODES.BLOCKED,
      '点击点赞按钮后无法确认已赞，请检查页面状态',
      { data: { pathFill: info.pathFill, className: info.className } }
    );
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `确认点赞异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function postVideoComment(page, text, { execute = false } = {}) {
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
        RESULT_CODES.ACTION_NOT_APPROVED,
        '非 execute 模式，拒绝真实评论操作',
        { recoverable: false }
      );
    }

    const trimmed = text.trim();

    const input = page.locator(
      '[contenteditable="true"][data-placeholder*="评"], ' +
      '[contenteditable="true"][placeholder*="评"], ' +
      'textarea[placeholder*="评"], ' +
      'input[placeholder*="评"]'
    ).first();

    const inputCount = await input.count();
    if (inputCount === 0) {
      return blocking(
        RESULT_CODES.COMMENT_INPUT_NOT_FOUND,
        '找不到视频评论区输入框',
        { data: {} }
      );
    }

    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(trimmed, { delay: 50 });
    await page.waitForTimeout(500);

    const sendBtn = page.locator('button').filter({ hasText: /^发送$|^发布$/ }).first();
    const sendCount = await sendBtn.count();
    if (sendCount === 0) {
      return blocking(
        RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND,
        '找不到发送/发布按钮',
        { data: {} }
      );
    }

    await sendBtn.click();
    console.error('[video-page] 已提交评论');
    await page.waitForTimeout(2000);

    const isEmpty = await input.evaluate(el => {
      const text = el.textContent || '';
      return text.trim().length === 0;
    });

    if (!isEmpty) {
      return success({ text: trimmed, unconfirmed: true });
    }

    return success({ text: trimmed });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `发表评论异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}
