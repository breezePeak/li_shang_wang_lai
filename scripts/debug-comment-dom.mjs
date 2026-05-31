import { createBrowserContext } from '../src/browser/browser-context.mjs';
import { ensureNotificationPageReady, openNotificationPanel, waitForNotificationPanelStable, moveMouseIntoPanel, extractVisibleNotifications } from '../src/adapters/notification-page.mjs';
import { clickNotificationWorkThumbnail } from '../src/adapters/work-context-page.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const OUT_DIR = resolve('data/debug/comment-dom');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('[1] 启动浏览器...');
  const ctx = await createBrowserContext({ headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('[2] 打开通知页...');
  await ensureNotificationPageReady(page);
  const opened = await openNotificationPanel(page);
  if (!opened) { console.error('无法打开通知面板'); await ctx.close(); return; }
  const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
  if (!stable || empty) { console.error('面板未稳定'); await ctx.close(); return; }
  await moveMouseIntoPanel(page, panelBox);

  console.log('[3] 点击评论通知缩略图...');
  const clickResult = await clickNotificationWorkThumbnail(page);
  if (!clickResult.ok) { console.error('点击失败'); await ctx.close(); return; }

  console.log('[4] 等待 modal...');
  await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(3000);

  console.log('[5] 深度采集评论区 DOM...');
  const domInfo = await page.evaluate(() => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return { error: 'no comment-mainContent' };

    const items = commentArea.querySelectorAll('.comment-item-info-wrap');
    const result = [];

    for (let i = 0; i < Math.min(items.length, 5); i++) {
      const item = items[i];
      const itemInfo = {
        index: i,
        innerText: (item.innerText || '').trim().slice(0, 500),
        className: item.className,
        childCount: item.children.length,
        children: [],
        spans: [],
        buttons: [],
        inputs: [],
      };

      for (const child of item.children) {
        itemInfo.children.push({
          tag: child.tagName,
          className: (child.className || '').slice(0, 100),
          text: (child.innerText || '').trim().slice(0, 200),
          childCount: child.children.length,
        });
      }

      const allSpans = item.querySelectorAll('span');
      for (const span of allSpans) {
        const text = (span.innerText || '').trim();
        const rect = span.getBoundingClientRect();
        itemInfo.spans.push({
          text: text.slice(0, 50),
          className: (span.className || '').slice(0, 100),
          parentTag: span.parentElement?.tagName || '',
          parentClass: (span.parentElement?.className || '').slice(0, 100),
          visible: rect.width > 0 && rect.height > 0,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          isReplyText: text === '回复',
        });
      }

      const allButtons = item.querySelectorAll('button, a, [role="button"]');
      for (const btn of allButtons) {
        const text = (btn.innerText || '').trim();
        const rect = btn.getBoundingClientRect();
        itemInfo.buttons.push({
          tag: btn.tagName,
          text: text.slice(0, 50),
          className: (btn.className || '').slice(0, 100),
          href: (btn.getAttribute('href') || '').slice(0, 100),
          visible: rect.width > 0 && rect.height > 0,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }

      const allInputs = item.querySelectorAll('input, textarea, [contenteditable]');
      for (const input of allInputs) {
        const rect = input.getBoundingClientRect();
        itemInfo.inputs.push({
          tag: input.tagName,
          type: input.getAttribute('type') || '',
          placeholder: (input.getAttribute('placeholder') || '').slice(0, 50),
          className: (input.className || '').slice(0, 100),
          visible: rect.width > 0 && rect.height > 0,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }

      result.push(itemInfo);
    }

    const commentAreaInfo = {
      className: commentArea.className,
      childCount: commentArea.children.length,
      scrollHeight: commentArea.scrollHeight,
      clientHeight: commentArea.clientHeight,
      totalItems: items.length,
    };

    const firstLevelChildren = [];
    for (const child of commentArea.children) {
      firstLevelChildren.push({
        tag: child.tagName,
        className: (child.className || '').slice(0, 100),
        text: (child.innerText || '').trim().slice(0, 100),
        childCount: child.children.length,
      });
    }

    return { commentArea: commentAreaInfo, firstLevelChildren, items: result };
  });

  writeFileSync(resolve(OUT_DIR, 'comment-dom-structure.json'), JSON.stringify(domInfo, null, 2), 'utf8');
  console.log(`[5] DOM 结构已保存，共 ${domInfo.items?.length || 0} 条评论详情`);

  if (domInfo.items) {
    for (const item of domInfo.items) {
      console.log(`\n--- 评论 #${item.index} ---`);
      console.log(`  text: ${item.innerText.slice(0, 80)}`);
      console.log(`  spans (回复相关):`);
      for (const span of item.spans.filter(s => s.isReplyText || s.text.includes('回复'))) {
        console.log(`    "${span.text}" class="${span.className}" parent=${span.parentTag}.${span.parentClass.slice(0, 40)} visible=${span.visible} at (${span.x},${span.y}) ${span.w}x${span.h}`);
      }
      console.log(`  buttons:`);
      for (const btn of item.buttons) {
        console.log(`    <${btn.tag}> "${btn.text}" class="${btn.className.slice(0, 40)}" visible=${btn.visible}`);
      }
    }
  }

  console.log('\n[6] 浏览器保持打开 30 秒...');
  await page.waitForTimeout(30000);
  await ctx.close();
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });