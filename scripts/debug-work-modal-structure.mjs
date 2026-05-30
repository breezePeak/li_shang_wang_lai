import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');
const OUT_DIR = resolve('data/debug/work-modal-structure');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 150,
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] || await context.newPage();

  console.error('[1] 打开抖音主页...');
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  console.error('[2] hover 通知铃铛...');
  const bell = page.locator('svg.LtuRRess').first();
  await bell.hover({ timeout: 5000 });
  await page.waitForTimeout(3000);

  console.error('[3] 找评论通知并点击缩略图...');
  const ACTION_PATTERNS = ['评论了你的作品', '回复了你的评论'];

  const thumbPos = await page.evaluate((ACTION_PATTERNS) => {
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
    if (!panel) return null;
    const allElements = panel.querySelectorAll('*');
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 5) continue;
      let actionCount = 0;
      for (const pat of ACTION_PATTERNS) {
        let idx = text.indexOf(pat);
        while (idx !== -1) { actionCount++; idx = text.indexOf(pat, idx + 1); }
      }
      if (actionCount === 1) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const imgs = el.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (src.includes('aweme-avatar')) continue;
            const imgRect = img.getBoundingClientRect();
            if (imgRect.width < 20 || imgRect.height < 20) continue;
            return { x: Math.round(imgRect.x + imgRect.width / 2), y: Math.round(imgRect.y + imgRect.height / 2) };
          }
        }
      }
    }
    return null;
  }, ACTION_PATTERNS);

  if (!thumbPos) {
    console.error('没找到评论通知缩略图');
    await context.close();
    return;
  }

  console.error(`  点击缩略图 at (${thumbPos.x}, ${thumbPos.y})`);
  await page.mouse.click(thumbPos.x, thumbPos.y);
  await page.waitForTimeout(5000);

  const urlAfter = page.url();
  console.error(`  URL: ${urlAfter}`);

  console.error('[4] 采集作品 modal 内的完整结构...');
  const modalStructure = await page.evaluate(() => {
    const result = {
      url: location.href,
      title: document.title,
      bodyTextPreview: (document.body?.innerText || '').slice(0, 5000),
      modal: null,
      commentArea: null,
      likeArea: null,
      replyBox: null,
    };

    // 找 modal 容器
    const modalCandidates = document.querySelectorAll('[class*="modal"], [class*="detail"], [class*="xgplayer"], [class*="video"], [class*="player"]');
    for (const m of modalCandidates) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 400 && rect.height > 300) {
        result.modal = {
          className: (m.className || '').slice(0, 200),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
        break;
      }
    }

    // 找评论区
    const commentSelectors = [
      '[class*="comment"]',
      '[class*="reply"]',
      '[data-e2e*="comment"]',
    ];
    const commentAreas = [];
    for (const sel of commentSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 50) {
          commentAreas.push({
            selector: sel,
            className: (el.className || '').slice(0, 200),
            tagName: el.tagName,
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            childCount: el.children.length,
            textPreview: (el.innerText || '').trim().slice(0, 500),
          });
        }
      }
    }
    // 去重：只保留最大的几个
    commentAreas.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    result.commentArea = commentAreas.slice(0, 5);

    // 找点赞区
    const likeSelectors = ['[class*="like"]', '[class*="digg"]', '[data-e2e*="like"]'];
    const likeAreas = [];
    for (const sel of likeSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          likeAreas.push({
            selector: sel,
            className: (el.className || '').slice(0, 200),
            tagName: el.tagName,
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            text: (el.innerText || '').trim().slice(0, 100),
          });
        }
      }
    }
    likeAreas.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    result.likeArea = likeAreas.slice(0, 10);

    // 找回复输入框
    const inputSelectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'];
    const inputAreas = [];
    for (const sel of inputSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        inputAreas.push({
          selector: sel,
          className: (el.className || '').slice(0, 200),
          tagName: el.tagName,
          placeholder: el.getAttribute('placeholder') || '',
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          visible: rect.width > 0 && rect.height > 0,
        });
      }
    }
    result.replyBox = inputAreas;

    // 找评论项
    const commentItemSelectors = ['[class*="comment-item"]', '[class*="commentItem"]', '[data-e2e*="comment-item"]'];
    const commentItems = [];
    for (const sel of commentItemSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 20) {
          commentItems.push({
            selector: sel,
            className: (el.className || '').slice(0, 200),
            text: (el.innerText || '').trim().slice(0, 300),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        }
      }
    }
    result.commentItems = commentItems.slice(0, 10);

    // 找"回复"按钮
    const replyButtons = [];
    const allBtns = document.querySelectorAll('span, a, button, [role="button"]');
    for (const btn of allBtns) {
      const text = (btn.innerText || '').trim();
      if (text === '回复' || text === 'Reply') {
        const rect = btn.getBoundingClientRect();
        replyButtons.push({
          text,
          tagName: btn.tagName,
          className: (btn.className || '').slice(0, 100),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    }
    result.replyButtons = replyButtons.slice(0, 10);

    return result;
  });

  writeFileSync(resolve(OUT_DIR, 'modal-structure.json'), JSON.stringify(modalStructure, null, 2), 'utf8');
  console.error(`[5] 结构已保存到 ${OUT_DIR}/modal-structure.json`);

  // 打印关键信息
  console.error('\n===== 作品 Modal 结构 =====');
  console.error(`URL: ${modalStructure.url}`);
  console.error(`Modal: ${JSON.stringify(modalStructure.modal)}`);
  console.error(`\n评论区候选 (${modalStructure.commentArea?.length || 0}):`);
  for (const ca of (modalStructure.commentArea || [])) {
    console.error(`  <${ca.tagName}> class="${ca.className.slice(0, 60)}" ${ca.w}x${ca.h} at (${ca.x},${ca.y}) children=${ca.childCount}`);
    console.error(`    text: ${ca.textPreview.slice(0, 150)}`);
  }
  console.error(`\n评论项 (${modalStructure.commentItems?.length || 0}):`);
  for (const ci of (modalStructure.commentItems || [])) {
    console.error(`  class="${ci.className.slice(0, 60)}" ${ci.w}x${ci.h}`);
    console.error(`    text: ${ci.text.slice(0, 150)}`);
  }
  console.error(`\n回复按钮 (${modalStructure.replyButtons?.length || 0}):`);
  for (const rb of (modalStructure.replyButtons || [])) {
    console.error(`  <${rb.tagName}> "${rb.text}" class="${rb.className}" at (${rb.x},${rb.y}) ${rb.w}x${rb.h}`);
  }
  console.error(`\n输入框 (${modalStructure.replyBox?.length || 0}):`);
  for (const ib of (modalStructure.replyBox || [])) {
    console.error(`  <${ib.tagName}> ${ib.selector} placeholder="${ib.placeholder}" visible=${ib.visible} ${ib.w}x${ib.h}`);
  }
  console.error(`\n点赞区 (${modalStructure.likeArea?.length || 0}):`);
  for (const la of (modalStructure.likeArea || [])) {
    console.error(`  <${la.tagName}> ${la.selector} class="${la.className.slice(0, 60)}" ${la.w}x${la.h} text="${la.text.slice(0, 40)}"`);
  }

  console.error('\n[6] 浏览器保持打开 30 秒供人工查看...');
  await page.waitForTimeout(30000);
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });