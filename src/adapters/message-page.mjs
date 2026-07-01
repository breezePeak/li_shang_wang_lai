const SELF_URL = 'https://www.douyin.com/user/self';
const PRIVATE_MESSAGE_SELECTORS = [
  '[data-e2e="something-button"]:has-text("私信")',
  'li:has-text("私信") [data-e2e="something-button"]',
  'text=/^私信$/',
  '[data-e2e*="private" i]',
  '[data-e2e*="message" i]:has-text("私信")',
  '[aria-label*="私信"]',
  '[title*="私信"]',
];

async function waitForPrivateMessagePanel(page, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      function findPanel() {
        const candidates = [];
        for (const el of document.querySelectorAll('body *')) {
          if (!isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 240 || rect.width > 420 || rect.height < 300) continue;
          if (rect.top > 180 || rect.left < window.innerWidth * 0.68) continue;
          const text = (el.innerText || el.textContent || '').trim();
          const hasSearch = text.includes('搜索');
          const hasRecentTime = /刚刚|\d{1,2}:\d{2}|昨天/.test(text);
          const hasSharePreview = text.includes('[分享用户]') || text.includes('[图片]') || text.includes('[视频]');
          const hasMessageDots = (text.match(/刚刚/g) || []).length >= 2;
          if (hasSearch || (hasRecentTime && (hasSharePreview || hasMessageDots))) {
            candidates.push(rect.width * rect.height);
          }
        }
        return candidates.length > 0;
      }

      return findPanel();
    }).catch(() => false);

    if (exists) return true;
    await page.waitForTimeout(200);
  }

  return false;
}

export async function findPrivateMessageTrigger(page) {
  for (const selector of PRIVATE_MESSAGE_SELECTORS) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        return { locator, selector };
      }
    } catch {}
  }
  return null;
}

export async function openPrivateMessagePanel(page, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const trigger = await findPrivateMessageTrigger(page);
    if (!trigger) {
      await page.waitForTimeout(300);
      continue;
    }

    try {
      await trigger.locator.hover({ timeout: 1500 });
      if (await waitForPrivateMessagePanel(page, { timeoutMs: 1200 })) {
        return { ok: true, method: 'hover', selector: trigger.selector, attempt };
      }
    } catch {}

    try {
      await trigger.locator.click({ timeout: 1500 });
      if (await waitForPrivateMessagePanel(page, { timeoutMs: 1200 })) {
        return { ok: true, method: 'click', selector: trigger.selector, attempt };
      }
    } catch {}

    await page.waitForTimeout(300);
  }

  return { ok: false, reason: 'private_message_panel_not_found' };
}

export async function locateFirstPrivateConversation(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function findPanel() {
      const candidates = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 240 || rect.width > 420 || rect.height < 300) continue;
        if (rect.top > 180 || rect.left < window.innerWidth * 0.68) continue;
        const text = (el.innerText || el.textContent || '').trim();
        const hasSearch = text.includes('搜索');
        const hasRecentTime = /刚刚|\d{1,2}:\d{2}|昨天/.test(text);
        const hasSharePreview = text.includes('[分享用户]') || text.includes('[图片]') || text.includes('[视频]');
        const hasMessageDots = (text.match(/刚刚/g) || []).length >= 2;
        if (hasSearch || (hasRecentTime && (hasSharePreview || hasMessageDots))) {
          candidates.push({ el, area: rect.width * rect.height, right: rect.right });
        }
      }
      candidates.sort((a, b) => (b.area - a.area) || (b.right - a.right));
      return candidates[0]?.el || null;
    }

    const panel = findPanel();
    if (!panel) return { ok: false, reason: 'panel_not_found' };

    const panelRect = panel.getBoundingClientRect();
    const searchNode = panel.querySelector('input[placeholder*="搜索"], [placeholder*="搜索"]');
    const minTop = searchNode
      ? searchNode.getBoundingClientRect().bottom + 8
      : panelRect.top + Math.min(panelRect.height * 0.12, 72);

    const directRows = Array.from(panel.querySelectorAll('[class*="conversationConversationItemwrapper"], [class*="ConversationItemwrapper"]'))
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          rect,
          text: (el.innerText || '').trim(),
        };
      })
      .filter(item =>
        item.text.length >= 2 &&
        item.rect.top >= minTop &&
        item.rect.bottom <= panelRect.bottom + 2 &&
        item.rect.left >= panelRect.left &&
        item.rect.right <= panelRect.right + 2 &&
        item.rect.height >= 48 &&
        item.rect.height <= 160
      )
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));

    if (directRows[0]) {
      const first = directRows[0];
      return {
        ok: true,
        conversation: {
          x: first.rect.left + first.rect.width / 2,
          y: first.rect.top + first.rect.height / 2,
          top: first.rect.top,
          left: first.rect.left,
          width: first.rect.width,
          height: first.rect.height,
          text: first.text.slice(0, 200),
        },
      };
    }

    const rows = [];
    const seen = new Set();
    const avatars = Array.from(panel.querySelectorAll('img'));
    for (const img of avatars) {
      if (!isVisible(img)) continue;
      const imgRect = img.getBoundingClientRect();
      if (!imgRect || imgRect.width <= 8 || imgRect.height <= 8) continue;
      if (imgRect.width < 24 || imgRect.height < 24 || imgRect.width > 96 || imgRect.height > 96) continue;

      let current = img.parentElement;
      for (let i = 0; i < 6 && current && current !== panel; i++) {
        if (!isVisible(current)) {
          current = current.parentElement;
          continue;
        }
        const rect = current.getBoundingClientRect();
        const text = (current.innerText || '').trim();
        if (
          rect.top >= minTop &&
          rect.bottom <= panelRect.bottom + 2 &&
          rect.left >= panelRect.left &&
          rect.right <= panelRect.right + 2 &&
          rect.width >= panelRect.width * 0.58 &&
          rect.height >= 48 &&
          rect.height <= 160 &&
          text.length >= 2
        ) {
          const key = [
            Math.round(rect.left),
            Math.round(rect.top),
            Math.round(rect.width),
            Math.round(rect.height),
          ].join(':');
          if (!seen.has(key)) {
            seen.add(key);
            rows.push({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              text: text.slice(0, 200),
            });
          }
          break;
        }
        current = current.parentElement;
      }
    }

    rows.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const first = rows[0];
    if (!first) return { ok: false, reason: 'conversation_not_found' };
    return { ok: true, conversation: first };
  });
}

export async function findPrivateMessageMenuAction(page, label, { anchor = null } = {}) {
  return await page.evaluate(({ targetLabel, anchorPoint }) => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (text !== targetLabel) continue;
      const rect = el.getBoundingClientRect();
      const dx = anchorPoint ? Math.abs((rect.left + rect.width / 2) - anchorPoint.x) : 0;
      const dy = anchorPoint ? Math.abs((rect.top + rect.height / 2) - anchorPoint.y) : 0;
      candidates.push({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        distance: dx + dy,
      });
    }

    candidates.sort((a, b) => {
      if (anchorPoint) return a.distance - b.distance;
      return (a.top - b.top) || (b.width * b.height - a.width * a.height);
    });
    const target = candidates[0];
    if (!target) return { ok: false, reason: 'menu_action_not_found', label: targetLabel };
    return { ok: true, target };
  }, { targetLabel: label, anchorPoint: anchor });
}

export async function confirmPrivateMessageDeletion(page) {
  const found = await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const buttons = [];
    for (const el of document.querySelectorAll('button, div, span, a')) {
      if (!isVisible(el)) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (text !== '确认删除') continue;
      let current = el;
      let insideDialog = false;
      for (let i = 0; i < 5 && current && current !== document.body; i++) {
        const dialogText = (current.innerText || current.textContent || '').trim();
        if (dialogText.includes('确认删除') && dialogText.includes('聊天')) {
          insideDialog = true;
          break;
        }
        current = current.parentElement;
      }
      if (!insideDialog) continue;
      const rect = el.getBoundingClientRect();
      buttons.push({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        top: rect.top,
        left: rect.left,
      });
    }

    buttons.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const target = buttons[0];
    if (!target) return { ok: false, reason: 'confirm_delete_not_found' };
    return { ok: true, target };
  });

  if (!found.ok) return found;
  await page.mouse.move(found.target.x, found.target.y);
  await page.mouse.click(found.target.x, found.target.y);
  return { ok: true };
}

export async function waitForConversationRemoval(page, previousText, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await openPrivateMessagePanel(page, { timeoutMs: 2000 });
    if (!opened.ok) {
      await page.waitForTimeout(200);
      continue;
    }
    const current = await locateFirstPrivateConversation(page);
    if (!current.ok) return { ok: true, removed: true, reason: current.reason };
    if ((current.conversation?.text || '') !== previousText) {
      return { ok: true, removed: true, nextConversation: current.conversation };
    }
    await page.waitForTimeout(300);
  }

  return { ok: false, removed: false, reason: 'conversation_still_visible_after_delete' };
}

export async function clearPrivateMessages(page, { count = 1 } = {}) {
  const normalizedCount = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  const results = [];
  if (normalizedCount <= 0) {
    return { ok: true, deletedCount: 0, requestedCount: normalizedCount, results };
  }

  for (let index = 0; index < normalizedCount; index++) {
    const opened = await openPrivateMessagePanel(page);
    if (!opened.ok) {
      return { ok: index > 0, deletedCount: index, requestedCount: normalizedCount, stoppedReason: opened.reason, results };
    }

    const located = await locateFirstPrivateConversation(page);
    if (!located.ok || !located.conversation) {
      return { ok: index > 0, deletedCount: index, requestedCount: normalizedCount, stoppedReason: located.reason || 'conversation_not_found', results };
    }

    const item = located.conversation;
    await page.mouse.move(item.x, item.y);
    await page.mouse.click(item.x, item.y, { button: 'right' });
    await page.waitForTimeout(250);

    const deleteAction = await findPrivateMessageMenuAction(page, '删除', { anchor: { x: item.x, y: item.y } });
    if (!deleteAction.ok || !deleteAction.target) {
      return { ok: index > 0, deletedCount: index, requestedCount: normalizedCount, stoppedReason: deleteAction.reason || 'delete_action_not_found', results };
    }

    await page.mouse.move(deleteAction.target.x, deleteAction.target.y);
    await page.mouse.click(deleteAction.target.x, deleteAction.target.y);
    await page.waitForTimeout(250);

    const confirmResult = await confirmPrivateMessageDeletion(page);
    if (!confirmResult.ok) {
      return { ok: index > 0, deletedCount: index, requestedCount: normalizedCount, stoppedReason: confirmResult.reason || 'confirm_delete_not_found', results };
    }

    await page.waitForTimeout(500);
    const removed = await waitForConversationRemoval(page, item.text);
    if (!removed.ok) {
      return { ok: index > 0, deletedCount: index, requestedCount: normalizedCount, stoppedReason: removed.reason, results };
    }

    results.push({
      index: index + 1,
      text: item.text,
    });
  }

  return { ok: true, deletedCount: results.length, requestedCount: normalizedCount, results };
}

export { SELF_URL };
