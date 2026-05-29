import { wait } from '../utils/wait.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

const COMMENT_PAGE_URL = 'https://creator.douyin.com/creator-micro/interactive/comment';

export async function ensureCommentPageReady(page, options = {}) {
  const { timeoutMs = 30000 } = options;

  const currentUrl = page.url();

  if (currentUrl.includes('passport') || currentUrl.includes('login')) {
    return blocking(RESULT_CODES.LOGIN_REQUIRED, '页面被重定向到登录页，请先扫码登录', { data: { currentUrl } });
  }

  if (!currentUrl.includes('creator.douyin.com/creator-micro/interactive')) {
    console.error('[comment-page] 导航到评论管理页...');
    try {
      await page.goto(COMMENT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (err) {
      return blocking(RESULT_CODES.NAVIGATION_TIMEOUT, `页面导航超时: ${err.message}`, { data: { url: COMMENT_PAGE_URL } });
    }
  } else {
    console.error('[comment-page] 已在评论页，跳过导航');
  }

  await page.waitForTimeout(2000);

  const pageState = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const url = window.location.href;

    if (url.includes('passport') || url.includes('login')) {
      return { state: 'login-required' };
    }
    if (text.includes('选择作品')) {
      return { state: 'ready' };
    }
    if (text.includes('评论管理')) {
      return { state: 'ready' };
    }
    return { state: 'unknown', preview: text.slice(0, 200) };
  });

  if (pageState.state === 'login-required') {
    return blocking(RESULT_CODES.LOGIN_REQUIRED, '页面需要登录，请先扫码登录');
  }

  if (pageState.state === 'ready') {
    return success({ pageState: pageState.state });
  }

  const selectWorkBtn = page.locator('button:has-text("选择作品")').first();
  try {
    await selectWorkBtn.waitFor({ state: 'visible', timeout: 10000 });
    return success({ pageState: 'ready' });
  } catch {
    return blocking(
      RESULT_CODES.WRONG_PAGE,
      `当前页面不是评论管理页。URL: ${page.url().slice(0, 100)}。请确认已登录并手动导航到评论管理页。`,
      { data: { url: page.url(), pagePreview: pageState.preview || '' } }
    );
  }
}

export async function waitForCommentsArea(page, timeoutMs = 15000) {
  const candidates = [
    page.locator('div:has-text("回复")').first(),
    page.locator('button:has-text("回复")').first(),
  ];

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const loc of candidates) {
      if (await loc.isVisible().catch(() => false)) {
        return success({ pageState: 'comments-visible' });
      }
    }
    await wait(300);
  }

  const pageText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300));
  if (pageText.includes('暂无评论') || pageText.includes('还没有评论') || pageText.includes('快来看看')) {
    return success({ pageState: 'empty-comments' });
  }

  const hasAnyReply = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if ((el.innerText || '').trim() === '回复' && el.offsetHeight > 0) return true;
    }
    return false;
  });

  if (hasAnyReply) {
    return success({ pageState: 'comments-visible' });
  }

  return blocking(
    RESULT_CODES.COMMENT_LIST_NOT_FOUND,
    '未找到评论列表。可能未选择作品或页面结构发生变化。',
    { data: { pagePreview: pageText } }
  );
}

export async function scrollToLoadAllComments(page, { maxRound = 50, loadTimeout = 5000 } = {}) {
  console.error('[comment-page] 滚动加载所有评论...');

  let prevCount = 0;
  let noNewRounds = 0;

  for (let round = 0; round < maxRound; round++) {
    const scrolled = await page.evaluate(() => {
      const all = document.querySelectorAll('*');

      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.x < 200 || rect.height < 300 || rect.width < 400) continue;
        const style = window.getComputedStyle(el);
        const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto';
        if (!hasOverflow) continue;
        if (el.scrollHeight <= el.clientHeight) continue;
        el.scrollTop = el.scrollHeight;
        return 'overflow-container';
      }

      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.x < 200 || rect.height < 300 || rect.width < 400) continue;
        if (el.scrollHeight > el.clientHeight + 50) {
          el.scrollTop = el.scrollHeight;
          return 'large-container';
        }
      }

      return null;
    });

    if (!scrolled) {
      await page.mouse.wheel(0, 500);
    }

    const currentCount = await page.evaluate(() => {
      let count = 0;
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if ((el.innerText || '').trim() === '回复' && el.offsetHeight > 0) count++;
      }
      return count;
    });

    if (currentCount > prevCount) {
      console.error(`[comment-page]   已加载: ${currentCount} 条评论`);
      prevCount = currentCount;
      noNewRounds = 0;
      await page.waitForTimeout(200);
      continue;
    }

    try {
      await page.waitForFunction(
        (prev) => {
          let count = 0;
          const all = document.querySelectorAll('*');
          for (const el of all) {
            if ((el.innerText || '').trim() === '回复' && el.offsetHeight > 0) count++;
          }
          return count > prev;
        },
        currentCount,
        { timeout: loadTimeout, polling: 500 }
      );
      noNewRounds = 0;
    } catch {
      noNewRounds++;
      if (noNewRounds >= 4) {
        console.error(`[comment-page]   连续 ${noNewRounds} 轮无新内容，停止滚动，共 ${prevCount} 条`);
        break;
      }
    }

    await page.waitForTimeout(200);
  }

  const finalCount = await page.evaluate(() => {
    let count = 0;
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if ((el.innerText || '').trim() === '回复' && el.offsetHeight > 0) count++;
    }
    return count;
  });

  return success({ loadedCount: finalCount });
}

export async function extractComments(page) {
  // Scroll to load all comments first
  await scrollToLoadAllComments(page);

  await page.waitForTimeout(1500);

  const comments = await page.evaluate(() => {
    const comments = [];

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.children.length > 3) return NodeFilter.FILTER_SKIP;
          const text = (node.innerText || '').trim();
          if (text === '回复') return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    const replyElements = [];
    while (walker.nextNode()) {
      replyElements.push(walker.currentNode);
    }

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
        let container = replyBtn.parentElement;
        for (let i = 0; i < 8 && container && container !== document.body; i++) {
          if (container.children.length >= 3) {
            const textLen = (container.innerText || '').length;
            if (textLen > 10 && textLen < 2000) break;
          }
          container = container.parentElement;
        }
        if (!container || container === document.body) continue;

        const containerText = container.innerText || '';
        const lines = containerText.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) continue;

        const username = lines.find(l =>
          l.length > 1 && l.length < 40 &&
          !/^\d+$/.test(l) &&
          !['回复', '删除', '举报', '已回复'].includes(l) &&
          !l.startsWith('http')
        ) || '';

        if (username && seenUsernames.has(username)) continue;
        if (username) seenUsernames.add(username);

        const timeText = lines.find(l =>
          /\d{2}:\d{2}/.test(l) || /\d+月\d+日/.test(l) || /^\d+[秒分时天]前/.test(l)
        ) || '';

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

  return success({ comments, count: comments.length });
}

export async function getSelectedWorkTitle(page) {
  try {
    const title = await page.evaluate(() => {
      const selectBtn = Array.from(document.querySelectorAll('button, span, div')).find(el =>
        (el.innerText || '').trim() === '选择作品'
      );
      if (!selectBtn) return '';

      let panel = selectBtn.parentElement;
      for (let i = 0; i < 6 && panel; i++) {
        const text = panel.innerText || '';
        if (text.includes('发布于') && text.length > 20 && text.length < 2000) break;
        panel = panel.parentElement;
      }
      if (!panel) return '';

      const lines = (panel.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

      const publishIdx = lines.findIndex(l => l.startsWith('发布于'));
      if (publishIdx < 0) return '';

      for (let i = publishIdx - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.length > 5 &&
            !['选择作品', '评论管理', '发送', '全部评论', '全部人群', '最新发布', '未回复', '已回复'].includes(line) &&
            !line.startsWith('http')) {
          return line.slice(0, 120);
        }
      }

      return '';
    });

    return success({ title, found: Boolean(title) });
  } catch {
    return success({ title: '', found: false });
  }
}

export async function openReplyBox(page, match) {
  const target = typeof match === 'string' ? match : (match.commentText || '');
  const actorName = typeof match === 'object' ? match.actorName : null;
  const eventTimeText = typeof match === 'object' ? match.eventTimeText : null;

  try {
    const maxScrollRounds = 30;

    for (let round = 0; round < maxScrollRounds; round++) {
      // Single page.evaluate: collect → match → click all in one atomic operation.
      // No string-based dedup; DOM elements matched by container position.
      const result = await page.evaluate(({ target, actorName, eventTimeText }) => {
        // Collect all comment containers that match commentText AND have a reply button.
        // NO string dedup — two identical texts on different DOM nodes are distinct candidates.
        const candidates = [];

        // Find all comment-content elements
        const contentEls = document.querySelectorAll('[class*="comment-content"]');
        for (const el of contentEls) {
          if (el.offsetHeight === 0) continue;
          const text = (el.innerText || '').trim();
          if (!text.includes(target)) continue;

          // Walk up to find reply button
          let parent = el.parentElement;
          let replyBtn = null;
          for (let p = 0; p < 3 && parent && parent !== document.body && !replyBtn; p++) {
            const opsEl = parent.querySelector('[class*="operations"]');
            if (opsEl) {
              const items = opsEl.querySelectorAll('[class*="item"]');
              for (const item of items) {
                const itemText = (item.innerText || '').trim();
                if (itemText === '回复' || itemText.startsWith('回复')) {
                  replyBtn = item;
                  break;
                }
              }
            }
            if (!replyBtn) parent = parent.parentElement;
          }

          if (!replyBtn) continue;

          // Get the full container text for actor/event matching
          const containerEl = el.parentElement?.closest('[class*="comment"]') || el;
          const containerText = (containerEl.innerText || '').trim();

          candidates.push({
            el: el,
            replyBtn: replyBtn,
            containerText: containerText,
            contentText: text,
          });
        }

        // If no match via content class, try button walkup
        if (candidates.length === 0) {
          const allEl = document.querySelectorAll('*');
          for (const el of allEl) {
            if (el.offsetHeight === 0) continue;
            if ((el.innerText || '').trim() !== '回复') continue;
            if (el.children.length > 2) continue;
            const btnRect = el.getBoundingClientRect();
            if (btnRect.y < 150) continue;

            let container = el.parentElement;
            for (let level = 0; level < 3 && container && container !== document.body; level++) {
              const ct = (container.innerText || '').trim();
              if (ct.length > 10 && ct.length < 500 && ct.includes(target)) {
                candidates.push({
                  el: container,
                  replyBtn: el,
                  containerText: ct,
                  contentText: ct,
                });
                break;
              }
              container = container.parentElement;
            }
          }
        }

        if (candidates.length === 0) {
          return { found: false, reason: 'not_found' };
        }

        // Filter by actorName if provided
        let filtered = candidates;
        if (actorName) {
          filtered = candidates.filter(c => c.containerText.includes(actorName));
          if (filtered.length === 0) {
            return { found: false, reason: 'actor_not_verified', total: candidates.length };
          }
        }

        // Filter by eventTimeText — mandatory when provided, regardless of candidate count.
        // Prevents mis-clicking when same actor has same commentText at different times.
        if (eventTimeText) {
          const timeFiltered = filtered.filter(c => c.containerText.includes(eventTimeText));
          if (timeFiltered.length === 0) {
            return { found: false, reason: 'time_not_verified', total: filtered.length };
          }
          filtered = timeFiltered;
        }

        // Uniqueness check
        if (filtered.length > 1) {
          return { found: false, reason: 'not_unique', total: filtered.length };
        }

        // Exactly 1 match — click it NOW (same evaluate, same DOM reference)
        const chosen = filtered[0];
        chosen.el.scrollIntoView({ behavior: 'instant', block: 'center' });
        chosen.replyBtn.click();
        return { found: true, clicked: true, matchText: chosen.contentText.slice(0, 60) };

      }, { target, actorName, eventTimeText });

      if (result.found && result.clicked) {
        console.error(`[comment-page] 唯一定位成功，匹配: "${result.matchText}"`);
        await page.waitForTimeout(1500);
        return success({ clicked: true });
      }

      if (result.reason === 'not_unique') {
        return blocking(
          RESULT_CODES.COMMENT_MATCH_NOT_UNIQUE,
          `评论 "${target.slice(0, 40)}" 匹配到 ${result.total} 条候选，无法唯一定位。`,
          { recoverable: true, data: { matchCount: result.total, target: target.slice(0, 60) } }
        );
      }

      if (result.reason === 'actor_not_verified') {
        return blocking(
          RESULT_CODES.COMMENT_MATCH_NOT_UNIQUE,
          `评论 "${target.slice(0, 40)}" 匹配到 ${result.total} 条，但均不含用户 "${actorName}"，无法确认目标。`,
          { recoverable: true, data: { matchCount: result.total, target: target.slice(0, 60), actorName } }
        );
      }

      // Not found or time not verified — scroll and try again
      if (round === maxScrollRounds - 1) {
        if (result.reason === 'time_not_verified') {
          return blocking(
            RESULT_CODES.COMMENT_MATCH_NOT_UNIQUE,
            `已找到匹配 "${target.slice(0, 40)}" + "${actorName}" 的评论，但均不含目标时间 "${eventTimeText}"，无法确认目标。`,
            { recoverable: true, data: { matchCount: result.total, target: target.slice(0, 60), actorName, eventTimeText } }
          );
        }
        return blocking(
          RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND,
          `滚动${maxScrollRounds}轮后未找到匹配 "${target.slice(0, 40)}" 的评论`,
          { data: { preview: target.slice(0, 40), rounds: maxScrollRounds } }
        );
      }

      await scrollPage(page);
    }

    return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, '滚动查找超时', { data: {} });
  } catch (err) {
    console.error('[comment-page] openReplyBox 异常:', err.message);
    return blocking(
      RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND,
      `打开回复框异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

async function scrollPage(page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.x < 200 || rect.height < 300 || rect.width < 400) continue;
      const style = window.getComputedStyle(el);
      const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto';
      if (!hasOverflow) continue;
      if (el.scrollHeight <= el.clientHeight) continue;
      el.scrollTop = el.scrollHeight;
      return;
    }
    window.scrollBy(0, 500);
  });
  await page.waitForTimeout(1000);
}

export async function fillReplyText(page, replyText) {
  try {
    const filled = await page.evaluate((text) => {
      // Find the reply-content container with a visible input
      const replyContainers = document.querySelectorAll('[class*="reply-content"]');
      for (const container of replyContainers) {
        if (container.offsetHeight === 0) continue;
        const input = container.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
        if (!input || input.offsetHeight === 0) continue;

        input.focus();
        input.innerText = text;
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true, method: 'reply-content-class' };
      }

      // Fallback: any visible contenteditable
      const inputs = document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]');
      for (const el of inputs) {
        if (el.offsetHeight === 0) continue;
        el.focus();
        el.innerText = text;
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true, method: 'fallback-visible' };
      }

      return { filled: false };
    }, replyText);

    if (filled && filled.filled) {
      console.error(`[comment-page] 填写回复文字成功 (${filled.method})`);
      await page.waitForTimeout(800);
      return success({ filled: true, method: filled.method });
    }

    return blocking(
      RESULT_CODES.COMMENT_INPUT_NOT_FOUND,
      '找不到回复输入框',
      { data: {} }
    );
  } catch (err) {
    return blocking(
      RESULT_CODES.COMMENT_INPUT_NOT_FOUND,
      `填写回复文字异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function clickSendReply(page) {
  try {
    async function findAndClick() {
      return await page.evaluate(() => {
        // Find the reply-content container with a filled input
        const replyContainers = document.querySelectorAll('[class*="reply-content"]');
        for (const container of replyContainers) {
          if (container.offsetHeight === 0) continue;
          const input = container.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
          if (!input || input.offsetHeight === 0) continue;
          const inputText = (input.innerText || input.value || '').trim();
          if (inputText.length === 0) continue;

          // Find 发送 button within this container (prefer <button>)
          const buttons = container.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.offsetHeight === 0) continue;
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            if ((btn.innerText || '').trim() === '发送') {
              btn.click();
              return { ok: true, method: 'reply-content-class' };
            }
          }

          // Fallback: any element with text 发送 inside the container
          const allInContainer = container.querySelectorAll('*');
          for (const el of allInContainer) {
            if (el.offsetHeight === 0) continue;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            if ((el.innerText || '').trim() !== '发送') continue;
            el.click();
            return { ok: true, method: 'reply-content-class-fallback' };
          }
        }

        return { ok: false, reason: 'no-send-btn-in-reply-container' };
      });
    }

    let result = await findAndClick();
    if (!result.ok && result.reason === 'no-send-btn-in-reply-container') {
      console.error('[comment-page] 发送按钮未找到或未启用，等待2秒重试...');
      await page.waitForTimeout(2000);
      result = await findAndClick();
    }

    if (!result.ok) {
      return blocking(
        RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND,
        `找不到发送按钮: ${result.reason}`,
        { data: { reason: result.reason } }
      );
    }

    console.error(`[comment-page] 点击发送按钮成功 (${result.method})`);
    await page.waitForTimeout(2000);
    return success({ clicked: true });
  } catch (err) {
    return blocking(
      RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND,
      `找不到发送按钮或点击失败: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function confirmReplySucceeded(page) {
  try {
    const confirmed = await page.evaluate(() => {
      const text = document.body?.innerText || '';

      if (text.includes('已回复') || text.includes('回复成功') || text.includes('评论成功')) {
        return { confirmed: true, signal: 'success-indicator' };
      }

      const inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      const visibleInputs = Array.from(inputs).filter(el => el.offsetHeight > 0);

      if (visibleInputs.length === 0) {
        return { confirmed: true, signal: 'input-hidden' };
      }

      const hasContent = visibleInputs.some(el => (el.value || el.innerText || '').trim().length > 0);
      if (!hasContent) {
        return { confirmed: true, signal: 'input-cleared' };
      }

      return { confirmed: false, signal: 'input-still-has-content', count: visibleInputs.length };
    });

    if (confirmed.confirmed) {
      return success({ signal: confirmed.signal });
    }

    return blocking(
      RESULT_CODES.COMMENT_SEND_UNCONFIRMED,
      '点击发送后无法确认回复成功，请检查页面状态',
      { data: { signal: confirmed.signal } }
    );
  } catch (err) {
    return blocking(
      RESULT_CODES.COMMENT_SEND_UNCONFIRMED,
      `确认回复异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

export async function sendReply(page, replyText) {
  const fillResult = await fillReplyText(page, replyText);
  if (!fillResult.ok) return fillResult;

  const clickResult = await clickSendReply(page);
  if (!clickResult.ok) return clickResult;

  const confirmResult = await confirmReplySucceeded(page);
  return confirmResult;
}

export async function selectWorkByTitle(page, workTitle) {
  if (!workTitle) {
    return blocking(RESULT_CODES.BLOCKED, '作品标题为空，无法选择作品', { data: { step: 'select-work' } });
  }

  const shortTitle = workTitle.slice(0, 30);
  console.error(`[comment-page] 目标作品: "${workTitle.slice(0, 50)}"`);

  // Check current selection
  const currentResult = await getSelectedWorkTitle(page);
  if (currentResult.ok && currentResult.data.found) {
    const currentTitle = currentResult.data.title;
    if (currentTitle.includes(shortTitle) || shortTitle.includes(currentTitle)) {
      console.error(`[comment-page] 当前已是目标作品: "${currentTitle.slice(0, 50)}"`);
      return success({ alreadySelected: true, title: currentTitle });
    }
    console.error(`[comment-page] 当前作品: "${currentTitle.slice(0, 50)}"，需要切换`);
  }

  // Step 1: Click "选择作品" button to open work selector panel
  console.error('[comment-page] 点击"选择作品"按钮...');
  try {
    // Try multiple strategies to find and click the button
    const selectBtn = page.locator('button:has-text("选择作品"), [role="button"]:has-text("选择作品")').first();
    await selectBtn.waitFor({ state: 'visible', timeout: 5000 });
    await selectBtn.click({ timeout: 5000 });
    console.error('[comment-page] 已点击"选择作品"');
  } catch (err) {
    // Fallback: try clicking any element containing "选择作品"
    try {
      const fallback = page.locator('text="选择作品"').first();
      await fallback.click({ timeout: 3000 });
      console.error('[comment-page] 通过 text locator 点击"选择作品"');
    } catch {
      return blocking(
        RESULT_CODES.BLOCKED,
        '找不到"选择作品"按钮，请确认在评论管理页',
        { data: { step: 'click-select-work' } }
      );
    }
  }

  // Step 2: Wait for the work selector panel to appear
  console.error('[comment-page] 等待作品选择面板出现...');
  await page.waitForTimeout(2000);

  // Step 3: Find and click the target work in the panel
  const clickResult = await page.evaluate((target) => {
    // Look for elements whose text matches the target title.
    // Prefer elements that are in popup/overlay/modal panels (higher z-index or position).
    const candidates = [];
    const all = document.querySelectorAll('*');

    for (const el of all) {
      if (el.offsetHeight === 0 || el.offsetWidth === 0) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 3 || text.length > 300) continue;
      if (el.children.length > 10) continue;
      if (!text.includes(target)) continue;

      const rect = el.getBoundingClientRect();
      // Skip elements in the main header area (y < 60)
      if (rect.y < 60 && rect.height < 40) continue;

      // Skip elements that are too small (likely icons)
      if (rect.width < 50 && rect.height < 20) continue;

      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex) || 0;

      candidates.push({
        text: text.slice(0, 80),
        tag: el.tagName,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        z: zIndex,
        hasPointer: style.cursor === 'pointer',
      });
    }

    if (candidates.length === 0) return { found: false, total: 0 };

    // Sort by: prefer clickable elements with higher z-index (popup panels)
    candidates.sort((a, b) => {
      if (a.hasPointer !== b.hasPointer) return b.hasPointer ? 1 : -1;
      if (a.z !== b.z) return b.z - a.z;
      return a.y - b.y;
    });

    // Try clicking candidates
    for (const c of candidates.slice(0, 8)) {
      const el = document.elementFromPoint(c.x + Math.min(c.w / 2, 80), c.y + Math.min(c.h / 2, 15));
      if (!el) continue;

      // Walk up to find clickable container
      let clickTarget = el;
      for (let i = 0; i < 8 && clickTarget; i++) {
        const ct = (clickTarget.innerText || '').trim();
        if (ct.includes(target) && ct.length > 3 && ct.length < 500) {
          clickTarget.click();
          return { found: true, text: ct.slice(0, 60), tag: clickTarget.tagName, total: candidates.length };
        }
        clickTarget = clickTarget.parentElement;
      }
    }

    return { found: false, total: candidates.length, sample: candidates.slice(0, 3) };
  }, shortTitle);

  console.error(`[comment-page] 面板扫描结果: ${JSON.stringify(clickResult)}`);

  if (clickResult.found) {
    console.error(`[comment-page] 已点击目标作品: ${clickResult.tag} "${clickResult.text}"`);
    await page.waitForTimeout(3000);

    // Verify
    const verifyResult = await getSelectedWorkTitle(page);
    if (verifyResult.ok && verifyResult.data.found) {
      console.error(`[comment-page] 切换后作品: "${verifyResult.data.title.slice(0, 50)}"`);
      return success({ switchedTo: verifyResult.data.title });
    }

    return success({ switchedTo: 'clicked' });
  }

  // Failed: dump visible text around the click area for debugging
  if (clickResult.total > 0) {
    console.error(`[comment-page] 面板中找到 ${clickResult.total} 个文本匹配候选，但点击失败`);
    console.error(`[comment-page] 候选样本: ${JSON.stringify(clickResult.sample)}`);
  } else {
    const pageText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800));
    console.error(`[comment-page] 面板中未找到匹配。页面文本:\n${pageText.replace(/\n/g, ' | ')}`);
  }

  return blocking(
    RESULT_CODES.BLOCKED,
    `在作品选择面板中未找到 "${workTitle.slice(0, 40)}"。请手动点击选择作品，然后点目标作品，再按 r 重试`,
    { data: { step: 'select-work', targetTitle: workTitle, candidatesFound: clickResult.total } }
  );
}

export { COMMENT_PAGE_URL };
