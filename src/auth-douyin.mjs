import { createBrowserContext } from './browser/browser-context.mjs';
import { hasDouyinLoginCookies, inspectDouyinAuthState } from './browser/douyin-auth-state.mjs';

const AUTH_URL = 'https://creator.douyin.com/';
const CHECK_INTERVAL_MS = 2000;
const FIRST_PROMPT_MS = 60_000;
const TIMEOUT_MS = 5 * 60_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hasDouyinLogin(context) {
  return hasDouyinLoginCookies(context);
}

async function inspectExistingLogin(context) {
  if (!await hasDouyinLogin(context)) {
    return { loggedIn: false, reason: 'missing_login_cookie' };
  }
  const page = await context.newPage();
  try {
    await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    return await inspectDouyinAuthState(page, context);
  } catch (err) {
    return { loggedIn: true, reason: 'cookie_present_page_check_failed', warning: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  console.log('[auth] 检查现有登录态...');
  const headlessCtx = await createBrowserContext({ headless: true });
  const existingState = await inspectExistingLogin(headlessCtx.context);
  await headlessCtx.browser.close();

  if (existingState.loggedIn) {
    console.log('[auth] 已登录，无需重新认证。');
    if (existingState.warning) {
      console.log(`[auth] 页面校验未完成，但检测到登录 cookie：${existingState.warning}`);
    }
    return;
  }

  if (existingState.reason === 'security_verification_required') {
    console.log('[auth] 检测到手机号/安全认证弹窗，需要在浏览器中手动完成认证。');
  } else {
    console.log('[auth] 未登录，打开浏览器供扫码登录...');
  }
  const { browser, context } = await createBrowserContext({ headless: false });
  const page = await context.newPage();
  await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded' });
  console.log('[auth] 正在检测抖音登录状态...');

  const startedAt = Date.now();
  let prompted = false;
  let verificationPrompted = existingState.reason === 'security_verification_required';

  try {
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const authState = await inspectDouyinAuthState(page, context);
      if (authState.loggedIn) {
        await browser.close();
        console.log('[auth] 认证成功，浏览器已关闭。');
        return;
      }

      if (authState.reason === 'security_verification_required' && !verificationPrompted) {
        verificationPrompted = true;
        console.log('[auth] 请在打开的浏览器中完成手机号/安全认证。认证完成后会自动继续检测。');
      }

      const elapsed = Date.now() - startedAt;
      if (!prompted && elapsed >= FIRST_PROMPT_MS) {
        prompted = true;
        console.log('[auth] 尚未检测到可用登录状态，请在浏览器中完成扫码或手机号认证。最多等待 5 分钟。');
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
