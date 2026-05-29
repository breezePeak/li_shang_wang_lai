/**
 * interactions:inspect — 页面探测模块 CLI
 * 打开浏览器 → 用户手动导航到互动页 → 采集诊断数据
 */
import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  capturePageDiagnostics,
  extractVisibleText,
  extractKeywordElements,
  extractClickableUsers,
  captureFullScreenshot,
  captureDomFragment,
} from '../browser/page-diagnostics.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import logger from '../utils/logger.mjs';

import path from 'path';
import { writeFileSync } from 'fs';
import readline from 'readline';

const KEYWORDS = [
  '赞', '点赞', '评论', '回复',
  '好友', '朋友', '互相关注', '关注了你',
  '作品', '主页',
];

const PAGE_URLS = {
  comment: [
    'https://creator.douyin.com/creator-micro/interactive/comment',
  ],
  like: [
    'https://www.douyin.com/user/self',
  ],
  notice: [
    'https://creator.douyin.com/creator-micro/interactive/notice',
    'https://creator.douyin.com/creator-micro/content/notice',
  ],
};

/**
 * 生成中国时区的时间戳目录名
 * @returns {string} YYYY-MM-DD_HH-mm-ss
 */
function chinaTimestamp() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}-${get('second')}`;
}

/**
 * 等待用户按回车
 * @returns {Promise<void>}
 */
function promptForEnter(message = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  // Parse --page argument
  const args = process.argv.slice(2);
  const pageArgIdx = args.indexOf('--page');
  const pageType = pageArgIdx >= 0 ? args[pageArgIdx + 1] : 'comment';
  const urls = PAGE_URLS[pageType] || PAGE_URLS.comment;

  logger.setLevel('INFO');

  // 1. 创建输出目录
  const outputRoot = path.resolve(process.cwd(), 'interactions-output', 'inspect');
  const sessionDir = path.join(outputRoot, chinaTimestamp());
  ensureDir(sessionDir);

  console.log(`[inspect] 输出目录: ${sessionDir}`);
  console.log(`[inspect] 探测目标: ${pageType} (${urls.length} 个候选 URL)`);

  let browser = null;

  try {
    // 2. 启动浏览器
    console.log('[inspect] 正在启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;

    const pages = ctx.context.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // 3. 尝试导航到目标页面
    let navigated = false;
    for (const url of urls) {
      try {
        console.log(`[inspect] 尝试导航: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        navigated = true;
        break;
      } catch {
        console.log(`[inspect] 导航失败: ${url}`);
      }
    }

    if (!navigated) {
      console.log('[inspect] 自动导航失败，请在浏览器中手动打开目标页面。');
    }

    // 4. 等待用户确认
    console.log('');
    console.log('[inspect] 已打开浏览器。');
    console.log('[inspect] 请手动导航到目标页面（如互动通知/消息页）。');
    console.log('[inspect] 确认页面已加载完成后，按回车键开始采集...');
    await promptForEnter();

    // 5. 采集诊断数据
    console.log('[inspect] 正在采集页面数据...');

    // a. 页面基本信息
    const info = await capturePageDiagnostics(page);
    info.collectedAt = new Date().toISOString();
    writeJSON(path.join(sessionDir, 'page-info.json'), info);
    console.log(`[inspect]   ✓ page-info.json — ${info.url || '(无 URL)'}`);

    // b. 可见文本
    const visibleText = await extractVisibleText(page);
    writeFileSync(path.join(sessionDir, 'visible-text.txt'), visibleText, 'utf8');
    console.log(`[inspect]   ✓ visible-text.txt — ${visibleText.length} 字符`);

    // c. 关键词元素
    const keywordElements = await extractKeywordElements(page, KEYWORDS);
    writeJSON(path.join(sessionDir, 'keyword-elements.json'), keywordElements);
    console.log(`[inspect]   ✓ keyword-elements.json — ${keywordElements.length} 个匹配元素`);

    // d. 可点击用户元素
    const clickableUsers = await extractClickableUsers(page);
    writeJSON(path.join(sessionDir, 'clickable-users.json'), clickableUsers);
    console.log(`[inspect]   ✓ clickable-users.json — ${clickableUsers.length} 个用户元素`);

    // e. 全页截图
    const screenshotPath = path.join(sessionDir, 'screenshot-full.png');
    const screenshotOk = await captureFullScreenshot(page, screenshotPath);
    if (screenshotOk) {
      console.log(`[inspect]   ✓ screenshot-full.png`);
    } else {
      console.log(`[inspect]   ⚠ screenshot-full.png — 截图失败（已跳过）`);
    }

    // f. DOM 片段
    const domHtml = await captureDomFragment(page);
    writeFileSync(path.join(sessionDir, 'dom-fragment.html'), domHtml, 'utf8');
    const domLines = domHtml.split('\n').length;
    console.log(`[inspect]   ✓ dom-fragment.html — ${domLines} 行`);

    // 6. 打印摘要
    console.log('');
    console.log('[inspect] ====== 采集完成 ======');
    console.log(`[inspect] 关键词元素数量: ${keywordElements.length}`);
    console.log(`[inspect] 可点击用户数量: ${clickableUsers.length}`);
    console.log(`[inspect] 输出目录: ${sessionDir}`);
    console.log('');
    console.log('[inspect] 所有诊断文件已保存完毕。');

  } catch (err) {
    console.error('[inspect] 发生错误:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      console.log('[inspect] 正在关闭浏览器...');
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error('[inspect] 未捕获错误:', err.message);
  process.exit(1);
});
