import { chromium } from 'playwright';
import { resolve } from 'path';
import { ensureNotificationPageReady, openNotificationPanel, waitForNotificationPanelStable, moveMouseIntoPanel } from '../src/adapters/notification-page.mjs';
import { waitForWorkModal } from '../src/adapters/work-modal-page.mjs';
import { clickNotificationWorkThumbnail } from '../src/adapters/work-context-page.mjs';
import fs from 'fs';

const PROFILE_DIR = resolve('.playwright/douyin-profile');

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, args: ['--no-sandbox'], viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] || await context.newPage();

  await ensureNotificationPageReady(page);
  const opened = await openNotificationPanel(page);
  if (!opened) { console.log('面板打不开'); await context.close(); return; }
  const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
  if (!stable || empty) { console.log('面板未稳定'); await context.close(); return; }
  await moveMouseIntoPanel(page, panelBox);

  const clickResult = await clickNotificationWorkThumbnail(page);
  if (!clickResult.ok) { console.log('缩略图点击失败:', clickResult.message); await context.close(); return; }

  await page.waitForTimeout(3000);
  const modalResult = await waitForWorkModal(page);
  if (!modalResult.ok) { console.log('modal未出现'); await context.close(); return; }

  const html = await page.content();
  fs.mkdirSync('data/debug', { recursive: true });
  fs.writeFileSync('data/debug/comment-page-full.html', html);

  const commentStructure = await page.evaluate(() => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return { error: 'no comment area' };
    const items = commentArea.querySelectorAll('[data-e2e="comment-item"]');
    const result = [];
    for (let i = 0; i < Math.min(10, items.length); i++) {
      const el = items[i];
      const text = (el.innerText || '').trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const infoWrap = el.querySelector('.comment-item-info-wrap');
      const infoText = infoWrap ? (infoWrap.innerText || '').trim() : '';
      const statsContainer = el.querySelector('.comment-item-stats-container');
      const statsText = statsContainer ? (statsContainer.innerText || '').trim() : '';
      const subReplies = el.querySelectorAll('.comment-item-info-wrap');
      result.push({
        index: i,
        fullLines: lines,
        infoWrapText: infoText,
        statsText,
        subReplyCount: subReplies.length,
        classList: [...el.classList],
        childClasses: [...el.children].map(c => c.className?.slice(0, 60) || c.tagName),
      });
    }
    return { total: items.length, samples: result };
  });
  fs.writeFileSync('data/debug/comment-structure.json', JSON.stringify(commentStructure, null, 2));

  console.log('Saved to data/debug/comment-page-full.html and comment-structure.json');
  console.log(`Total comment items: ${commentStructure.total}`);

  await page.waitForTimeout(5000);
  await context.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });
