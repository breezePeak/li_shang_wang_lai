import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { loadConfig } from '../config/user-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_DIR = resolve(__dirname, '../../.playwright/douyin-profile');
const CDP_PORT = 9224;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const LOCK_FILE = resolve(__dirname, '../../.playwright/.browser-pid');

function resolveConfiguredProfileDir(profileDir) {
  if (!profileDir) return DEFAULT_PROFILE_DIR;
  return resolve(process.cwd(), profileDir);
}

function resolveLaunchOptions(options = {}) {
  const browserConfig = loadConfig().browser || {};
  return {
    headless: options.headless ?? Boolean(browserConfig.headless),
    profileDir: resolveConfiguredProfileDir(options.profileDir ?? browserConfig.profileDir),
    slowMo: options.slowMo ?? Number(browserConfig.slowMo ?? 150),
    enableReuse: options.enableReuse ?? false,
  };
}

function checkPort() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_ENDPOINT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForPort({ timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function isBrowserAlive() {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}

async function connectReusableBrowser() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const contexts = browser.contexts();
  const context = contexts.find(c => {
    try { return c.pages().length > 0; } catch { return false; }
  }) || contexts[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error('CDP 浏览器没有可用 context');
  }
  return { browser, context };
}

async function launchDetachedReusableBrowser({ profileDir, headless }) {
  mkdirSync(profileDir, { recursive: true });
  const executablePath = chromium.executablePath();
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--window-size=1280,800',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];

  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(LOCK_FILE, String(child.pid));
  const ready = await waitForPort({ timeoutMs: 12000 });
  if (!ready) throw new Error('独立浏览器 CDP 端口启动超时');
  return child.pid;
}

/**
 * 创建或复用浏览器上下文（复用登录态）
 *
 * CDP reuse is ONLY enabled in explicit keep-open / debug modes.
 * In Agent mode (keepOpen=false), each command starts and closes its own browser.
 *
 * @param {Object} options
 * @param {boolean} [options.headless=false]
 * @param {string} [options.profileDir]
 * @param {number} [options.slowMo=150]
 * @param {boolean} [options.enableReuse=false] - set to true to allow CDP reuse
 * @returns {Promise<{browser: Object, context: import('playwright').BrowserContext, reused: boolean}>}
 */
export async function createBrowserContext(options = {}) {
  const {
    headless,
    profileDir,
    slowMo,
    enableReuse,
  } = resolveLaunchOptions(options);

  // CDP reuse is only attempted when explicitly enabled (e.g. keep-open mode).
  if (enableReuse) {
    if (await checkPort()) {
      try {
        const { browser, context } = await connectReusableBrowser();
        console.error('[browser] 复用已有浏览器（CDP 连接）');
        return {
          browser: { close: async () => {}, disconnect: async () => { await browser.close().catch(() => {}); } },
          context,
          reused: true,
        };
      } catch {
        // Fall through to detached launch.
      }
    }

    console.error('[browser] 启动独立可复用浏览器...');
    await launchDetachedReusableBrowser({ profileDir, headless });
    const { browser, context } = await connectReusableBrowser();
    return {
      browser: { close: async () => {}, disconnect: async () => { await browser.close().catch(() => {}); } },
      context,
      reused: false,
      detached: true,
    };
  }

  // Launch new browser
  console.error('[browser] 启动新浏览器...');
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    ...(enableReuse ? [`--remote-debugging-port=${CDP_PORT}`] : []),
  ];

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      slowMo,
      args: launchArgs,
      viewport: { width: 1280, height: 800 },
    });
  } catch (launchErr) {
    if (launchErr.message?.includes('ProcessSingleton') || launchErr.message?.includes('EPERM')) {
      console.error('[browser] Playwright chromium 失败，尝试系统 Chrome...');
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless,
        slowMo,
        args: launchArgs,
        viewport: { width: 1280, height: 800 },
      });
    } else {
      throw launchErr;
    }
  }

  return {
    browser: context,
    context,
    reused: false,
  };
}

export async function replaceContextPage(context, previousPage = null) {
  if (!context || typeof context.newPage !== 'function') {
    throw new Error('browser context 不可用，无法创建新页面');
  }

  const nextPage = await context.newPage();

  if (previousPage && previousPage !== nextPage) {
    try {
      if (typeof previousPage.isClosed !== 'function' || !previousPage.isClosed()) {
        await previousPage.close().catch(() => {});
      }
    } catch {}
  }

  return nextPage;
}
