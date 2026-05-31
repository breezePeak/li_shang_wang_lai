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
      document.querySelectorAll('[data-temp-like-btn]').forEach(el => el.removeAttribute('data-temp-like-btn'));

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
        const { likeItem, diag, actionItemCount, actionItemsDiag } = actionBarCheck;
        likeItem.setAttribute('data-temp-like-btn', 'true');
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
        if (diag.svgFill && (diag.svgFill === '#FF0040' || diag.svgFill === '#FE2C55' || diag.svgFill === 'red')) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-svg-fill:' + diag.tag, diag };
        }
        if (diag.pathFill && (diag.pathFill === '#FF0040' || diag.pathFill === '#FE2C55' || diag.pathFill === 'red')) {
          el.setAttribute('data-temp-like-btn', 'true');
          return { liked: true, confidence: 'confirmed', signal: 'red-path-fill:' + diag.tag, diag };
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
        RESULT_CODES.ACTION_NOT_APPROVED,
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

    const targetBtn = page.locator('[data-temp-like-btn="true"]').first();
    const count = await targetBtn.count();
    if (count > 0) {
      await targetBtn.click();
      console.error(`[video-page] 已点击点赞按钮 (${likeState.data?.signal || 'marked-btn'})`);
      await page.waitForTimeout(2000);
      return success({ clicked: true });
    }

    // 备用兜底
    const fallbackBtn = page.locator('.t5VMknM2 .MinpposV > .AOWKbsTg').first();
    if (await fallbackBtn.count() > 0) {
      await fallbackBtn.click();
      console.error('[video-page] 已点击点赞按钮 (action bar fallback)');
      await page.waitForTimeout(2000);
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

async function ensureCommentPanelOpen(page) {
  try {
    const commentBtns = [
      page.locator('.t5VMknM2 .MinpposV > .AOWKbsTg').nth(1), // action bar 第二个
      page.locator('[data-e2e="video-comment"]'),
      page.locator('[data-e2e="comment-icon"]'),
      page.locator('[aria-label*="评论"]'),
      page.locator('[title*="评论"]'),
      page.locator('svg').filter({ has: page.locator('path[d*="comment"]') }).locator('..')
    ];
    for (const btn of commentBtns) {
      if (await btn.count() > 0 && await btn.first().isVisible()) {
        await btn.first().click();
        console.error('[video-page] 已点击评论按钮，尝试打开评论面板');
        await page.waitForTimeout(1500);
        return true;
      }
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

async function findCommentInput(page) {
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

    // 1. 尝试打开评论面板
    let clickCommentPanelSuccess = await ensureCommentPanelOpen(page);

    // 2. 寻找输入框
    let input = await findCommentInput(page);

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

      return blocking(
        RESULT_CODES.COMMENT_INPUT_NOT_FOUND,
        '找不到视频评论区输入框',
        { data: { clickCommentPanelSuccess, debugInfo } }
      );
    }

    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(trimmed, { delay: 50 });
    await page.waitForTimeout(500);

    const sendBtnSelectors = [
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
      console.error('[video-page] 找不到发送按钮，尝试使用 Control+Enter 兜底发送');
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(500);
      clickedSend = true;
    }

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
