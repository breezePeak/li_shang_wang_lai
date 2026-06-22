import { createBrowserContext } from '../src/browser/browser-context.mjs';
import { ensureNotificationPageReady, openNotificationPanel, waitForNotificationPanelStable, moveMouseIntoPanel } from '../src/adapters/notification-page.mjs';
import { clickNotificationWorkThumbnail } from '../src/adapters/work-context-page.mjs';
import { openReplyBoxForWorkComment } from '../src/adapters/work-modal-page.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const OUT_DIR = resolve('data/debug/reply-send-area');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const { browser, context } = await createBrowserContext({ headless: false });
  const page = context.pages()[0] || await context.newPage();

  await ensureNotificationPageReady(page);
  const opened = await openNotificationPanel(page);
  if (!opened) { await context.close(); return; }
  const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
  if (!stable || empty) { await context.close(); return; }
  await moveMouseIntoPanel(page, panelBox);

  const clickResult = await clickNotificationWorkThumbnail(page);
  if (!clickResult.ok) { await context.close(); return; }

  await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(3000);

  console.log('打开回复输入框...');
  const opened2 = await openReplyBoxForWorkComment(page, { index: 0, maxScrollRounds: 1 }).catch(err => ({ ok: false, err: err.message }));
  console.log('openReplyBoxForWorkComment ->', JSON.stringify(opened2));
  await page.waitForTimeout(2000);

  const dump = await page.evaluate(() => {
    const out = { found: [] };
    const containers = [
      '.comment-input-container',
      '[class*="comment-input-container"]',
      '[class*="commentInputContainer"]',
      '.comment-input-inner-container',
      '[class*="comment-input-inner-container"]',
      '[class*="commentInput-right"]',
    ];
    for (const sel of containers) {
      const list = document.querySelectorAll(sel);
      out.found.push({ selector: sel, count: list.length });
    }
    const container = document.querySelector('.comment-input-container')
      || document.querySelector('[class*="comment-input-container"]')
      || document.querySelector('[class*="commentInputContainer"]');
    if (!container) return { error: 'no container' };
    out.containerOuterStart = container.outerHTML.slice(0, 2000);
    out.containerRect = container.getBoundingClientRect();

    const right = container.querySelector('.commentInput-right-ct')
      || container.querySelector('[class*="commentInput-right"]')
      || container.querySelector('[class*="right-ct"]');
    if (!right) return { ...out, error: 'no right area' };
    out.rightOuterStart = right.outerHTML.slice(0, 3000);
    out.rightRect = right.getBoundingClientRect();

    const tree = [];
    function walk(el, depth) {
      if (depth > 5) return;
      const r = el.getBoundingClientRect();
      tree.push({
        depth,
        tag: el.tagName,
        class: (el.className || '').toString().slice(0, 80),
        id: el.id || '',
        text: (el.innerText || '').trim().slice(0, 40),
        ariaLabel: el.getAttribute?.('aria-label') || '',
        title: el.getAttribute?.('title') || '',
        dataE2e: el.getAttribute?.('data-e2e') || '',
        childCount: el.children.length,
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        role: el.getAttribute?.('role') || '',
      });
      for (const c of el.children) walk(c, depth + 1);
    }
    walk(right, 0);
    out.tree = tree;
    return out;
  });

  writeFileSync(resolve(OUT_DIR, 'reply-send-area.json'), JSON.stringify(dump, null, 2), 'utf8');

  if (dump.error) {
    console.log('错误:', dump.error);
  } else {
    console.log('右侧树:');
    for (const n of (dump.tree || [])) {
      const indent = '  '.repeat(n.depth);
      console.log(`${indent}${n.tag} class="${n.class?.slice(0, 30)}" aria="${n.ariaLabel}" title="${n.title}" w=${n.w} h=${n.h} text="${n.text}"`);
    }
  }

  await page.waitForTimeout(20000);
  await context.close();
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });
