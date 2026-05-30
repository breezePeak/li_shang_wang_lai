import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');
const OUT_DIR = resolve('data/debug/thumb-id-correlation');

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

  console.error('[3] 采集所有通知项的缩略图信息 + 点击后 modal_id...');
  const ACTION_PATTERNS = ['评论了你的作品', '回复了你的评论', '赞了你的作品', '赞了你的评论'];

  const allItems = await page.evaluate((ACTION_PATTERNS) => {
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

    const seen = new Set();
    const items = [];

    const allElements = panel.querySelectorAll('*');
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 5) continue;
      let actionCount = 0;
      let matchedPat = '';
      for (const pat of ACTION_PATTERNS) {
        let idx = text.indexOf(pat);
        while (idx !== -1) { actionCount++; idx = text.indexOf(pat, idx + 1); if (!matchedPat) matchedPat = pat; }
      }
      if (actionCount === 1) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2 && !seen.has(text)) {
          seen.add(text);

          const imgs = el.querySelectorAll('img');
          const imgData = [];
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            const imgRect = img.getBoundingClientRect();
            imgData.push({
              src: src.slice(0, 500),
              w: Math.round(imgRect.width),
              h: Math.round(imgRect.height),
              naturalW: img.naturalWidth,
              naturalH: img.naturalHeight,
              isAvatar: src.includes('aweme-avatar'),
              className: img.className || '',
              alt: img.getAttribute('alt') || '',
              parentClassName: (img.parentElement?.className || '').slice(0, 80),
              grandparentClassName: (img.parentElement?.parentElement?.className || '').slice(0, 80),
            });
          }

          const allAttrs = {};
          for (const attr of el.attributes || []) {
            if (attr.name.startsWith('data-') || attr.name === 'id' || attr.name === 'key') {
              allAttrs[attr.name] = attr.value.slice(0, 200);
            }
          }

          const parentAttrs = {};
          if (el.parentElement) {
            for (const attr of el.parentElement.attributes || []) {
              if (attr.name.startsWith('data-') || attr.name === 'id' || attr.name === 'key') {
                parentAttrs[attr.name] = attr.value.slice(0, 200);
              }
            }
          }

          items.push({
            text: text.slice(0, 200),
            action: matchedPat,
            imgs: imgData,
            elAttrs: allAttrs,
            parentAttrs,
            elClassName: (el.className || '').slice(0, 100),
          });
        }
      }
      if (items.length >= 5) break;
    }

    return items;
  }, ACTION_PATTERNS);

  console.error(`[3] 采集到 ${allItems.length} 条通知`);

  const results = [];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    console.error(`\n--- 通知 ${i + 1}: ${item.text.slice(0, 60)} ---`);
    console.error(`  action: ${item.action}`);
    console.error(`  elClassName: ${item.elClassName}`);
    console.error(`  elAttrs: ${JSON.stringify(item.elAttrs)}`);
    console.error(`  parentAttrs: ${JSON.stringify(item.parentAttrs)}`);

    const workImgs = item.imgs.filter(img => !img.isAvatar && img.w > 20);
    for (const img of workImgs) {
      console.error(`  缩略图:`);
      console.error(`    src: ${img.src}`);
      console.error(`    size: ${img.w}x${img.h} natural=${img.naturalW}x${img.naturalH}`);
      console.error(`    className: ${img.className}`);
      console.error(`    parentClassName: ${img.parentClassName}`);
      console.error(`    grandparentClassName: ${img.grandparentClassName}`);

      const srcIdMatch = img.src.match(/(\d{15,25})/);
      if (srcIdMatch) {
        console.error(`    ★ src 中包含数字ID: ${srcIdMatch[1]}`);
      }
    }

    if (workImgs.length > 0) {
      const targetImg = workImgs[0];
      const srcIdMatch = targetImg.src.match(/(\d{15,25})/);
      const srcId = srcIdMatch ? srcIdMatch[1] : null;

      console.error(`[4] 点击缩略图看 modal_id...`);
      const thumbData = await page.evaluate((ACTION_PATTERNS) => {
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
                return {
                  x: Math.round(imgRect.x + imgRect.width / 2),
                  y: Math.round(imgRect.y + imgRect.height / 2),
                  text: text.slice(0, 60),
                };
              }
            }
          }
        }
        return null;
      }, ACTION_PATTERNS);

      if (thumbData) {
        await page.mouse.click(thumbData.x, thumbData.y);
        await page.waitForTimeout(3000);

        const urlAfter = page.url();
        const modalMatch = urlAfter.match(/modal_id=([^&#]+)/);
        const modalId = modalMatch ? modalMatch[1] : null;

        console.error(`  点击后 URL: ${urlAfter}`);
        console.error(`  modal_id: ${modalId}`);
        if (srcId && modalId) {
          console.error(`  src中的ID: ${srcId}`);
          console.error(`  modal_id:  ${modalId}`);
          console.error(`  是否相同: ${srcId === modalId}`);
        }

        results.push({
          itemText: item.text.slice(0, 100),
          action: item.action,
          thumbSrc: targetImg.src,
          srcId,
          modalId,
          match: srcId === modalId,
          elAttrs: item.elAttrs,
          parentAttrs: item.parentAttrs,
        });

        // 关闭 modal 回到通知面板
        await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        await bell.hover({ timeout: 5000 });
        await page.waitForTimeout(2000);
      }
    }
  }

  writeFileSync(resolve(OUT_DIR, 'correlation.json'), JSON.stringify(results, null, 2), 'utf8');
  console.error(`\n[5] 结果保存到 ${OUT_DIR}/correlation.json`);

  console.error('[6] 浏览器保持打开 20 秒...');
  await page.waitForTimeout(20000);
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });