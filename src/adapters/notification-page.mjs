/**
 * Notification panel adapter — hover bell icon, extract notification items
 * Panel appears on mouse hover over svg.LtuRRess on /user/self
 *
 * Key principles:
 * - Mouse stays inside panel to keep it open
 * - Scrolling uses real mouse wheel, not scrollTop
 * - Item detection uses text patterns (action keywords), not CSS class names
 * - Panel stability is checked before extraction
 */

import { normalizeDouyinUrl as _norm } from '../utils/douyin-url.mjs';
export const normalizeDouyinUrl = _norm;

const SELF_URL = 'https://www.douyin.com/user/self';

export function parseRelationLine(line) {
  if (!line) return null;
  if (line === '朋友') return 'friend';
  if (line === '互相关注') return 'mutual';
  if (line.includes('在线')) return 'friend';
  return null;
}

export async function ensureNotificationPageReady(page) {
  await page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error('[notify-page] 等待页面加载...');
  const maxWait = 15000;
  const pollInterval = 1000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const found = await page.evaluate(() => {
      return !!document.querySelector('svg.LtuRRess') ||
        !!document.querySelector('[data-e2e*="notify"]') ||
        !!document.querySelector('[data-e2e*="message"]');
    }).catch(() => false);
    if (found) {
      console.error(`[notify-page] 页面就绪 (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return;
    }
    await page.waitForTimeout(pollInterval);
  }
  console.error('[notify-page] 页面就绪（超时降级）');
}

export async function openNotificationPanel(page) {
  try {
    console.error('[notify-page] 定位通知铃铛...');

    const bell = page.locator('svg.LtuRRess').first();
    try {
      await bell.waitFor({ state: 'attached', timeout: 5000 });
      await bell.hover({ timeout: 3000 });
      const found = await waitForPanelContent(page);
      if (found) {
        console.error('[notify-page] ✅ hover 铃铛触发了通知面板');
        return true;
      }
    } catch {
      console.error('[notify-page] hover 铃铛失败');
    }

    try {
      const bellBtn = page.locator('div[data-e2e]:has(svg.LtuRRess)').first();
      await bellBtn.click({ timeout: 5000 });
      const found = await waitForPanelContent(page);
      if (found) {
        console.error('[notify-page] ✅ click data-e2e 容器触发了通知面板');
        return true;
      }
    } catch {
      console.error('[notify-page] click 容器失败');
    }

    console.error('[notify-page] 降级扫描顶部图标...');
    const candidates = await page.evaluate(() => {
      const all = document.querySelectorAll('[data-e2e], [class*="icon"], [class*="btn"], header *, nav *');
      const icons = [];
      const seen = new Set();
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.y > 120 || rect.x < 200 || rect.width < 10 || rect.height < 10) continue;
        const key = `${rect.x.toFixed(0)},${rect.y.toFixed(0)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        icons.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      }
      return icons;
    });

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await page.mouse.move(c.x, c.y, { steps: 3 });
      const found = await waitForPanelContent(page, { maxWait: 3000 });
      if (found) {
        console.error(`[notify-page] ✅ hover #${i + 1} 触发: (${c.x.toFixed(0)}, ${c.y.toFixed(0)})`);
        return true;
      }
    }

    console.error('[notify-page] 所有策略均未触发通知面板');
    return false;
  } catch (err) {
    console.error('[notify-page] 异常:', err.message);
    return false;
  }
}

async function waitForPanelContent(page, { maxWait = 15000 } = {}) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return { found: true };
            c = c.parentElement;
          }
        }
      }
      return { found: false };
    });
    if (result.found) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

export async function waitForNotificationPanelStable(page) {
  console.error('[notify-page] 等待通知面板稳定...');
  const maxWait = 8000;
  const deadline = Date.now() + maxWait;
  let prevInfo = '';
  let prevCount = -1;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const panel = (function findNotificationPanel() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 30) continue;
            let c = el.parentElement;
            for (let i = 0; i < 6 && c && c !== document.body; i++) {
              const cr = c.getBoundingClientRect();
              if (cr.width > 250 && cr.height > 300) return c;
              c = c.parentElement;
            }
          }
        }
        return null;
      })();
      if (!panel) return { found: false };
      const text = (panel.innerText || '').trim();
      const allEls = panel.querySelectorAll('*');
      let visibleCount = 0;
      for (const el of allEls) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) visibleCount++;
      }
      return { found: true, textLen: text.length, visibleCount };
    });

    if (!info.found) {
      await page.waitForTimeout(500);
      continue;
    }

    const currentInfo = `${info.textLen}:${info.visibleCount}`;
    if (currentInfo === prevInfo) {
      stableRounds++;
      if (stableRounds >= 2) {
        console.error('[notify-page] 通知面板已稳定');
        break;
      }
    } else {
      stableRounds = 0;
    }
    prevInfo = currentInfo;
    await page.waitForTimeout(500);
  }

  const panelBox = await getPanelBoundingBox(page);
  const emptyState = await page.evaluate(() => {
    const panel = (function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    })();
    if (!panel) return { panelFound: false, empty: true };
    const text = (panel.innerText || '').trim();
    const actionPatterns = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];
    const hasEmpty = text.includes('暂无消息') || text.includes('暂无通知') || text.includes('没有更多了');
    const hasAction = actionPatterns.some(p => text.includes(p));
    return { panelFound: true, empty: hasEmpty && !hasAction };
  });

  return { stable: true, empty: emptyState.empty, panelBox };
}

export async function moveMouseIntoPanel(page, panelBox) {
  if (!panelBox) return;
  const x = panelBox.x + panelBox.width / 2;
  const y = panelBox.y + Math.min(80, panelBox.height / 2);
  console.error(`[notify-page] 鼠标移动到面板内部 x=${x.toFixed(0)}, y=${y.toFixed(0)}`);
  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(300);
}

export async function getPanelBoundingBox(page) {
  return await page.evaluate(() => {
    let panel = null;
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 30) continue;
        let c = el.parentElement;
        for (let i = 0; i < 6 && c && c !== document.body; i++) {
          const cr = c.getBoundingClientRect();
          if (cr.width > 250 && cr.height > 300) { panel = c; break; }
          c = c.parentElement;
        }
        if (panel) break;
      }
    }
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

export async function scrollPanelDown(page, { deltaY = 600 } = {}) {
  const panelBox = await getPanelBoundingBox(page);
  if (!panelBox) return { scrolled: false };

  const centerX = panelBox.x + panelBox.width / 2;
  const centerY = panelBox.y + panelBox.height / 2;

  await page.mouse.move(centerX, centerY, { steps: 3 });
  await page.waitForTimeout(100);

  console.error(`[notify-page] wheel 滚动通知面板 delta=${deltaY}`);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(1200);

  return { scrolled: true };
}

export async function extractVisibleNotifications(page) {
  const result = await page.evaluate(() => {
    // --- Constants must be inline inside evaluate() ---
    const ACTION_PATTERNS = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];
    const TIME_PATTERN = /^(\d{2}:\d{2}|\d+[秒分时天周月年]前|\d{2}-\d{2}|\d+月\d+日|昨天\s?\d{2}:\d{2}|星期\S)$/;
    const SKIP_SET = new Set(['互动消息', '全部消息', '点击加载更多', '加载更多', '没有更多了', '暂无消息', '推荐了你的视频']);

    function parseRelationLine(line) {
      if (!line) return null;
      if (line === '朋友') return 'friend';
      if (line === '互相关注') return 'mutual';
      if (line.includes('在线')) return 'friend';
      return null;
    }

    function _normUrl(h) {
      if (!h) return '';
      let s = h.trim();
      if (!s) return '';
      let changed = true;
      while (changed) {
        changed = false;
        if (s.startsWith('https://www.douyin.com')) { s = s.slice(22); changed = true; continue; }
        if (s.startsWith('http://www.douyin.com'))  { s = s.slice(21); changed = true; continue; }
        if (s.startsWith('/https://www.douyin.com')) { s = s.slice(23); changed = true; continue; }
        if (s.startsWith('/http://www.douyin.com'))  { s = s.slice(22); changed = true; continue; }
        if (s.startsWith('https://'))               { s = s.slice(8);  changed = true; continue; }
        if (s.startsWith('http://'))                { s = s.slice(7);  changed = true; continue; }
        if (s.startsWith('//www.douyin.com'))       { s = s.slice(16); changed = true; continue; }
        if (s.startsWith('//'))                     { s = s.slice(2);  changed = true; continue; }
        if (s.startsWith('www.douyin.com'))         { s = s.slice(14); changed = true; continue; }
        if (s.startsWith('douyin.com'))             { s = s.slice(10); changed = true; continue; }
      }
      if (s.startsWith('/')) s = s.slice(1);
      const qIdx = s.indexOf('?');
      if (qIdx > 0) s = s.slice(0, qIdx);
      const hIdx = s.indexOf('#');
      if (hIdx > 0) s = s.slice(0, hIdx);
      if (!s) return '';
      return 'https://www.douyin.com/' + s;
    }

    function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    }

    function findNotificationItemElements(panel, panelRect) {
      const selectorItems = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');
      const direct = [];
      for (const el of selectorItems) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 5) continue;
        const text = (el.innerText || '').trim();
        for (const pat of ACTION_PATTERNS) {
          if (text.includes(pat)) { direct.push(el); break; }
        }
      }
      if (direct.length > 0) return direct;

      const allElements = panel.querySelectorAll('*');
      const singleAction = [];
      for (const el of allElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 20) continue;
        if (rect.height > panelRect.height * 0.4) continue;
        if (rect.top < panelRect.top - 5 || rect.bottom > panelRect.bottom + 50) continue;
        const text = (el.innerText || '').trim();
        if (text.length < 5) continue;
        let actionCount = 0;
        for (const pat of ACTION_PATTERNS) {
          let idx = text.indexOf(pat);
          let safety = 0;
          while (idx !== -1 && safety < 10) { actionCount++; idx = text.indexOf(pat, idx + 1); safety++; }
        }
        if (actionCount === 1) {
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length >= 2) { singleAction.push({ el, lines, rect }); }
        }
      }
      if (singleAction.length === 0) return [];

      const groups = [];
      for (const candidate of singleAction) {
        let addedToGroup = false;
        for (const group of groups) {
          const memberRect = group[0].rect;
          const candRect = candidate.rect;
          const overlapTop = Math.max(memberRect.top, candRect.top);
          const overlapBottom = Math.min(memberRect.bottom, candRect.bottom);
          const overlapHeight = overlapBottom - overlapTop;
          if (overlapHeight > Math.min(memberRect.height, candRect.height) * 0.5) {
            group.push(candidate);
            addedToGroup = true;
            break;
          }
        }
        if (!addedToGroup) groups.push([candidate]);
      }
      return groups.map(group => { group.sort((a, b) => b.lines.length - a.lines.length); return group[0].el; });
    }

    function generateItemKey(d) {
      const raw = [d.username, d.relation, d.action, (d.content || '').slice(0, 200), d.actorProfileKey || d.actorProfileUrl]
        .map(s => (s || '').trim()).join('||');
      let hash = 0;
      for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
      return Math.abs(hash).toString(36);
    }

    // --- Main extraction logic ---
    const items = [];
    const panel = findNotificationPanel();
    if (!panel) {
      return { ok: false, data: { notifications: [], hasNew: false }, message: 'notification panel not found', _diag: { panelFound: false } };
    }

    const panelRect = panel.getBoundingClientRect();
    const notificationElements = findNotificationItemElements(panel, panelRect);
    const seenTexts = new Set();
    const diagSkipped = [];

    for (const itemEl of notificationElements) {
      const text = (itemEl.innerText || '').trim();
      if (text.length < 3) { if (text.length > 0) diagSkipped.push({ reason: 'too_short', text: text.slice(0, 60) }); continue; }
      if (SKIP_SET.has(text)) { diagSkipped.push({ reason: 'skip_set', text: text.slice(0, 60) }); continue; }
      if (seenTexts.has(text)) { diagSkipped.push({ reason: 'duplicate_text', text: text.slice(0, 60) }); continue; }
      seenTexts.add(text);

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      let idx = 0;
      const username = lines[idx];
      if (!username || username.length > 40 || TIME_PATTERN.test(username) || parseRelationLine(username) || SKIP_SET.has(username)) {
        diagSkipped.push({ reason: 'bad_username', text: text.slice(0, 80), username: (username || '').slice(0, 30) });
        continue;
      }
      idx++;

      let relation = 'unknown';
      if (idx < lines.length) {
        const parsed = parseRelationLine(lines[idx]);
        if (parsed) {
          relation = parsed;
          idx++;
        }
      }

      let eventType = '', action = '', content = '';
      for (let k = idx; k < lines.length; k++) {
        for (const pat of ACTION_PATTERNS) {
          if (lines[k].includes(pat)) {
            action = pat;
            eventType = pat.includes('赞了') ? 'like' : 'comment';
            if (k > idx) content = lines.slice(idx, k).join(' ');
            idx = k + 1;
            break;
          }
        }
        if (eventType) break;
      }
      if (!eventType) { diagSkipped.push({ reason: 'no_action', text: text.slice(0, 80) }); continue; }

      let timeText = '';
      for (let k = idx; k < lines.length; k++) {
        if (TIME_PATTERN.test(lines[k])) { timeText = lines[k]; break; }
      }

      let actorProfileUrl = '', actorProfileKey = '', profileResolveMethod = 'unresolved';
      const links = itemEl.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
        if (match) {
          actorProfileUrl = _normUrl(href);
          actorProfileKey = match[1];
          profileResolveMethod = 'dom_href';
          break;
        }
      }
      if (!actorProfileUrl) {
        const imgs = itemEl.querySelectorAll('img');
        for (const img of imgs) {
          let el = img.parentElement;
          for (let i = 0; i < 4 && el; i++) {
            const href = el.getAttribute('href') || '';
            const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
            if (match) {
              actorProfileUrl = _normUrl(href);
              actorProfileKey = match[1];
              profileResolveMethod = 'dom_avatar_href';
              break;
            }
            el = el.parentElement;
          }
          if (actorProfileUrl) break;
        }
      }

      let workUrl = '', workId = '', workTitle = '';
      const allLinks = itemEl.querySelectorAll('a[href]');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const videoMatch = href.match(/\/video\/(\d+)/);
        if (videoMatch) { workUrl = _normUrl(href); workId = 'video-' + videoMatch[1]; workTitle = (link.getAttribute('title') || '').trim() || (link.innerText || '').trim(); break; }
        const noteMatch = href.match(/\/note\/(\d+)/);
        if (noteMatch) { workUrl = _normUrl(href); workId = 'note-' + noteMatch[1]; workTitle = (link.getAttribute('title') || '').trim() || (link.innerText || '').trim(); break; }
      }

      let platformEventId = '';
      platformEventId = itemEl.getAttribute('data-notification-id') ||
        itemEl.getAttribute('data-id') ||
        itemEl.getAttribute('data-comment-id') || '';
      if (!platformEventId) {
        const parentWithId = itemEl.closest('[data-notification-id], [data-id], [data-comment-id]');
        if (parentWithId) {
          platformEventId = parentWithId.getAttribute('data-notification-id') ||
            parentWithId.getAttribute('data-id') ||
            parentWithId.getAttribute('data-comment-id') || '';
        }
      }

      const itemData = {
        username: username.slice(0, 50),
        relation, eventType, action,
        content: content.slice(0, 300),
        timeText,
        rawText: text.slice(0, 500),
        actorProfileUrl, actorProfileKey,
        profileResolveMethod,
        workUrl,
        workId,
        workTitle: workTitle.slice(0, 120),
        platformEventId,
      };
      itemData.notificationItemKey = generateItemKey(itemData);
      items.push(itemData);
    }

    const NO_MORE_PATTERNS = ['暂无更多数据', '暂无数据', '没有更多了', '没有更多消息', '已加载全部', '已经到底了', '没有更多内容'];
    let noMoreData = false;
    const panelText = (panel.innerText || '');
    for (const pat of NO_MORE_PATTERNS) {
      if (panelText.includes(pat)) { noMoreData = true; break; }
    }

    return { ok: true, data: { notifications: items, noMoreData }, _diag: { panelFound: true, candidateCount: notificationElements.length, parsedCount: items.length, skipped: diagSkipped.slice(0, 10), noMoreData } };
  });

  const diag = result._diag;
  if (diag) {
    if (!diag.panelFound) {
      console.error('[notify-page] 诊断: 未找到通知面板');
    } else {
      console.error(`[notify-page] 诊断: 候选元素 ${diag.candidateCount}, 解析成功 ${diag.parsedCount}, 跳过 ${diag.skipped.length}`);
      for (const s of diag.skipped.slice(0, 5)) {
        console.error(`[notify-page]   跳过: ${s.reason} → ${s.text || s.username || ''}`);
      }
    }
  }

return result;
}

export async function closeNotificationPanel(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

export async function extractNotificationsBatch(page) {
  return await extractVisibleNotifications(page);
}

export async function extractNotifications(page) {
  const allItems = [];
  const seen = new Set();
  let rounds = 0;
  while (rounds < 10) {
    const batchResult = await extractVisibleNotifications(page);
    if (!batchResult || !batchResult.ok) break;
    const batch = batchResult.data.notifications || [];
    let hasNewInBatch = false;
    for (const item of batch) {
      const key = item.notificationItemKey || (item.username + '||' + item.action + '||' + item.content);
      if (seen.has(key)) continue;
      seen.add(key);
      allItems.push(item);
      hasNewInBatch = true;
    }
    if (!hasNewInBatch) break;
    const scrollResult = await scrollPanelDown(page);
    if (!scrollResult.scrolled || scrollResult.reachedBottom) break;
    rounds++;
  }
  return allItems;
}

export async function clickLikeProfileLink(page, eventCtx) {
  const ctx = typeof eventCtx === 'string' ? { username: eventCtx } : eventCtx;
  const { username, relation, action, timeText, notificationItemKey } = ctx;
  const shortName = (username || '').slice(0, 20);

    const result = await page.evaluate(({ name, rel, act, time, itemKey }) => {
    function parseRelationLine(line) {
      if (!line) return null;
      if (line === '朋友') return 'friend';
      if (line === '互相关注') return 'mutual';
      if (line.includes('在线')) return 'friend';
      return null;
    }

    function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    }

    function makeItemKey(d) {
      const raw = [d.username, d.relation, d.action, d.content, d.time, d.profileKey]
        .map(s => (s || '').trim()).join('||');
      let hash = 0;
      for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
      return Math.abs(hash).toString(36);
    }

    const panel = findNotificationPanel();
    if (!panel) return { clicked: false, reason: 'panel-not-found' };

    const items = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');

    if (itemKey) {
      for (const itemEl of items) {
        const text = (itemEl.innerText || '').trim();
        if (!text.includes(name)) continue;

        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const itemUsername = lines[0] || '';
        const itemRel = (() => {
          const parsed = parseRelationLine(lines[1] || '');
          return parsed ? lines[1] : '';
        })();
        const hasAction = act ? text.includes(act) : true;
        const hasTime = time ? text.includes(time) : true;

        const candidateKey = makeItemKey({
          username: itemUsername, relation: itemRel, action: act,
          content: text.slice(0, 200), time: time, profileKey: '',
        });

        if (candidateKey === itemKey || (hasAction && hasTime)) {
          const imgs = itemEl.querySelectorAll('img');
          for (const img of imgs) {
            if (img.offsetHeight > 0) {
              let clickTarget = img;
              for (let i = 0; i < 3 && clickTarget; i++) {
                if (clickTarget.tagName === 'A' || clickTarget.getAttribute('href')) {
                  clickTarget.click();
                  return { clicked: true, method: 'precise-avatar-link', text: text.slice(0, 60) };
                }
                clickTarget = clickTarget.parentElement;
              }
              img.click();
              return { clicked: true, method: 'precise-avatar-image', text: text.slice(0, 60) };
            }
          }

          const links = itemEl.querySelectorAll('a[href]');
          for (const link of links) {
            if (link.offsetHeight > 0 && link.getAttribute('href').includes('/user/')) {
              link.click();
              return { clicked: true, method: 'precise-user-link', text: text.slice(0, 60) };
            }
          }
        }
      }
    }

    for (const itemEl of items) {
      const text = (itemEl.innerText || '').trim();
      if (!text.includes(name)) continue;
      if (act && !text.includes(act)) continue;
      if (time && !text.includes(time)) continue;

      const imgs = itemEl.querySelectorAll('img');
      for (const img of imgs) {
        if (img.offsetHeight > 0) {
          let clickTarget = img;
          for (let i = 0; i < 3 && clickTarget; i++) {
            if (clickTarget.tagName === 'A' || clickTarget.getAttribute('href')) {
              clickTarget.click();
              return { clicked: true, method: 'fallback-avatar-link', text: text.slice(0, 60) };
            }
            clickTarget = clickTarget.parentElement;
          }
          img.click();
          return { clicked: true, method: 'fallback-avatar-image', text: text.slice(0, 60) };
        }
      }

      const links = itemEl.querySelectorAll('a[href]');
      for (const link of links) {
        if (link.offsetHeight > 0 && link.getAttribute('href').includes('/user/')) {
          link.click();
          return { clicked: true, method: 'fallback-user-link', text: text.slice(0, 60) };
        }
      }
    }

    return { clicked: false, reason: 'not-found' };
  }, { name: shortName, rel: relation || '', act: action || '', time: timeText || '', itemKey: notificationItemKey || '' });

  if (result.clicked) {
    console.error(`[notify-page] 点击 ${shortName} 的头像 (${result.method})`);
    await page.waitForTimeout(3000);
    return true;
  }

  console.error(`[notify-page] 未找到 ${shortName} 的精确匹配通知条目 (reason: ${result.reason})`);
  return false;
}

export async function clickCommentLink(page, username) {
  const shortName = username.slice(0, 20);

  const result = await page.evaluate((name) => {
    const panels = document.querySelectorAll('[class*="notice"], [class*="notification"], [class*="message-panel"], [class*="popup"], [class*="dropdown"], [class*="popper"], [class*="drawer"], [class*="sidebar"]');
    for (const panel of panels) {
      if (panel.offsetHeight === 0) continue;

      const items = panel.querySelectorAll('[class*="item"], [class*="list-item"], li, [class*="row"]');
      for (const item of items) {
        const text = (item.innerText || '').trim();
        if (!text.includes(name)) continue;

        item.click();
        return { clicked: true, text: text.slice(0, 60) };
      }
    }
    return { clicked: false };
  }, shortName);

  if (result.clicked) {
    console.error(`[notify-page] 点击 ${username} 的评论通知`);
    await page.waitForTimeout(3000);
    return true;
  }

  return false;
}

export async function debugDumpNotificationItems(page, debugDir) {
  const { ensureDir, writeJSON } = await import('../utils/filesystem.mjs');
  const { writeFileSync } = await import('fs');
  const { resolve } = await import('path');

  ensureDir(debugDir);

  const ACTION_PATTERNS = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];

  const debugData = await page.evaluate((ACTION_PATTERNS) => {
    function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    }

    function findNotificationItemElements(panel, panelRect) {
      const selectorItems = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');
      const direct = [];
      for (const el of selectorItems) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 5) continue;
        const text = (el.innerText || '').trim();
        for (const pat of ACTION_PATTERNS) {
          if (text.includes(pat)) { direct.push(el); break; }
        }
      }
      if (direct.length > 0) return direct;

      const allElements = panel.querySelectorAll('*');
      const singleAction = [];
      for (const el of allElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 20) continue;
        if (rect.height > panelRect.height * 0.4) continue;
        if (rect.top < panelRect.top - 5 || rect.bottom > panelRect.bottom + 50) continue;
        const text = (el.innerText || '').trim();
        if (text.length < 5) continue;
        let actionCount = 0;
        for (const pat of ACTION_PATTERNS) {
          let idx = text.indexOf(pat);
          let safety = 0;
          while (idx !== -1 && safety < 10) { actionCount++; idx = text.indexOf(pat, idx + 1); safety++; }
        }
        if (actionCount === 1) {
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length >= 2) { singleAction.push({ el, lines, rect }); }
        }
      }
      if (singleAction.length === 0) return [];

      const groups = [];
      for (const candidate of singleAction) {
        let addedToGroup = false;
        for (const group of groups) {
          const memberRect = group[0].rect;
          const candRect = candidate.rect;
          const overlapTop = Math.max(memberRect.top, candRect.top);
          const overlapBottom = Math.min(memberRect.bottom, candRect.bottom);
          const overlapHeight = overlapBottom - overlapTop;
          if (overlapHeight > Math.min(memberRect.height, candRect.height) * 0.5) {
            group.push(candidate);
            addedToGroup = true;
            break;
          }
        }
        if (!addedToGroup) groups.push([candidate]);
      }
      return groups.map(group => { group.sort((a, b) => b.lines.length - a.lines.length); return group[0].el; });
    }

    const panel = findNotificationPanel();
    if (!panel) return { error: 'panel not found', items: [] };

    const panelRect = panel.getBoundingClientRect();
    const notificationElements = findNotificationItemElements(panel, panelRect);

    const seen = new Set();
    const items = [];
    for (const itemEl of notificationElements) {
      const text = (itemEl.innerText || '').trim();
      if (seen.has(text)) continue;
      seen.add(text);

      const links = [];
      const allLinks = itemEl.querySelectorAll('a[href]');
      allLinks.forEach((link, index) => {
        const dataset = {};
        for (const key of Object.keys(link.dataset || {})) {
          dataset[key] = link.dataset[key];
        }
        links.push({
          index,
          text: (link.innerText || '').trim().slice(0, 200),
          href: link.getAttribute('href') || '',
          className: link.className || '',
          ariaLabel: link.getAttribute('aria-label') || '',
          title: link.getAttribute('title') || '',
          dataset,
        });
      });

      const imgs = [];
      const allImgs = itemEl.querySelectorAll('img');
      allImgs.forEach((img, index) => {
        imgs.push({
          index,
          src: (img.getAttribute('src') || '').slice(0, 500),
          className: img.className || '',
          alt: img.getAttribute('alt') || '',
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
        });
      });

      const itemDataset = {};
      for (const key of Object.keys(itemEl.dataset || {})) {
        itemDataset[key] = itemEl.dataset[key];
      }
      const cardAttrs = {
        tagName: itemEl.tagName,
        className: itemEl.className || '',
        role: itemEl.getAttribute('role') || '',
        dataE2e: itemEl.getAttribute('data-e2e') || '',
        dataset: itemDataset,
        onclick: !!itemEl.onclick,
      };

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let actorName = '';
      if (lines.length > 0) actorName = lines[0];
      let eventType = '';
      let action = '';
      let content = '';
      for (const line of lines) {
        for (const pat of ACTION_PATTERNS) {
          if (line.includes(pat)) {
            action = pat;
            eventType = pat.includes('赞了') ? 'like' : 'comment';
            break;
          }
        }
        if (eventType) break;
      }

      let workUrl = '', workId = '', workTitle = '';
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const videoMatch = href.match(/\/video\/(\d+)/);
        if (videoMatch) { workUrl = href; workId = 'video-' + videoMatch[1]; workTitle = (link.getAttribute('title') || '').trim() || (link.innerText || '').trim(); break; }
        const noteMatch = href.match(/\/note\/(\d+)/);
        if (noteMatch) { workUrl = href; workId = 'note-' + noteMatch[1]; workTitle = (link.getAttribute('title') || '').trim() || (link.innerText || '').trim(); break; }
      }

      let actorProfileUrl = '';
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.match(/\/user\//)) { actorProfileUrl = href; break; }
      }

      const warnings = [];
      if (eventType === 'comment' && !content) warnings.push('missing_comment_text');
      if (!actorName) warnings.push('missing_actor_name');
      if (!workTitle && eventType === 'comment') warnings.push('missing_work_title');

      items.push({
        outerHtml: itemEl.outerHTML,
        innerText: text,
        links,
        imgs,
        cardAttrs,
        meta: {
          actorName: actorName.slice(0, 50),
          commentText: content.slice(0, 300),
          eventType,
          action,
          rawText: text.slice(0, 500),
          notificationItemKey: '',
          profileUrl: actorProfileUrl,
          workId: workId || null,
          workUrl: workUrl || null,
          workTitle: workTitle.slice(0, 120) || null,
          warnings,
        },
      });
    }

    return { error: null, items };
  }, ACTION_PATTERNS);

  if (debugData.error) {
    console.error(`[debug-notify] 通知面板未找到，无法 dump`);
    return;
  }

  console.error(`[debug-notify] 采集到 ${debugData.items.length} 条通知，保存到 ${debugDir}`);

  for (let i = 0; i < debugData.items.length; i++) {
    const idx = String(i + 1).padStart(3, '0');
    const item = debugData.items[i];

    writeFileSync(resolve(debugDir, `item-${idx}.html`), item.outerHtml, 'utf8');
    writeFileSync(resolve(debugDir, `item-${idx}.txt`), item.innerText, 'utf8');
    writeJSON(resolve(debugDir, `item-${idx}-links.json`), item.links);
    writeJSON(resolve(debugDir, `item-${idx}-imgs.json`), item.imgs);
    writeJSON(resolve(debugDir, `item-${idx}-card.json`), item.cardAttrs);
    writeJSON(resolve(debugDir, `item-${idx}-meta.json`), item.meta);
  }
}