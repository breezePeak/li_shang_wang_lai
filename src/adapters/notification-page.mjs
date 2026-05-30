/**
 * Notification panel adapter — hover bell icon, extract notification items
 * Panel appears on mouse hover over svg.LtuRRess on /user/self
 */

import { notificationItemFingerprint } from '../domain/event-fingerprint.mjs';

const SELF_URL = 'https://www.douyin.com/user/self';

export async function ensureNotificationPageReady(page) {
  await page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error('[notify-page] 等待页面加载...');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.error('[notify-page] 页面就绪');
}

export async function openNotificationPanel(page) {
  try {
    console.error('[notify-page] 定位通知铃铛...');

    // Strategy 1: hover svg.LtuRRess
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

    // Strategy 2: click the data-e2e parent container
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

    // Strategy 3: fallback — scan top nav icons
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
        icons.push({
          tag: el.tagName,
          class: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '',
          text: (el.innerText || '').trim().slice(0, 30),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        });
      }
      return icons;
    });

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await page.mouse.move(c.x, c.y, { steps: 3 });
      const found = await waitForPanelContent(page, { maxWait: 3000 });
      if (found) {
        console.error(`[notify-page] ✅ hover #${i+1} 触发: ${c.class.slice(0, 30)}`);
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
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (text.startsWith('互动消息') || text.startsWith('全部消息')) {
          return { found: true };
        }
      }
      return { found: false };
    });

    if (result.found) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

export async function waitForPanelItems(page, { maxWait = 5000 } = {}) {
  await page.waitForFunction(({ actionPatterns }) => {
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
    if (!panel) return true;
    const candidates = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"], [class*="list"] > *');
    let matchCount = 0;
    for (const itemEl of candidates) {
      const text = (itemEl.innerText || '').trim();
      if (text.length < 3) continue;
      for (const pat of actionPatterns) {
        if (text.includes(pat)) { matchCount++; break; }
      }
    }
    return matchCount > 0;
  }, { timeout: maxWait }, { actionPatterns: ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'] }).catch(() => {});
}

/**
 * Close the notification panel by moving mouse away
 */
export async function closeNotificationPanel(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

/**
 * Old extractNotifications — scrolls all first then extracts.
 * Deprecated; use extractNotificationsBatch for incremental scanning.
 * Kept for backward compatibility with execute-reciprocal-likes.mjs.
 */
export async function extractNotifications(page) {
  const allItems = [];
  const seen = new Set();
  let rounds = 0;
  while (rounds < 10) {
    const batchResult = await extractNotificationsBatch(page);
    if (!batchResult || !batchResult.ok) break;
    const batch = batchResult.data.notifications || [];
    if (batch.length === 0) break;
    for (const item of batch) {
      const key = item.notificationItemKey || (item.username + '||' + item.action + '||' + item.content);
      if (seen.has(key)) continue;
      seen.add(key);
      allItems.push(item);
    }
    if (!batchResult.data.hasNew) break;
    rounds++;
  }
  return allItems;
}

/**
 * Extract ONE batch of notification items from the currently visible panel.
 * Returns parsed items + a flag indicating if there are more items to scroll to.
 * The caller drives the scroll loop and handles dedup/enrich per-batch.
 */
export async function extractNotificationsBatch(page) {
  const result = await page.evaluate(() => {
    const items = [];
    const panel = findNotificationPanel();
    if (!panel) {
      return { ok: false, data: { notifications: [], hasNew: false }, message: 'notification panel not found', _diag: { panelFound: false } };
    }

    const skipSet = new Set(['互动消息', '全部消息', '点击加载更多', '加载更多', '没有更多了', '暂无消息', '推荐了你的视频']);
    const listItems = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"], [class*="list"] > *');
    const actionPatterns = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];
    const timePattern = /^(\d{2}:\d{2}|\d+[秒分时天周月年]前|\d{2}-\d{2}|\d+月\d+日|昨天\s?\d{2}:\d{2}|星期\S)$/;
    const relationMap = { '朋友': 'friend', '互相关注': 'mutual' };

    // Diagnostic: capture panel child structure when no candidates found
    const diagPanelStructure = listItems.length === 0 ? (() => {
      const children = panel.children;
      const samples = [];
      for (let i = 0; i < Math.min(children.length, 8); i++) {
        const c = children[i];
        samples.push({
          tag: c.tagName.toLowerCase(),
          cls: (c.className && typeof c.className === 'string') ? c.className.slice(0, 80) : '',
          text: (c.innerText || '').trim().slice(0, 60),
          childCount: c.children.length,
        });
      }
      const deeper = [];
      if (children.length > 0) {
        const first = children[0];
        for (let i = 0; i < Math.min(first.children.length, 5); i++) {
          const gc = first.children[i];
          deeper.push({
            tag: gc.tagName.toLowerCase(),
            cls: (gc.className && typeof gc.className === 'string') ? gc.className.slice(0, 80) : '',
            text: (gc.innerText || '').trim().slice(0, 60),
          });
        }
      }
      return { childCount: children.length, samples, deeper };
    })() : null;

    const seenTexts = new Set();
    const diagSkipped = [];

    for (const itemEl of listItems) {
      const text = (itemEl.innerText || '').trim();
      if (text.length < 3) { if (text.length > 0) diagSkipped.push({ reason: 'too_short', text: text.slice(0, 60) }); continue; }
      if (skipSet.has(text)) { diagSkipped.push({ reason: 'skip_set', text: text.slice(0, 60) }); continue; }
      if (seenTexts.has(text)) { diagSkipped.push({ reason: 'duplicate_text', text: text.slice(0, 60) }); continue; }
      seenTexts.add(text);

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      let idx = 0;
      const username = lines[idx];
      if (!username || username.length > 40 || timePattern.test(username) || relationMap[username] || skipSet.has(username)) {
        diagSkipped.push({ reason: 'bad_username', text: text.slice(0, 80), username: (username || '').slice(0, 30) });
        continue;
      }
      idx++;

      let relation = 'unknown';
      if (idx < lines.length && relationMap[lines[idx]]) {
        relation = relationMap[lines[idx]];
        idx++;
      }

      let eventType = '', action = '', content = '';
      for (let k = idx; k < lines.length; k++) {
        for (const pat of actionPatterns) {
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
        if (timePattern.test(lines[k])) { timeText = lines[k]; break; }
      }

      // Extract profile URL
      let actorProfileUrl = '', actorProfileKey = '', profileResolveMethod = 'unresolved';
      const links = itemEl.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
        if (match) {
          actorProfileUrl = href.startsWith('http') ? href : `https://www.douyin.com${href}`;
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
              actorProfileUrl = href.startsWith('http') ? href : `https://www.douyin.com${href}`;
              actorProfileKey = match[1];
              profileResolveMethod = 'dom_avatar_href';
              break;
            }
            el = el.parentElement;
          }
          if (actorProfileUrl) break;
        }
      }

      // Extract work URL / workId from notification item links
      let workUrl = '', workId = '';
      const allLinks = itemEl.querySelectorAll('a[href]');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const videoMatch = href.match(/\/video\/(\d+)/);
        if (videoMatch) { workUrl = href; workId = 'video-' + videoMatch[1]; break; }
        const noteMatch = href.match(/\/note\/(\d+)/);
        if (noteMatch) { workUrl = href; workId = 'note-' + noteMatch[1]; break; }
      }

      // Extract platformEventId independently from workId
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
        platformEventId,
      };
      itemData.notificationItemKey = generateItemKey(itemData);
      items.push(itemData);
    }

    // Check if panel has scrollable content beyond current view
    const hasMore = panel.scrollHeight > panel.clientHeight + panel.scrollTop + 10;

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

    function generateItemKey(d) {
      const raw = [d.username, d.relation, d.action, (d.content || '').slice(0, 200), d.actorProfileKey || d.actorProfileUrl]
        .map(s => (s || '').trim())
        .join('||');
      let hash = 0;
      for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
      return Math.abs(hash).toString(36);
    }

    // Scroll panel down for next batch
    if (hasMore && panel.scrollHeight > panel.clientHeight + 10) {
      panel.scrollTop = panel.scrollTop + panel.clientHeight * 0.8;
    }

    return { ok: true, data: { notifications: items, hasNew: hasMore }, _diag: { panelFound: true, candidateCount: listItems.length, skipped: diagSkipped.slice(0, 20), parsedCount: items.length, panelStructure: diagPanelStructure } };
  });

  const diag = result._diag;
  if (diag) {
    if (!diag.panelFound) {
      console.error('[notify-page] 诊断: 未找到通知面板');
    } else {
      console.error(`[notify-page] 诊断: 面板候选元素 ${diag.candidateCount}, 解析成功 ${diag.parsedCount}, 跳过 ${diag.skipped.length}`);
      if (diag.panelStructure) {
        console.error(`[notify-page] 诊断: 面板子元素 ${diag.panelStructure.childCount} 个`);
        for (const s of diag.panelStructure.samples) {
          console.error(`[notify-page]   <${s.tag}> class="${s.cls}" text="${s.text}" children=${s.childCount}`);
        }
        for (const d of diag.panelStructure.deeper) {
          console.error(`[notify-page]     <${d.tag}> class="${d.cls}" text="${d.text}"`);
        }
      }
      for (const s of diag.skipped.slice(0, 5)) {
        console.error(`[notify-page]   跳过: ${s.reason} → ${s.text || s.username || ''}`);
      }
    }
  }

  return result;
}

/**
 * Click the profile link of a specific notification item.
 * Uses precise matching based on full event context (name + relation + action + timeText)
 * to avoid mis-clicking on wrong users with similar names.
 *
 * @param {Page} page
 * @param {Object} eventCtx - { username, relation, action, timeText, notificationItemKey, rawText }
 * @returns {Promise<boolean>}
 */
export async function clickLikeProfileLink(page, eventCtx) {
  // Accept both old-style (string username) and new-style (object context)
  const ctx = typeof eventCtx === 'string' ? { username: eventCtx } : eventCtx;
  const { username, relation, action, timeText, notificationItemKey } = ctx;
  const shortName = (username || '').slice(0, 20);

  const result = await page.evaluate(({ name, rel, act, time, itemKey }) => {
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

    // Simple hash for in-browser notification item matching
    function makeItemKey(d) {
      const raw = [d.username, d.relation, d.action, d.content, d.time, d.profileKey]
        .map(s => (s || '').trim())
        .join('||');
      let hash = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        hash = ((hash << 5) - hash) + c;
        hash |= 0;
      }
      return Math.abs(hash).toString(36);
    }

    const panel = findNotificationPanel();
    if (!panel) return { clicked: false, reason: 'panel-not-found' };

    const items = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');

    // Phase 1: try precise match using notificationItemKey (if available)
    if (itemKey) {
      for (const itemEl of items) {
        const text = (itemEl.innerText || '').trim();
        if (!text.includes(name)) continue;

        // Extract matching metadata from this item for comparison
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const itemUsername = lines[0] || '';
        const itemRel = ['朋友', '互相关注'].includes(lines[1]) ? lines[1] : '';
        const hasAction = act ? text.includes(act) : true;
        const hasTime = time ? text.includes(time) : true;

        // Build candidate key
        const candidateKey = makeItemKey({
          username: itemUsername,
          relation: itemRel,
          action: act,
          content: text.slice(0, 200),
          time: time,
          profileKey: '',
        });

        // Must match username AND at least one of: exact itemKey, action text, or time text
        if (candidateKey === itemKey || (hasAction && hasTime)) {
          // Try avatar first
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

          // Fallback: click any user link in the item
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

    // Phase 2: fallback — username + action + time matching (still stricter than name-only)
    for (const itemEl of items) {
      const text = (itemEl.innerText || '').trim();
      if (!text.includes(name)) continue;

      // Require at least action or time match when available
      if (act && !text.includes(act)) continue;
      if (time && !text.includes(time)) continue;
      // If relation provided, prefer matching items
      if (rel && (rel === 'friend' || rel === 'mutual')) {
        const relText = rel === 'friend' ? '朋友' : '互相关注';
        if (!text.includes(relText)) continue;
      }

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

        // Click the entire item row to navigate to comment
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
