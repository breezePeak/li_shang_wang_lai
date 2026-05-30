import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');
const OUT_DIR = resolve('data/debug/click-thumbnail');

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

  console.error('[3] 找评论通知中的作品缩略图...');
  const ACTION_PATTERNS = ['评论了你的作品', '回复了你的评论'];

  const thumbInfo = await page.evaluate((ACTION_PATTERNS) => {
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
    if (!panel) return { error: 'no panel' };

    const allElements = panel.querySelectorAll('*');
    const commentItems = [];
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
          commentItems.push(el);
        }
      }
      if (commentItems.length >= 1) break;
    }

    if (commentItems.length === 0) return { error: 'no comment items' };

    const item = commentItems[0];
    const itemRect = item.getBoundingClientRect();

    const imgs = item.querySelectorAll('img');
    const imgData = [];
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      const src = img.getAttribute('src') || '';
      imgData.push({
        src: src.slice(0, 300),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        className: img.className || '',
        isAvatar: src.includes('aweme-avatar'),
      });
    }

    const allClickable = item.querySelectorAll('a, button, [role="button"], [class*="click"]');
    const clickableData = [];
    for (const el of allClickable) {
      const rect = el.getBoundingClientRect();
      clickableData.push({
        tag: el.tagName,
        className: (el.className || '').slice(0, 80),
        href: (el.getAttribute('href') || '').slice(0, 200),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }

    return {
      itemText: (item.innerText || '').trim().slice(0, 200),
      itemRect: { x: Math.round(itemRect.x), y: Math.round(itemRect.y), w: Math.round(itemRect.width), h: Math.round(itemRect.height) },
      imgs: imgData,
      clickables: clickableData,
    };
  }, ACTION_PATTERNS);

  console.error(`[3] 通知项信息: ${JSON.stringify(thumbInfo, null, 2)}`);

  if (thumbInfo.error) {
    console.error(`找不到: ${thumbInfo.error}`);
    await context.close();
    return;
  }

  const workImgs = thumbInfo.imgs.filter(img => !img.isAvatar && img.w > 20 && img.h > 20);
  console.error(`[4] 非头像图片: ${workImgs.length} 个`);
  for (const img of workImgs) {
    console.error(`  img: ${img.w}x${img.h} at (${img.x},${img.y}) natural=${img.naturalW}x${img.naturalH} class="${img.className}"`);
  }

  if (workImgs.length > 0) {
    const targetImg = workImgs[0];
    console.error(`[5] 点击作品缩略图 at (${targetImg.x + targetImg.w/2}, ${targetImg.y + targetImg.h/2})...`);

    const urlBefore = page.url();
    await page.mouse.click(targetImg.x + targetImg.w / 2, targetImg.y + targetImg.h / 2);
    console.error('[6] 等待跳转...');
    await page.waitForTimeout(5000);

    const urlAfter = page.url();
    console.error(`  点击前: ${urlBefore}`);
    console.error(`  点击后: ${urlAfter}`);

    const pageInfo = await page.evaluate(() => {
      const url = location.href;
      const title = document.title || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const videoMatch = url.match(/\/video\/([^/?#]+)/);
      const noteMatch = url.match(/\/note\/([^/?#]+)/);

      const authorLinks = document.querySelectorAll('a[href*="/user/"]');
      const authors = [];
      for (const link of authorLinks) {
        const href = link.getAttribute('href') || '';
        const text = (link.innerText || '').trim();
        const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
        if (match && authors.length < 5) {
          authors.push({ name: text.slice(0, 50), key: match[1] });
        }
      }

      const bodyText = (document.body?.innerText || '').slice(0, 3000);
      return { url, title, ogTitle, videoId: videoMatch?.[1] || null, noteId: noteMatch?.[1] || null, authors, bodyTextPreview: bodyText.slice(0, 2000) };
    });

    console.error(`  URL: ${pageInfo.url}`);
    console.error(`  title: ${pageInfo.title}`);
    console.error(`  videoId: ${pageInfo.videoId}`);
    console.error(`  noteId: ${pageInfo.noteId}`);
    console.error(`  authors: ${JSON.stringify(pageInfo.authors)}`);

    writeFileSync(resolve(OUT_DIR, 'click-thumb-result.json'), JSON.stringify(pageInfo, null, 2), 'utf8');
    console.error(`[7] 结果已保存到 ${OUT_DIR}/click-thumb-result.json`);
  }

  console.error('[8] 浏览器保持打开 30 秒...');
  await page.waitForTimeout(30000);
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });