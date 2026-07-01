import { createBrowserContext } from '../browser/browser-context.mjs';
import { clearPrivateMessages, SELF_URL } from '../adapters/message-page.mjs';
import { printJsonError, printJsonResult } from '../utils/cli-output.mjs';

function parseArgs(argv) {
  const args = {
    count: 1,
    keepOpen: false,
    headless: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') {
      const raw = argv[++i];
      const count = Number.parseInt(raw, 10);
      if (!Number.isFinite(count) || count <= 0) {
        throw new Error('--count 必须是大于 0 的整数');
      }
      args.count = count;
      continue;
    }
    if (arg === '--keep-open') {
      args.keepOpen = true;
      continue;
    }
    if (arg === '--headless') {
      args.headless = true;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let browser = null;

  try {
    const ctx = await createBrowserContext({ headless: args.headless, enableReuse: args.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    await page.goto(SELF_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const result = await clearPrivateMessages(page, { count: args.count });
    if (!result.ok) {
      if (args.json) {
        printJsonError('messages:clear', 'PRIVATE_MESSAGE_DELETE_FAILED', result.stoppedReason || 'delete_failed', {
          recoverable: true,
          data: result,
        });
        return;
      }
      console.error(`[messages:clear] 失败: ${result.stoppedReason || 'delete_failed'}`);
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      printJsonResult('messages:clear', result, {
        deletedCount: result.deletedCount,
        requestedCount: result.requestedCount,
      });
      return;
    }

    console.log(`[messages:clear] 已删除 ${result.deletedCount}/${result.requestedCount} 条私信会话`);
  } finally {
    if (browser && !args?.keepOpen) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  if (process.argv.includes('--json')) {
    printJsonError('messages:clear', 'UNKNOWN_ERROR', err.message, { recoverable: false });
    return;
  }
  console.error('[messages:clear] 错误:', err.message);
  process.exit(1);
});
