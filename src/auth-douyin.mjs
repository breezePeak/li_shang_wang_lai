import { createBrowserContext } from './browser/browser-context.mjs';

const AUTH_URL = 'https://creator.douyin.com/';
const CHECK_INTERVAL_MS = 2000;
const FIRST_PROMPT_MS = 60_000;
const TIMEOUT_MS = 5 * 60_000;
const LOGIN_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
  'passport_auth_status_ss',
  'login_time',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasDouyinLogin(context) {
  const cookies = await context.cookies(['https://www.douyin.com', 'https://creator.douyin.com']);
  return cookies.some(cookie => LOGIN_COOKIE_NAMES.has(cookie.name) && String(cookie.value || '').trim().length > 0);
}

async function main() {
  console.log('[auth] 检查现有登录态...');
  const headlessCtx = await createBrowserContext({ headless: true });
  const alreadyLoggedIn = await hasDouyinLogin(headlessCtx.context);
  await headlessCtx.browser.close();

  if (alreadyLoggedIn) {
    console.log('[auth] 已登录，无需重新认证。');
    return;
  }

  console.log('[auth] 未登录，打开浏览器供扫码登录...');
  const { browser, context } = await createBrowserContext({ headless: false });
  const page = await context.newPage();
  await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded' });
  console.log('[auth] 正在检测抖音登录状态...');

  const startedAt = Date.now();
  let prompted = false;

  try {
    while (Date.now() - startedAt < TIMEOUT_MS) {
      if (await hasDouyinLogin(context)) {
        await browser.close();
        console.log('[auth] 认证成功，浏览器已关闭。');
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (!prompted && elapsed >= FIRST_PROMPT_MS) {
        prompted = true;
        console.log('[auth] 尚未检测到登录状态，请在浏览器中扫码登录。最多等待 5 分钟。');
      }

      await sleep(CHECK_INTERVAL_MS);
    }

    await browser.close();
    console.error('[auth] 验证失败：5 分钟内未检测到抖音登录状态，请重新运行 npm run auth。');
    process.exit(1);
  } catch (err) {
    try { await browser.close(); } catch { /* ignore close failure */ }
    throw err;
  }
}

main().catch((err) => {
  console.error('[auth] 错误:', err.message);
  process.exit(1);
});
