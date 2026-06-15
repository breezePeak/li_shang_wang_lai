import { createBrowserContext, replaceContextPage } from './browser-context.mjs';

function noopLogger() {}

export function createBrowserSessionManager(options = {}) {
  const {
    headless,
    enableReuse = false,
    logger = noopLogger,
    createContext = createBrowserContext,
    replacePage = replaceContextPage,
  } = options;

  let currentCtx = null;
  let currentBrowser = null;
  let currentPage = null;

  function current() {
    return {
      ctx: currentCtx,
      browser: currentBrowser,
      page: currentPage,
    };
  }

  async function open() {
    if (currentCtx?.context && currentBrowser && currentPage) {
      return current();
    }

    currentCtx = await createContext({
      headless,
      enableReuse,
    });
    currentBrowser = currentCtx.browser;
    currentPage = await replacePage(currentCtx.context, currentCtx.context.pages()[0] || null);
    logger(`[browser-session] opened reuse=${Boolean(enableReuse)}`);
    return current();
  }

  async function replaceCurrentPage() {
    if (!currentCtx?.context) {
      throw new Error('browser session 尚未打开，无法切换页面');
    }
    currentPage = await replacePage(currentCtx.context, currentPage);
    logger('[browser-session] replaced page');
    return currentPage;
  }

  async function closeCurrentPage() {
    if (!currentPage) return;
    try {
      if (typeof currentPage.isClosed !== 'function' || !currentPage.isClosed()) {
        await currentPage.close().catch(() => {});
      }
    } catch {}
    currentPage = null;
  }

  async function closeBrowser() {
    if (!currentBrowser) return;
    await currentBrowser.close().catch(() => {});
    currentBrowser = null;
  }

  async function close() {
    await closeCurrentPage();
    await closeBrowser();
    currentCtx = null;
    logger('[browser-session] closed');
  }

  async function restart(reason = 'manual') {
    logger(`[browser-session] restarting reason=${reason}`);
    await close();
    return open();
  }

  return {
    current,
    open,
    replacePage: replaceCurrentPage,
    restart,
    close,
  };
}
