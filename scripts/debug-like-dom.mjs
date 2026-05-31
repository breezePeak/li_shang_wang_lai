import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createBrowserContext } from '../src/browser/browser-context.mjs';

function parseArgs(argv) {
  const args = {
    url: '',
    out: '',
    waitMs: 5000,
    keepOpen: false,
    selector: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i] || '';
    else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length);
    else if (arg === '--out') args.out = argv[++i] || '';
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--wait-ms') args.waitMs = Number(argv[++i] || args.waitMs);
    else if (arg.startsWith('--wait-ms=')) args.waitMs = Number(arg.slice('--wait-ms='.length));
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--selector') args.selector = argv[++i] || '';
    else if (arg.startsWith('--selector=')) args.selector = arg.slice('--selector='.length);
  }
  return args;
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.out || `data/debug/like-dom/${stamp()}`);

async function main() {
  mkdirSync(outDir, { recursive: true });

  console.log('[like-dom] 启动/复用浏览器，只读采集，不点击页面');
  const { context } = await createBrowserContext({
    headless: false,
    enableReuse: true,
    slowMo: 80,
  });
  const page = context.pages()[0] || await context.newPage();

  if (args.url) {
    console.log(`[like-dom] 打开视频页: ${args.url}`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    console.log(`[like-dom] 未传 --url，使用当前页面: ${page.url()}`);
  }

  await page.waitForTimeout(Number.isFinite(args.waitMs) ? args.waitMs : 5000);

  const fullDom = await page.evaluate(() => document.documentElement.outerHTML);
  writeFileSync(resolve(outDir, 'full-dom.html'), fullDom, 'utf8');

  const report = await page.evaluate((customSelector) => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function attrs(el) {
      const out = {};
      for (const attr of Array.from(el.attributes || [])) {
        out[attr.name] = attr.value;
      }
      return out;
    }

    function styleOf(el) {
      const s = window.getComputedStyle(el);
      return {
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        color: s.color,
        fill: s.fill,
        stroke: s.stroke,
        backgroundColor: s.backgroundColor,
        cursor: s.cursor,
        pointerEvents: s.pointerEvents,
      };
    }

    function rectOf(el) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
      };
    }

    function nodeSummary(el, selector, index) {
      const svgs = Array.from(el.querySelectorAll('svg')).slice(0, 10).map((svg, svgIndex) => ({
        index: svgIndex,
        tag: svg.tagName.toLowerCase(),
        attrs: attrs(svg),
        style: styleOf(svg),
        rect: rectOf(svg),
        outerHTML: svg.outerHTML.slice(0, 2000),
      }));
      const paths = Array.from(el.querySelectorAll('path, use')).slice(0, 30).map((path, pathIndex) => ({
        index: pathIndex,
        tag: path.tagName.toLowerCase(),
        attrs: attrs(path),
        style: styleOf(path),
        rect: rectOf(path),
        outerHTML: path.outerHTML.slice(0, 1000),
      }));
      const children = Array.from(el.children).slice(0, 20).map((child, childIndex) => ({
        index: childIndex,
        tag: child.tagName.toLowerCase(),
        attrs: attrs(child),
        text: (child.innerText || child.textContent || '').trim().slice(0, 300),
        style: styleOf(child),
        rect: rectOf(child),
        outerHTML: child.outerHTML.slice(0, 1500),
      }));

      return {
        selector,
        index,
        tag: el.tagName.toLowerCase(),
        attrs: attrs(el),
        text: (el.innerText || el.textContent || '').trim().slice(0, 1000),
        className: typeof el.className === 'string' ? el.className : '',
        visible: isVisible(el),
        style: styleOf(el),
        rect: rectOf(el),
        childCount: el.children.length,
        svgs,
        paths,
        children,
        outerHTML: el.outerHTML.slice(0, 10000),
      };
    }

    const selectors = [
      '.t5VMknM2 .MinpposV > .AOWKbsTg',
      '.t5VMknM2 .MinpposV',
      '[data-e2e*="like"]',
      '[data-e2e*="digg"]',
      '[aria-label*="赞"]',
      '[title*="赞"]',
      '[class*="like"]',
      '[class*="digg"]',
      'button',
      '[role="button"]',
      customSelector,
    ].filter(Boolean);

    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      nodes.slice(0, 20).forEach((el, index) => {
        if (seen.has(el)) return;
        seen.add(el);
        candidates.push(nodeSummary(el, selector, index));
      });
    }

    const actionBar = document.querySelector('.t5VMknM2 .MinpposV');
    const actionItems = actionBar
      ? Array.from(actionBar.children).map((el, index) => nodeSummary(el, '.t5VMknM2 .MinpposV > *', index))
      : [];

    const bodyText = document.body?.innerText || '';
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
      bodyTextSample: bodyText.slice(0, 2000),
      bodyTextLength: bodyText.length,
      actionBarFound: Boolean(actionBar),
      actionBar: actionBar ? nodeSummary(actionBar, '.t5VMknM2 .MinpposV', 0) : null,
      actionItems,
      candidates,
    };
  }, args.selector);

  writeFileSync(resolve(outDir, 'like-dom-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await page.screenshot({ path: resolve(outDir, 'page.png'), fullPage: true }).catch(() => {});

  console.log(`[like-dom] full-dom.html 已保存: ${resolve(outDir, 'full-dom.html')}`);
  console.log(`[like-dom] like-dom-report.json 已保存: ${resolve(outDir, 'like-dom-report.json')}`);
  console.log(`[like-dom] actionBarFound=${report.actionBarFound} actionItems=${report.actionItems.length} candidates=${report.candidates.length}`);
  if (report.actionItems.length > 0) {
    const first = report.actionItems[0];
    console.log(`[like-dom] actionItems[0] text="${first.text.slice(0, 80)}" class="${first.className.slice(0, 120)}"`);
  }

  if (args.keepOpen) {
    console.log('[like-dom] --keep-open 已启用，浏览器保持 60 秒');
    await page.waitForTimeout(60000);
  }

  await context.close();
}

main().catch(err => {
  console.error('[like-dom] 失败:', err);
  process.exit(1);
});
