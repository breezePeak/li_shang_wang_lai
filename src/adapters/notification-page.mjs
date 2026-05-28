/**
 * Notification panel adapter — hover bell icon, extract notification items
 * Panel appears on mouse hover over svg.LtuRRess on /user/self
 */

const SELF_URL = 'https://www.douyin.com/user/self';

export async function ensureNotificationPageReady(page) {
  await page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('[notify-page] 等待页面加载...');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('[notify-page] 页面就绪');
}

export async function openNotificationPanel(page) {
  try {
    console.log('[notify-page] 定位通知铃铛...');

    // Strategy 1: hover svg.LtuRRess
    const bell = page.locator('svg.LtuRRess').first();
    try {
      await bell.waitFor({ state: 'attached', timeout: 5000 });
      await bell.hover({ timeout: 3000 });
      const found = await waitForPanelContent(page);
      if (found) {
        console.log('[notify-page] ✅ hover 铃铛触发了通知面板');
        return true;
      }
    } catch {
      console.log('[notify-page] hover 铃铛失败');
    }

    // Strategy 2: click the data-e2e parent container
    try {
      const bellBtn = page.locator('div[data-e2e]:has(svg.LtuRRess)').first();
      await bellBtn.click({ timeout: 5000 });
      const found = await waitForPanelContent(page);
      if (found) {
        console.log('[notify-page] ✅ click data-e2e 容器触发了通知面板');
        return true;
      }
    } catch {
      console.log('[notify-page] click 容器失败');
    }

    // Strategy 3: fallback — scan top nav icons
    console.log('[notify-page] 降级扫描顶部图标...');
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
        console.log(`[notify-page] ✅ hover #${i+1} 触发: ${c.class.slice(0, 30)}`);
        return true;
      }
    }

    console.log('[notify-page] 所有策略均未触发通知面板');
    return false;
  } catch (err) {
    console.log('[notify-page] 异常:', err.message);
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

/**
 * Close the notification panel by moving mouse away
 */
export async function closeNotificationPanel(page) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

/**
 * Extract notification items from the open notification panel.
 * Each item: { username, relation, action, content, timeText }
 * 
 * Uses innerText matching pattern:
 *   [username]
 *   [relation or empty]
 *   [action+content or content+action]
 */
export async function scrollAndLoadAllNotifications(page) {
  for (let round = 0; round < 10; round++) {
    const scrolled = await page.evaluate(() => {
      const panel = findNotificationPanel();
      if (!panel) return false;
      if (panel.scrollHeight > panel.clientHeight + 10) {
        panel.scrollTop = panel.scrollHeight;
        return true;
      }
      return false;

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
    });

    if (!scrolled) break;
    await page.waitForTimeout(600);
  }
}

export async function extractNotifications(page) {
  await scrollAndLoadAllNotifications(page);

  return await page.evaluate(() => {
    const items = [];
    const panel = findNotificationPanel();
    if (!panel) return items;

    const skipSet = new Set(['互动消息', '全部消息', '点击加载更多', '加载更多', '没有更多了', '暂无消息', '推荐了你的视频']);

    // Find all list-item-like children
    const listItems = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"], [class*="list"] > *');
    const actionPatterns = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];
    const timePattern = /^(\d{2}:\d{2}|\d+[秒分时天周月年]前|\d{2}-\d{2}|\d+月\d+日|昨天\s?\d{2}:\d{2}|星期\S)$/;
    const relationMap = { '朋友': 'friend', '互相关注': 'mutual' };

    for (const itemEl of listItems) {
      const text = (itemEl.innerText || '').trim();
      if (text.length < 3 || skipSet.has(text)) continue;

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      // Parse lines: username [relation] action [content] time
      let idx = 0;
      const username = lines[idx];
      if (!username || username.length > 40 || timePattern.test(username) || relationMap[username] || skipSet.has(username)) continue;
      idx++;

      let relation = 'unknown';
      if (idx < lines.length && relationMap[lines[idx]]) {
        relation = relationMap[lines[idx]];
        idx++;
      }

      // Find action line
      let eventType = '', action = '', content = '';
      for (let k = idx; k < lines.length; k++) {
        for (const pat of actionPatterns) {
          if (lines[k].includes(pat)) {
            action = pat;
            eventType = pat.includes('赞了') ? 'like' : 'comment';
            if (k > idx) {
              content = lines.slice(idx, k).join(' ');
            }
            idx = k + 1;
            break;
          }
        }
        if (eventType) break;
      }
      if (!eventType) continue;

      // Find time
      let timeText = '';
      for (let k = idx; k < lines.length; k++) {
        if (timePattern.test(lines[k])) {
          timeText = lines[k];
          break;
        }
      }

      items.push({
        username: username.slice(0, 50),
        relation,
        eventType,
        action,
        content: content.slice(0, 300),
        timeText,
      });
    }

    return items;
  });
}

export async function clickLikeProfileLink(page, username) {
  const shortName = username.slice(0, 20);

  const result = await page.evaluate((name) => {
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

    const panel = findNotificationPanel();
    if (!panel) return { clicked: false, reason: 'panel-not-found' };

    const items = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');
    for (const item of items) {
      const text = (item.innerText || '').trim();
      if (!text.includes(name)) continue;

      const imgs = item.querySelectorAll('img');
        for (const img of imgs) {
          if (img.offsetHeight > 0) {
            let clickTarget = img;
            // Try clicking the img's parent anchor/link wrapper
            for (let i = 0; i < 3 && clickTarget; i++) {
              if (clickTarget.tagName === 'A' || clickTarget.getAttribute('href')) {
                clickTarget.click();
                return { clicked: true, method: 'avatar-link', text: text.slice(0, 60) };
              }
              clickTarget = clickTarget.parentElement;
            }
            // Fallback: click the image directly
            img.click();
            return { clicked: true, method: 'avatar-image', text: text.slice(0, 60) };
          }
        }

        // Fallback: click any link in the item
        const links = item.querySelectorAll('a[href]');
        for (const link of links) {
          if (link.offsetHeight > 0 && link.getAttribute('href').includes('/user/')) {
            link.click();
            return { clicked: true, method: 'user-link', text: text.slice(0, 60) };
          }
        }
      }
    return { clicked: false };
  }, shortName);

  if (result.clicked) {
    console.log(`[notify-page] 点击 ${username} 的头像 (${result.method})`);
    await page.waitForTimeout(3000);
    return true;
  }

  console.log(`[notify-page] 未找到 ${username} 的通知条目`);
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
    console.log(`[notify-page] 点击 ${username} 的评论通知`);
    await page.waitForTimeout(3000);
    return true;
  }

  return false;
}
