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

async function moveMouseFromTriggerIntoPanel(page, triggerLocator) {
  try {
    const box = await triggerLocator.boundingBox();
    if (!box) return { ok: false, reason: 'trigger_box_not_found' };
    const x = Math.max(0, box.x - 80);
    const y = box.y + Math.max(90, box.height + 70);
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'trigger_box_not_found' };
  }
}

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

      const directSelectors = [
        '.componentsEntrywrapper.imContainer',
        '.componentsLeftPanelwrapper',
        '.conversationConversationListwrapper',
        '.componentsLeftPanelboxList',
      ];
      for (const selector of directSelectors) {
        const el = document.querySelector(selector);
        if (isVisible(el)) return true;
      }
      return false;
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
        await moveMouseFromTriggerIntoPanel(page, trigger.locator);
        return { ok: true, method: 'hover', selector: trigger.selector, attempt };
      }
    } catch {}

    try {
      await trigger.locator.click({ timeout: 1500 });
      if (await waitForPrivateMessagePanel(page, { timeoutMs: 1200 })) {
        await moveMouseFromTriggerIntoPanel(page, trigger.locator);
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
      const directSelectors = [
        '.componentsEntrywrapper.imContainer',
        '.componentsLeftPanelwrapper',
        '.conversationConversationListwrapper',
        '.componentsLeftPanelboxList',
      ];
      for (const selector of directSelectors) {
        const el = document.querySelector(selector);
        if (isVisible(el)) return el;
      }
      return null;
    }

    const panel = findPanel();
    if (!panel) return { ok: false, reason: 'panel_not_found' };

    const panelRect = panel.getBoundingClientRect();
    const searchNode = panel.querySelector('input[placeholder*="搜索"], [placeholder*="搜索"]');
    const minTop = searchNode
      ? searchNode.getBoundingClientRect().bottom + 8
      : panelRect.top + Math.min(panelRect.height * 0.12, 72);

    function readConversationMeta(el) {
      let current = el;
      for (let depth = 0; depth < 3 && current; depth++, current = current.parentElement) {
        for (const key of Object.keys(current)) {
          if (!key.startsWith('__reactProps$')) continue;
          const props = current[key];
          const candidates = [props?.children?.[2]?.props?.conversation, props?.children?.props?.conversation, props?.conversation];
          for (const conversation of candidates) {
            if (conversation && typeof conversation === 'object') {
              return {
                toParticipantSecUserId: conversation.toParticipantSecUserId ?? '',
                participantCount: conversation.participantCount ?? conversation.participant_count ?? null,
              };
            }
          }
        }
      }
      return { toParticipantSecUserId: '', participantCount: null };
    }

    function classifyConversation(meta) {
      const secUid = String(meta?.toParticipantSecUserId || '').trim();
      const participantCount = Number(meta?.participantCount);
      const normalizedCount = Number.isFinite(participantCount) ? participantCount : null;
      const isPersonal = Boolean(secUid) && (normalizedCount === null || normalizedCount <= 2);
      return {
        type: isPersonal ? 'personal' : 'group',
        toParticipantSecUserId: secUid,
        participantCount: normalizedCount,
      };
    }

    const directRows = Array.from(panel.querySelectorAll('[class*="conversationConversationItemwrapper"], [class*="ConversationItemwrapper"]'))
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const meta = readConversationMeta(el);
        const classification = classifyConversation(meta);
        return {
          el,
          rect,
          text: (el.innerText || '').trim(),
          conversationType: classification.type,
          toParticipantSecUserId: classification.toParticipantSecUserId,
          participantCount: classification.participantCount,
        };
      })
      .filter(item =>
        item.text.length >= 2 &&
        item.rect.top >= minTop &&
        item.rect.bottom <= panelRect.bottom + 2 &&
        item.rect.left >= panelRect.left &&
        item.rect.right <= panelRect.right + 2 &&
        item.rect.height >= 48 &&
        item.rect.height <= 160 &&
        item.conversationType === 'personal'
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
          conversationType: first.conversationType,
          toParticipantSecUserId: first.toParticipantSecUserId,
          participantCount: first.participantCount,
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
              conversationType: 'unknown',
              toParticipantSecUserId: '',
              participantCount: null,
            });
          }
          break;
        }
        current = current.parentElement;
      }
    }

    rows.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const first = rows.find(item => item.conversationType === 'personal');
    if (!first) return { ok: false, reason: 'personal_conversation_not_found' };
    return { ok: true, conversation: first };
  });
}

export async function getPrivateMessagePanelBox(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const directSelectors = [
      '.componentsEntrywrapper.imContainer',
      '.componentsLeftPanelwrapper',
      '.conversationConversationListwrapper',
      '.componentsLeftPanelboxList',
    ];
    let panelEl = null;
    for (const selector of directSelectors) {
      const el = document.querySelector(selector);
      if (isVisible(el)) {
        panelEl = el;
        break;
      }
    }
    if (!panelEl) return null;
    const rect = panelEl.getBoundingClientRect();
    const panel = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    return panel;
  });
}

export async function moveMouseIntoPrivateMessagePanel(page) {
  const panelBox = await getPrivateMessagePanelBox(page);
  if (!panelBox) return { ok: false, reason: 'panel_not_found' };
  const x = panelBox.x + panelBox.width / 2;
  const y = panelBox.y + Math.min(panelBox.height * 0.2, 90);
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  return { ok: true, panelBox };
}

export async function locateFirstPersonalConversation(page, { maxScrolls = 8 } = {}) {
  for (let attempt = 0; attempt <= maxScrolls; attempt++) {
    const located = await locateFirstPrivateConversation(page);
    if (!located) return { ok: false, reason: 'panel_not_found' };
    if (located.ok) return located;
    if (located.reason !== 'personal_conversation_not_found') return located;

    let scrolled;
    try {
      scrolled = await page.evaluate(() => {
        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
        }

        const containers = Array.from(document.querySelectorAll('.conversationConversationListwrapper, .componentsLeftPanelboxList'))
          .filter(isVisible)
          .filter(el => el.scrollHeight > el.clientHeight + 20)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const container = containers[0];
        if (!container) return { ok: false, reason: 'panel_not_found' };

        const before = container.scrollTop;
        container.scrollTop = before + 900;
        const after = container.scrollTop;
        return { ok: after !== before, before, after };
      });
    } catch {
      scrolled = { ok: false, reason: 'panel_not_found' };
    }

    if (!scrolled || !scrolled.ok) return { ok: false, reason: scrolled?.reason || 'panel_not_found' };
    await page.waitForTimeout(500);
  }

  return { ok: false, reason: 'personal_conversation_not_found' };
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

    const located = await locateFirstPersonalConversation(page);
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
