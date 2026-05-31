import { createBrowserContext } from '../src/browser/browser-context.mjs';
import {
  checkLikeState,
  DOUYIN_PLAYER_ACTION_SELECTORS,
} from '../src/adapters/video-page.mjs';

function parseArgs(argv) {
  const args = {
    url: '',
    waitMs: 5000,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i] || '';
    else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length);
    else if (arg === '--wait-ms') args.waitMs = Number(argv[++i] || args.waitMs);
    else if (arg.startsWith('--wait-ms=')) args.waitMs = Number(arg.slice('--wait-ms='.length));
    else if (arg === '--keep-open') args.keepOpen = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

async function main() {
  console.log('[like-state] 启动浏览器，只读判断点赞状态，不点击页面');
  const { context } = await createBrowserContext({
    headless: false,
    enableReuse: true,
    slowMo: 80,
  });
  const page = context.pages()[0] || await context.newPage();

  if (args.url) {
    console.log(`[like-state] 打开视频页: ${args.url}`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    console.log(`[like-state] 未传 --url，使用当前页面: ${page.url()}`);
  }

  await page.waitForTimeout(Number.isFinite(args.waitMs) ? args.waitMs : 5000);

  const domEvidence = await page.evaluate((selectors) => {
    const likeEl = document.querySelector(selectors.like);
    const actions = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const el = document.querySelector(selector);
      actions[name] = el ? {
        selector,
        dataE2e: el.getAttribute('data-e2e') || '',
        dataE2eState: el.getAttribute('data-e2e-state') || '',
        className: typeof el.className === 'string' ? el.className : '',
        text: (el.innerText || '').trim().slice(0, 80),
      } : null;
    }
    return {
      url: location.href,
      title: document.title,
      likeFound: Boolean(likeEl),
      actions,
    };
  }, DOUYIN_PLAYER_ACTION_SELECTORS);

  console.log('[like-state] DOM evidence:');
  console.log(JSON.stringify(domEvidence, null, 2));

  const state = await checkLikeState(page);
  console.log('[like-state] checkLikeState result:');
  console.log(JSON.stringify(state, null, 2));

  if (state.ok) {
    console.log(`[like-state] 结论: ${state.data.alreadyLiked ? '已赞' : '未赞'} (${state.data.signal})`);
  } else {
    console.log(`[like-state] 结论: 无法确认 (${state.code || 'unknown'}) ${state.message || ''}`);
  }

  if (args.keepOpen) {
    console.log('[like-state] --keep-open 已启用，浏览器保持 60 秒');
    await page.waitForTimeout(60000);
  }

  await context.close();
}

main().catch(err => {
  console.error('[like-state] 失败:', err);
  process.exit(1);
});
