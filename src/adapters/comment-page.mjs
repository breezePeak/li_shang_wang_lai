import { wait } from '../utils/wait.mjs';

const COMMENT_PAGE_URL = 'https://creator.douyin.com/creator-micro/interactive/comment';

/**
 * Navigate to comment page and wait for it to be ready.
 * If the "选择作品" button is not visible, prompts user to login/navigate.
 */
export async function ensureCommentPageReady(page, options = {}) {
  const { timeoutMs = 30000 } = options;
  
  // Skip navigation if already on the correct page
  const currentUrl = page.url();
  if (currentUrl.includes('creator.douyin.com/creator-micro/interactive')) {
    console.log('[comment-page] 已在评论页，跳过导航');
    return;
  }
  
  await page.goto(COMMENT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  const selectWorkBtn = page.locator('button:has-text("选择作品")').first();
  try {
    await selectWorkBtn.waitFor({ state: 'visible', timeout: 10000 });
    return;
  } catch {
    console.log('[comment-page] 未检测到评论页入口，请确认已登录并手动导航到评论管理页。');
    console.log('[comment-page] URL:', COMMENT_PAGE_URL);
  }
}

/**
 * Wait for the comment list area to be visible.
 * Uses text-based locators (more stable than CSS classes).
 */
export async function waitForCommentsArea(page, timeoutMs = 15000) {
  const candidates = [
    page.locator('div:has-text("回复")').first(),
    page.locator('button:has-text("回复")').first(),
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const loc of candidates) {
      if (await loc.isVisible().catch(() => false)) {
        return;
      }
    }
    await wait(300);
  }
  console.warn('[comment-page] 评论列表区域未在超时内出现，继续尝试扫描...');
}

/**
 * Extract comments from the current page.
 * Returns an array of comment objects: { username, content, timeText, likeCount, hasReplied }
 *
 * Strategy: Find all elements containing "回复" text (action buttons), then walk up to parent containers
 * to extract username, date, content. This is more robust than class-based selectors.
 */
export async function extractComments(page) {
  // Small wait to let React finish rendering comment list
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const comments = [];

    // Strategy: find elements whose innerText (user-visible text) is exactly "回复"
    // Use a TreeWalker for efficiency — only check leaf-level elements
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          // Only consider elements with no or few children (leaf/near-leaf)
          if (node.children.length > 3) return NodeFilter.FILTER_SKIP;
          const text = (node.innerText || '').trim();
          // Match: exact "回复" or just "回复" as the only visible text
          if (text === '回复') return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    const replyElements = [];
    while (walker.nextNode()) {
      replyElements.push(walker.currentNode);
    }

    // Fallback: if TreeWalker found nothing, try broader search
    if (replyElements.length === 0) {
      const all = document.querySelectorAll('button, span, div, a');
      for (const el of all) {
        if (el.children.length <= 2 && (el.innerText || '').trim() === '回复') {
          replyElements.push(el);
        }
      }
    }

    const seenUsernames = new Set();

    for (const replyBtn of replyElements) {
      try {
        // Walk up to find the comment container — look for a container with ≥3 children
        let container = replyBtn.parentElement;
        for (let i = 0; i < 8 && container && container !== document.body; i++) {
          if (container.children.length >= 3) {
            // Check that this container has reasonable amount of text (not the whole page)
            const textLen = (container.innerText || '').length;
            if (textLen > 10 && textLen < 2000) break;
          }
          container = container.parentElement;
        }
        if (!container || container === document.body) continue;

        const containerText = container.innerText || '';
        const lines = containerText.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) continue;

        // Heuristic parsing of the comment container text
        const username = lines.find(l =>
          l.length > 1 && l.length < 40 &&
          !/^\d+$/.test(l) &&
          !['回复', '删除', '举报', '已回复'].includes(l) &&
          !l.startsWith('http')
        ) || '';

        // Skip duplicates
        if (username && seenUsernames.has(username)) continue;
        if (username) seenUsernames.add(username);

        const timeText = lines.find(l =>
          /\d{2}:\d{2}/.test(l) || /\d+月\d+日/.test(l) || /^\d+[秒分时天]前/.test(l)
        ) || '';

        // Content: longest non-action, non-username, non-time line
        const content = lines.find(l =>
          l.length > 2 &&
          l !== username && l !== timeText &&
          !['回复', '删除', '举报', '已回复'].includes(l) &&
          !/^\d+$/.test(l)
        ) || '';

        const hasReplied = lines.some(l => l === '已回复');

        comments.push({
          username: username.slice(0, 50),
          content: content.slice(0, 500),
          timeText: timeText.slice(0, 30),
          likeCount: 0,
          hasReplied,
        });
      } catch {
        // skip malformed entries
      }
    }

    return comments;
  });
}

/**
 * Get the currently selected work title from the page.
 * Strategy: find text between "选择作品" and "发布于" in the main content area,
 * not in the sidebar navigation.
 */
export async function getSelectedWorkTitle(page) {
  try {
    return await page.evaluate(() => {
      // Find the "选择作品" button to anchor our search in the main content area
      const selectBtn = Array.from(document.querySelectorAll('button, span, div')).find(el =>
        (el.innerText || '').trim() === '选择作品'
      );
      if (!selectBtn) return '';

      // Walk up to find the content panel (exclude sidebar)
      let panel = selectBtn.parentElement;
      for (let i = 0; i < 6 && panel; i++) {
        const text = panel.innerText || '';
        if (text.includes('发布于') && text.length > 20 && text.length < 2000) break;
        panel = panel.parentElement;
      }
      if (!panel) return '';

      // Now search within this panel for lines that look like a work title
      const lines = (panel.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

      // Find the "发布于" line's index
      const publishIdx = lines.findIndex(l => l.startsWith('发布于'));
      if (publishIdx < 0) return '';

      // The work title is the line just before "发布于" (or a few lines up)
      for (let i = publishIdx - 1; i >= 0; i--) {
        const line = lines[i];
        // Work title characteristics: longer than 5 chars, not a button label, not a filter
        if (line.length > 5 &&
            !['选择作品', '评论管理', '发送', '全部评论', '全部人群', '最新发布', '未回复', '已回复'].includes(line) &&
            !line.startsWith('http')) {
          return line.slice(0, 120);
        }
      }

      return '';
    });
  } catch {
    return '';
  }
}

/**
 * Find and click the "回复" button for a specific comment.
 * Returns true if the reply input appeared.
 */
export async function openReplyBox(page, commentText) {
  try {
    // First dump what "回复" elements exist on the page
    const replyElements = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (text === '回复' && el.children.length <= 2) {
          results.push({
            tag: el.tagName,
            rect: el.getBoundingClientRect(),
            visible: el.offsetHeight > 0,
          });
        }
      }
      return results;
    });
    
    console.log(`[reply] 页面上找到 ${replyElements.length} 个"回复"元素`);
    
    if (replyElements.length === 0) {
      // Maybe no work selected — check
      const pageText = await page.evaluate(() => {
        const body = document.body;
        return (body?.innerText || '').slice(0, 300);
      });
      console.log(`[reply] 页面文本预览: "${pageText.replace(/\n/g, ' | ')}"`);
      return false;
    }

    const searchText = commentText.slice(0, 30);

    // Find all "回复" elements using Playwright locator
    const replyLocators = page.locator('text="回复"');
    const count = await replyLocators.count();

    for (let i = 0; i < count; i++) {
      const btn = replyLocators.nth(i);
      
      // Walk up to find the comment container
      let container = btn.locator('..');
      for (let level = 0; level < 6; level++) {
        const text = await container.innerText({ timeout: 1000 }).catch(() => '');
        if (text.includes(searchText)) {
          console.log(`[reply] 在第 ${level+1} 层找到匹配，点击回复...`);
          await btn.click({ timeout: 5000 });
          await page.waitForTimeout(1000);
          return true;
        }
        container = container.locator('..');
      }
    }

    console.log(`[reply] 遍历了 ${count} 个"回复"，未匹配 "${searchText}"`);
    // Print first "回复" container text for debug
    if (count > 0) {
      const firstBtn = replyLocators.first();
      let c = firstBtn.locator('..');
      for (let l = 0; l < 6; l++) {
        const t = await c.innerText({ timeout: 500 }).catch(() => '');
        if (t.length > 10) {
          console.log(`[reply] 第一个回复容器(层${l+1}): "${t.slice(0, 100)}"`);
          break;
        }
        c = c.locator('..');
      }
    }
    return false;
  } catch (err) {
    console.log('[reply] openReplyBox 异常:', err.message);
    return false;
  }
}

/**
 * Type reply text into the reply input box and click send.
 * Returns true if send appeared to succeed.
 */
export async function sendReply(page, replyText) {
  try {
    // Find the reply textarea/input (appears after clicking "回复")
    const input = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.click();
    await page.waitForTimeout(300);
    await input.fill(replyText);
    await page.waitForTimeout(500);

    // Click the "发送" or "回复" send button
    const sendBtn = page.locator('button:has-text("发送"), button:has-text("回复"), span:has-text("发送")').first();
    await sendBtn.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    return true;
  } catch (err) {
    console.log(`[reply] 发送失败: ${err.message}`);
    return false;
  }
}

export { COMMENT_PAGE_URL };
