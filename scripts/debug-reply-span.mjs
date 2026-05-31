import { createBrowserContext } from '../src/browser/browser-context.mjs';
import { ensureNotificationPageReady, openNotificationPanel, waitForNotificationPanelStable, moveMouseIntoPanel } from '../src/adapters/notification-page.mjs';
import { clickNotificationWorkThumbnail } from '../src/adapters/work-context-page.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const OUT_DIR = resolve('data/debug/comment-dom');

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

  console.log('深度采集评论区 DOM 层级...');

  const result = await page.evaluate(() => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return { error: 'no comment-mainContent' };

    const allReplySpans = [];
    const walker = document.createTreeWalker(commentArea, NodeFilter.SHOW_ELEMENT);
    let node;
    while (node = walker.nextNode()) {
      if (node.tagName === 'SPAN' && (node.innerText || '').trim() === '回复') {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const path = [];
          let cur = node;
          for (let i = 0; i < 8 && cur && cur !== commentArea; i++) {
            path.unshift({
              tag: cur.tagName,
              className: (cur.className || '').slice(0, 80),
              id: (cur.id || '').slice(0, 30),
            });
            cur = cur.parentElement;
          }
          allReplySpans.push({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            path,
            parentOuterHTML: node.parentElement?.outerHTML?.slice(0, 300) || '',
            closestCommentItem: node.closest('.comment-item-info-wrap') ? true : false,
            closestClassList: (() => {
              const ci = node.closest('.comment-item-info-wrap');
              if (!ci) return null;
              return ci.className;
            })(),
          });
        }
      }
    }

    const allShareSpans = [];
    const walker2 = document.createTreeWalker(commentArea, NodeFilter.SHOW_ELEMENT);
    while (node = walker2.nextNode()) {
      if (node.tagName === 'SPAN' && (node.innerText || '').trim() === '分享') {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          allShareSpans.push({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            path: (() => {
              const p = [];
              let cur = node;
              for (let i = 0; i < 5 && cur && cur !== commentArea; i++) {
                p.unshift({ tag: cur.tagName, className: (cur.className || '').slice(0, 60) });
                cur = cur.parentElement;
              }
              return p;
            })(),
          });
        }
      }
    }

    const commentItems = commentArea.querySelectorAll('.comment-item-info-wrap');
    const firstItemStructure = [];
    if (commentItems.length > 0) {
      const item = commentItems[0];
      const dumpElement = (el, depth) => {
        if (depth > 5) return;
        const rect = el.getBoundingClientRect();
        firstItemStructure.push({
          depth,
          tag: el.tagName,
          className: (el.className || '').slice(0, 80),
          text: (el.innerText || '').trim().slice(0, 60),
          childCount: el.children.length,
          visible: rect.width > 0 && rect.height > 0,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
        for (const child of el.children) {
          dumpElement(child, depth + 1);
        }
      };
      dumpElement(item, 0);

      const parent = item.parentElement;
      if (parent) {
        firstItemStructure.push({ depth: -1, tag: 'PARENT', className: (parent.className || '').slice(0, 80), childCount: parent.children.length });
        for (let i = 0; i < parent.children.length && i < 3; i++) {
          const sibling = parent.children[i];
          firstItemStructure.push({
            depth: -2,
            tag: sibling.tagName,
            className: (sibling.className || '').slice(0, 80),
            text: (sibling.innerText || '').trim().slice(0, 80),
            isCommentItem: sibling.classList?.contains('comment-item-info-wrap') || false,
          });
        }
      }
    }

    return {
      replySpans: allReplySpans.slice(0, 10),
      shareSpans: allShareSpans.slice(0, 5),
      firstItemStructure,
      totalReplySpans: allReplySpans.length,
    };
  });

  writeFileSync(resolve(OUT_DIR, 'reply-span-deep.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log(`回复 span 总数: ${result.totalReplySpans}`);
  console.log(`\n回复 span 详情:`);
  for (const s of (result.replySpans || [])) {
    console.log(`  at (${s.x},${s.y}) ${s.w}x${s.h} closestCommentItem=${s.closestCommentItem} path=${JSON.stringify(s.path.slice(0, 4))}`);
  }

  console.log(`\n第一条评论结构:`);
  for (const s of (result.firstItemStructure || [])) {
    const indent = '  '.repeat(Math.max(0, s.depth));
    console.log(`${indent}${s.tag} class="${s.className?.slice(0, 40)}" children=${s.childCount} text="${s.text?.slice(0, 30)}"`);
  }

  await page.waitForTimeout(15000);
  await context.close();
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });