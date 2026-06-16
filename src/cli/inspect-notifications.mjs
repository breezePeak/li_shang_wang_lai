/**
 * inspect-notifications — 探测通知铃铛下拉菜单
 * 自动 hover 铃铛图标，采集通知列表（含点赞和评论事件）
 */
import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  capturePageDiagnostics,
  extractVisibleText,
  captureFullScreenshot,
  captureDomFragment,
} from '../browser/page-diagnostics.mjs';
import { findNotificationBell } from '../adapters/notification-page.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';

import path from 'path';
import { writeFileSync } from 'fs';

const SELF_URL = 'https://www.douyin.com/user/self';

function chinaTimestamp() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}-${get('second')}`;
}

async function main() {
  const args = process.argv.slice(2);
  const keepOpen = args.includes('--keep-open');
  const headless = args.includes('--headless') ? true : undefined;

  const outputRoot = path.resolve(process.cwd(), 'interactions-output', 'inspect');
  const sessionDir = path.join(outputRoot, 'notify-' + chinaTimestamp());
  ensureDir(sessionDir);

  console.log(`[notify] 输出目录: ${sessionDir}`);

  let browser = null;
  try {
    console.log('[notify] 启动浏览器...');
    const ctx = await createBrowserContext({ headless, enableReuse: keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // Step 1: Navigate to user self page
    console.log(`[notify] 导航到 ${SELF_URL}`);
    await page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Step 2: Click the notification bell icon to open the panel
    console.log('[notify] 尝试打开通知面板...');

    await page.waitForTimeout(2000);

    let panelOpened = false;

    try {
      const bell = await findNotificationBell(page);
      if (!bell) throw new Error('bell-not-found');
      const box = await bell.locator.boundingBox();
      if (box) {
        console.log(`[notify] 找到铃铛 selector=${bell.selector}, hover (${box.x.toFixed(0)}, ${box.y.toFixed(0)})...`);
        // Mouse move to keep dropdown open (no click needed for hover menus)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1000);

        panelOpened = await page.evaluate(() => {
          const panels = document.querySelectorAll('[class*="notice"], [class*="notification"], [class*="message-panel"], [class*="slide"], [class*="drawer"], [class*="sidebar"], [role="dialog"], [class*="popup"], [class*="popper"]');
          for (const el of panels) {
            if (el.offsetHeight > 100) return true;
          }
          return false;
        });
      }
      if (panelOpened) {
        console.log('[notify] 通知面板已打开（hover）!');
      } else {
        // Try clicking instead of hover
        console.log('[notify] hover 无效，尝试 click...');
        await bell.locator.click({ timeout: 5000 });
        await page.waitForTimeout(1000);
      }
    } catch {
      console.log('[notify] SVG 定位失败...');
    }

    // Fallback: click "通知" text
    if (!panelOpened) {
      await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if ((el.innerText || '').trim() === '通知' && el.children.length <= 2) {
            (el).click();
            break;
          }
        }
      });
      await page.waitForTimeout(1000);
    }

    // Step 3: Wait for dropdown to appear
    await page.waitForTimeout(1500);

    // Step 4: Capture the notification panel
    console.log('[notify] 采集通知面板数据...');

    const info = await capturePageDiagnostics(page);
    info.collectedAt = new Date().toISOString();
    writeJSON(path.join(sessionDir, 'page-info.json'), info);
    console.log(`[notify]   ✓ page-info.json — ${info.url}`);

    const visibleText = await extractVisibleText(page);
    writeFileSync(path.join(sessionDir, 'visible-text.txt'), visibleText, 'utf8');
    console.log(`[notify]   ✓ visible-text.txt — ${visibleText.length} 字符`);

    const screenshotOk = await captureFullScreenshot(page, path.join(sessionDir, 'screenshot-full.png'));
    console.log(`[notify]   ✓ screenshot-full.png — ${screenshotOk ? 'OK' : 'FAIL'}`);

    const domHtml = await captureDomFragment(page);
    writeFileSync(path.join(sessionDir, 'dom-fragment.html'), domHtml, 'utf8');
    console.log(`[notify]   ✓ dom-fragment.html — ${domHtml.split('\n').length} 行`);

    // Step 5: Extract notification items from the dropdown
    const notifications = await page.evaluate(() => {
      // Look for notification list items in the dropdown
      // Common patterns: list items with user avatar + action text
      const items = [];
      
      // Try to find notification panel container
      const panels = document.querySelectorAll('[class*="notice"], [class*="notification"], [class*="message-panel"], [class*="popup"], [class*="dropdown"], [class*="popper"]');
      
      for (const panel of panels) {
        if (panel.offsetHeight === 0) continue; // hidden
        
        // Find list items inside
        const listItems = panel.querySelectorAll('[class*="item"], [class*="list-item"], li, [class*="row"]');
        
        for (const item of listItems) {
          const text = (item.innerText || '').trim();
          if (!text || text.length < 3) continue;
          
          items.push({
            text: text.slice(0, 300),
            html: item.outerHTML.slice(0, 500),
          });
        }
      }

      // If panel search found nothing, try a broader approach
      if (items.length === 0) {
        const allVisible = Array.from(document.querySelectorAll('*')).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 100 && rect.height > 100 && rect.top > 40 && rect.top < 200;
        });
        for (const el of allVisible) {
          const text = (el.innerText || '').trim();
          if (text.length > 5 && text.length < 500) {
            items.push({ text: text.slice(0, 300), broad: true });
          }
        }
      }

      return items;
    });

    writeJSON(path.join(sessionDir, 'notification-items.json'), notifications);
    console.log(`[notify]   ✓ notification-items.json — ${notifications.length} 条通知`);

    console.log('');
    console.log('[notify] ====== 采集完成 ======');
    console.log(`[notify] 通知条目: ${notifications.length}`);
    for (const n of notifications.slice(0, 10)) {
      console.log(`[notify]   ${n.text.slice(0, 80)}`);
    }
    if (notifications.length > 10) {
      console.log(`[notify]   ... 共 ${notifications.length} 条`);
    }

  } catch (err) {
    console.error('[notify] 错误:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser && !keepOpen) {
      console.log('[notify] 关闭浏览器...');
      await browser.close();
    } else if (browser) {
      console.log('[notify] --keep-open 已指定，浏览器保持打开。按 Ctrl+C 退出。');
    }
  }
}

main().catch((err) => {
  console.error('[notify] 未捕获错误:', err.message);
  process.exit(1);
});
