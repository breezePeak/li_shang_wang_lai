import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');
const OUT_DIR = resolve('data/debug/click-notification');

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

  console.error('[3] 查找评论通知卡片...');
  const ACTION_PATTERNS = ['评论了你的作品', '回复了你的评论'];

  const commentCards = await page.evaluate((ACTION_PATTERNS) => {
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
    if (!panel) return [];

    const items = panel.querySelectorAll('li, [class*="item"], [class*="row"], [class*="entry"]');
    const results = [];
    for (const item of items) {
      const text = (item.innerText || '').trim();
      for (const pat of ACTION_PATTERNS) {
        if (text.includes(pat)) {
          results.push({ text: text.slice(0, 200), className: item.className || '', tagName: item.tagName });
          break;
        }
      }
    }

    if (results.length === 0) {
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
            results.push({ text: text.slice(0, 200), className: el.className || '', tagName: el.tagName });
          }
        }
        if (results.length >= 3) break;
      }
    }

    return results;
  }, ACTION_PATTERNS);

  console.error(`[3] 找到 ${commentCards.length} 条评论通知`);
  for (const c of commentCards) {
    console.error(`  - <${c.tagName}> class="${c.className.slice(0, 60)}" text="${c.text.slice(0, 80)}"`);
  }

  if (commentCards.length === 0) {
    console.error('没有找到评论通知，退出');
    await context.close();
    return;
  }

  console.error('[4] 点击第一条评论通知卡片...');
  const urlBefore = page.url();
  console.error(`  点击前 URL: ${urlBefore}`);

  try {
    const clicked = await page.evaluate((ACTION_PATTERNS) => {
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
      if (!panel) return { clicked: false, reason: 'no panel' };

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
            el.click();
            return { clicked: true, text: text.slice(0, 100) };
          }
        }
      }
      return { clicked: false, reason: 'no matching element' };
    }, ACTION_PATTERNS);

    console.error(`  click result: ${JSON.stringify(clicked)}`);

    if (clicked.clicked) {
      console.error('[5] 等待页面跳转...');
      await page.waitForTimeout(5000);

      const urlAfter = page.url();
      console.error(`  点击后 URL: ${urlAfter}`);

      console.error('[6] 采集跳转后页面信息...');
      const pageInfo = await page.evaluate(() => {
        const title = document.title || '';
        const url = location.href;

        const ogTitle = document.querySelector('meta[property="og:title"]');
        const ogDescription = document.querySelector('meta[property="og:description"]');

        const authorLinks = document.querySelectorAll('a[href*="/user/"]');
        const authors = [];
        for (const link of authorLinks) {
          const href = link.getAttribute('href') || '';
          const text = (link.innerText || '').trim();
          const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
          if (match) {
            authors.push({ name: text.slice(0, 50), key: match[1], href: href.slice(0, 200) });
          }
          if (authors.length >= 5) break;
        }

        const videoMatch = url.match(/\/video\/([^/?#]+)/);
        const noteMatch = url.match(/\/note\/([^/?#]+)/);

        const allLinks = [];
        const links = document.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.includes('/video/') || href.includes('/note/')) {
            allLinks.push({ href: href.slice(0, 200), text: (link.innerText || '').trim().slice(0, 100) });
          }
          if (allLinks.length >= 10) break;
        }

        const bodyText = (document.body?.innerText || '').slice(0, 3000);

        return {
          url,
          title,
          ogTitle: ogTitle?.getAttribute('content') || '',
          ogDescription: ogDescription?.getAttribute('content') || '',
          videoId: videoMatch ? videoMatch[1] : null,
          noteId: noteMatch ? noteMatch[1] : null,
          authors,
          workLinks: allLinks,
          bodyTextPreview: bodyText.slice(0, 2000),
        };
      });

      console.error(`  URL: ${pageInfo.url}`);
      console.error(`  title: ${pageInfo.title}`);
      console.error(`  ogTitle: ${pageInfo.ogTitle}`);
      console.error(`  videoId: ${pageInfo.videoId}`);
      console.error(`  noteId: ${pageInfo.noteId}`);
      console.error(`  authors: ${JSON.stringify(pageInfo.authors)}`);
      console.error(`  workLinks: ${JSON.stringify(pageInfo.workLinks)}`);

      writeFileSync(resolve(OUT_DIR, 'click-result.json'), JSON.stringify(pageInfo, null, 2), 'utf8');
      console.error(`[7] 结果已保存到 ${OUT_DIR}/click-result.json`);
    }
  } catch (err) {
    console.error(`点击失败: ${err.message}`);
  }

  console.error('[8] 浏览器保持打开，等待 30 秒供人工查看...');
  await page.waitForTimeout(30000);
  console.error('完成');
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });