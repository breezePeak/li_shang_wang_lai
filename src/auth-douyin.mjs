import { createBrowserContext } from './browser/browser-context.mjs';

async function main() {
  console.log('[auth] 打开浏览器供扫码登录...');
  const { context } = await createBrowserContext({ headless: false });
  const page = await context.newPage();
  await page.goto('https://creator.douyin.com/');
  console.log('[auth] 请在浏览器中完成扫码登录，完成后按 Ctrl+C 关闭');

  // 保持进程运行直到用户手动终止
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[auth] 错误:', err.message);
  process.exit(1);
});
