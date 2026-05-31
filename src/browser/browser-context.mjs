import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_DIR = resolve(__dirname, '../../.playwright/douyin-profile');
const CDP_PORT = 9224;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const LOCK_FILE = resolve(__dirname, '../../.playwright/.browser-pid');

function checkPort() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_ENDPOINT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function isBrowserAlive() {
  if (!existsSync(LOCK_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
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
    headless = false,
    profileDir = DEFAULT_PROFILE_DIR,
    slowMo = 150,
    enableReuse = false,
  } = options;

  // CDP reuse is only attempted when explicitly enabled (e.g. keep-open mode).
  if (enableReuse && isBrowserAlive()) {
    const portOpen = await checkPort();
    if (portOpen) {
      try {
        const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
        const contexts = browser.contexts();
        const context = contexts.find(c => {
          try { return c.pages().length > 0; } catch { return false; }
        }) || contexts[0];
        if (context) {
          console.error('[browser] 复用已有浏览器（CDP 连接）');
          return {
            browser: { close: async () => {} },
            context,
            reused: true,
          };
        }
        await browser.close().catch(() => {});
      } catch {
        // Fall through to fresh launch
      }
    }
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

  // Only write lock file and expose CDP when reuse is explicitly enabled
  if (enableReuse) {
    writeFileSync(LOCK_FILE, String(process.pid));
    process.on('exit', () => {
      try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch {}
    });
  }

  return {
    browser: context,
    context,
    reused: false,
  };
}
