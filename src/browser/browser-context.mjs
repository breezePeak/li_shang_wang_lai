import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_DIR = resolve(__dirname, '../../.playwright/douyin-profile');

/**
 * 创建持久化浏览器上下文，复用登录态
 * @param {Object} options
 * @param {boolean} [options.headless=false]
 * @param {string} [options.profileDir]
 * @param {number} [options.slowMo=150]
 * @returns {Promise<{browser: import('playwright').BrowserContext, context: import('playwright').BrowserContext}>}
 */
export async function createBrowserContext(options = {}) {
  const {
    headless = false,
    profileDir = DEFAULT_PROFILE_DIR,
    slowMo = 150,
  } = options;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    slowMo,
    viewport: { width: 1280, height: 800 },
  });

  return { browser: context, context };
}
