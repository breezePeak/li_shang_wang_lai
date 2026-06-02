// 打开指定页面，不做任何操作，用于手动排查问题
// 用法: npm run debug:open <URL>
// 示例: npm run debug:open https://www.douyin.com/user/self

import { createBrowserContext } from '../browser/browser-context.mjs';

const url = process.argv[2];
if (!url) {
  console.error('用法: npm run debug:open <URL>');
  process.exit(1);
}

const ctx = await createBrowserContext({ headless: false, enableReuse: false });
const pages = ctx.context.pages();
const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log(`[debug:open] 已打开: ${url}`);
console.log('[debug:open] 浏览器保持打开，关闭终端或 Ctrl+C 退出');
