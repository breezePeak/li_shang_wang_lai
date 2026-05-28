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
    // Collect all clickable/hoverable icons in the top nav area (y < 100)
    const candidates = await page.evaluate(() => {
      const all = document.querySelectorAll('header *, nav *, [class*="header"] *, [class*="navbar"] *, [class*="top"] *, [data-e2e]');
      const icons = [];
      const seen = new Set();

      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.y > 120 || rect.x < 200 || rect.width < 10 || rect.height < 10) continue;

        const isHoverable = el.tagName === 'BUTTON' || el.tagName === 'A'
          || el.hasAttribute('data-e2e') || el.getAttribute('role') === 'button'
          || (el.className && typeof el.className === 'string'
            && /icon|btn|button|click|hover|item/i.test(el.className));

        if (!isHoverable) continue;

        const key = `${rect.x.toFixed(0)},${rect.y.toFixed(0)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        icons.push({
          tag: el.tagName,
          id: el.id || '',
          class: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '',
          text: (el.innerText || '').trim().slice(0, 30),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          dataE2e: el.getAttribute('data-e2e') || '',
        });
      }
      return icons.sort((a, b) => b.x - a.x);
    });

    console.log(`[notify-page] 顶部发现 ${candidates.length} 个可交互图标`);

    if (candidates.length === 0) {
      console.log('[notify-page] 无候选图标');
      return false;
    }

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const label = c.dataE2e || c.class.slice(0, 30) || c.text || c.tag;
      console.log(`[notify-page] [${i+1}/${candidates.length}] hover: ${label} (${c.x.toFixed(0)}, ${c.y.toFixed(0)})`);

      await page.mouse.move(c.x, c.y, { steps: 3 });
      await page.waitForTimeout(5000);

      const found = await checkPanelContent(page);
      if (found) {
        console.log(`[notify-page] ✅ 第 ${i+1} 个触发了通知面板! ${label}`);
        return true;
      }
    }

    console.log(`[notify-page] ${candidates.length} 个都试过了，未触发`);
    return false;
  } catch (err) {
    console.log('[notify-page] 异常:', err.message);
    return false;
  }
}

async function checkPanelContent(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (text.startsWith('互动消息') || text.startsWith('全部消息')) {
          return {
            found: true,
            tag: el.tagName,
            className: el.className?.slice(0, 100) || '',
            lineCount: text.split('\n').filter(Boolean).length,
          };
        }
      }
      return { found: false };
    });

    if (result.found) {
      console.log(`[notify-page] 面板已加载! tag=${result.tag} class="${result.className}" lines=${result.lineCount}`);
      return true;
    }
    await page.waitForTimeout(1000);
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
export async function extractNotifications(page) {
  return await page.evaluate(() => {
    const items = [];

    // Find panel by text content
    const all = document.querySelectorAll('*');
    let targetPanel = null;
    for (const el of all) {
      const text = (el.innerText || '').trim();
      if (text.startsWith('互动消息') || text.startsWith('全部消息')) {
        targetPanel = el;
        break;
      }
    }
    if (!targetPanel) return items;

    const lines = (targetPanel.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    
    const actionPatterns = ['赞了你的作品', '赞了你的评论', '评论了你的作品', '回复了你的评论'];
    const skipPatterns = ['互动消息', '全部消息', '点击加载更多', '推荐了你的视频'];
    const timePattern = /^(\d{2}:\d{2}|\d{2}-\d{2}|星期\S)$/;
    const relationSet = new Set(['朋友', '互相关注', '关注']);
    
    let i = 0;
    while (i < lines.length) {
      // Skip known headers and time-like lines
      if (skipPatterns.includes(lines[i]) || timePattern.test(lines[i]) || relationSet.has(lines[i])) { 
        i++; continue; 
      }
      
      // Look for action patterns in next 1-3 lines
      let actionLine = -1;
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        for (const pat of actionPatterns) {
          if (lines[j].includes(pat)) { actionLine = j; break; }
        }
        if (actionLine >= 0) break;
      }
      
      if (actionLine < 0) { i++; continue; }
      
      // Validate: between username and action, there should be at most a relation tag
      const gap = actionLine - i;
      if (gap > 2) { i = actionLine; continue; } // too many lines between, unlikely a user
      
      const username = lines[i];
      const actionFull = lines[actionLine];
      
      // Skip if username looks like time or relation
      if (timePattern.test(username) || relationSet.has(username)) { i++; continue; }
      
      let eventType = '';
      let action = '';
      let content = '';
      
      if (actionFull.includes('赞了你的作品')) {
        eventType = 'like';
        action = '赞了你的作品';
      } else if (actionFull.includes('赞了你的评论')) {
        eventType = 'like';
        action = '赞了你的评论';
      } else if (actionFull.includes('评论了你的作品')) {
        eventType = 'comment';
        action = '评论了你的作品';
        if (actionLine > i + 1 && !actionPatterns.some(p => lines[actionLine - 1].includes(p)) && !timePattern.test(lines[actionLine - 1])) {
          content = lines[actionLine - 1];
        }
      } else if (actionFull.includes('回复了你的评论')) {
        eventType = 'comment';
        action = '回复了你的评论';
        if (actionLine > i + 1) {
          content = lines[actionLine - 1];
        }
      } else {
        i = actionLine + 1; continue;
      }
      
      // Find relation tag
      let relation = 'unknown';
      if (actionLine > i + 1) {
        const mid = lines[i + 1];
        if (mid === '朋友') relation = 'friend';
        else if (mid === '互相关注') relation = 'mutual';
      }
      
      // Find time
      let timeText = '';
      const timeAppended = actionFull.match(/(\d{2}:\d{2}|\d{2}-\d{2}|星期\S)$/);
      if (timeAppended) {
        timeText = timeAppended[1];
      } else if (actionLine + 1 < lines.length) {
        const nextLine = lines[actionLine + 1];
        if (timePattern.test(nextLine)) {
          timeText = nextLine;
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
      
      i = actionLine + (timeText ? 2 : 1);
    }
    
    return items;
  });
}
