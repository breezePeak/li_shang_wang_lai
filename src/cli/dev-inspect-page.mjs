import { createBrowserContext } from '../browser/browser-context.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { writeFileSync } from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = {
    keepOpen: true,
    url: 'https://www.douyin.com/user/self',
    label: '',
    waitAfterEnterMs: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep-open') args.keepOpen = true;
    else if (argv[i] === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (argv[i] === '--label' && argv[i + 1]) args.label = argv[++i];
    else if (argv[i] === '--wait-after-enter-ms' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n >= 0) args.waitAfterEnterMs = n;
    }
  }
  return args;
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function waitForEnter(message) {
  return new Promise(resolve => {
    process.stdout.write(message);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function getOutputDir(label) {
  const base = path.resolve('data', 'debug', 'page-inspect');
  const ts = getTimestamp();
  const suffix = label ? `-${label}` : '';
  return path.join(base, `${ts}${suffix}`);
}

async function collectPageInfo(page, options) {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    htmlLength: document.documentElement.outerHTML.length,
    visibleTextLength: (document.body?.innerText || '').length,
  }));
  const ua = await page.evaluate(() => navigator.userAgent);
  return {
    ...info,
    userAgent: ua,
    collectedAt: new Date().toISOString(),
    label: options.label || '',
    htmlLength: info.htmlLength,
    visibleTextLength: info.visibleTextLength,
  };
}

async function collectInteractables(page) {
  return page.evaluate(() => {
    const elements = document.querySelectorAll(
      'a, button, input, textarea, select, [role="button"], [role="textbox"], [contenteditable="true"], [tabindex]'
    );
    const results = [];
    const visited = new Set();
    for (const el of elements) {
      const key = el.tagName + ':' + (el.id || '') + ':' + ((el.textContent || '').trim().slice(0, 40));
      if (visited.has(key)) continue;
      visited.add(key);
      const rect = el.getBoundingClientRect();
      results.push({
        index: results.length,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 120),
        href: el.getAttribute('href') || '',
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        placeholder: el.getAttribute('placeholder') || '',
        className: (el.className || '').slice(0, 200),
        id: el.id || '',
        dataset: Object.fromEntries(Object.entries(el.dataset).map(([k, v]) => [k, (v || '').slice(0, 80)])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
        disabled: el.disabled || false,
        cursor: getComputedStyle(el).cursor,
      });
    }
    return results;
  });
}

async function collectLinks(page) {
  return page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    return Array.from(links).map((el, i) => {
      const rect = el.getBoundingClientRect();
      return {
        index: i,
        text: (el.textContent || '').trim().slice(0, 120),
        href: el.getAttribute('href') || '',
        className: (el.className || '').slice(0, 200),
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        dataset: Object.fromEntries(Object.entries(el.dataset).map(([k, v]) => [k, (v || '').slice(0, 80)])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  });
}

async function collectImages(page) {
  return page.evaluate(() => {
    const imgs = document.querySelectorAll('img, picture img');
    return Array.from(imgs).map((el, i) => {
      const rect = el.getBoundingClientRect();
      let parentText = '';
      let parentClassName = '';
      let p = el.parentElement;
      for (let j = 0; j < 3 && p; j++) {
        if ((p.textContent || '').trim()) parentText = (p.textContent || '').trim().slice(0, 120);
        if (p.className) parentClassName = (p.className || '').slice(0, 200);
        if (parentText) break;
        p = p.parentElement;
      }
      return {
        index: i,
        src: el.getAttribute('src') || '',
        alt: el.getAttribute('alt') || '',
        className: (el.className || '').slice(0, 200),
        width: el.width,
        height: el.height,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        parentText,
        parentClassName,
      };
    });
  });
}

async function collectInputs(page) {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]');
    return Array.from(inputs).map((el, i) => {
      const rect = el.getBoundingClientRect();
      const value = el.value !== undefined ? String(el.value).slice(0, 80) : (el.textContent || '').trim().slice(0, 80);
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        valuePreview: value,
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        className: (el.className || '').slice(0, 200),
        visible: rect.width > 0 && rect.height > 0,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  });
}

async function collectButtons(page) {
  return page.evaluate(() => {
    const buttonTexts = ['回复', '发送', '评论', '点赞', '赞', '关注', '私信', '展开', '查看更多'];
    const results = [];
    const visited = new Set();

    const sel = document.querySelectorAll('button, [role="button"]');
    for (const el of sel) {
      const key = el.tagName + ':' + (el.id || '') + ':' + ((el.textContent || '').trim().slice(0, 40));
      if (visited.has(key)) continue;
      visited.add(key);
      const rect = el.getBoundingClientRect();
      results.push({
        index: results.length,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 120),
        href: el.getAttribute('href') || '',
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        placeholder: el.getAttribute('placeholder') || '',
        className: (el.className || '').slice(0, 200),
        id: el.id || '',
        dataset: Object.fromEntries(Object.entries(el.dataset).map(([k, v]) => [k, (v || '').slice(0, 80)])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
        disabled: el.disabled || false,
        cursor: getComputedStyle(el).cursor,
      });
    }

    const allEls = document.querySelectorAll('span, div');
    for (const el of allEls) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.cursor !== 'pointer') {
        const matched = buttonTexts.some(t => text === t || text.startsWith(t));
        if (!matched) continue;
      }
      const key = el.tagName + ':' + (el.id || '') + ':' + text.slice(0, 40);
      if (visited.has(key)) continue;
      visited.add(key);
      const rect = el.getBoundingClientRect();
      results.push({
        index: results.length,
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 120),
        href: '',
        type: '',
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        placeholder: '',
        className: (el.className || '').slice(0, 200),
        id: el.id || '',
        dataset: Object.fromEntries(Object.entries(el.dataset).map(([k, v]) => [k, (v || '').slice(0, 80)])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
        disabled: false,
        cursor: cs.cursor,
      });
    }

    return results;
  });
}

async function collectModalCandidates(page) {
  return page.evaluate(() => {
    const sel = document.querySelectorAll(
      '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="drawer"], [class*="panel"], [class*="popover"], [role="dialog"]'
    );
    return Array.from(sel).map((el, i) => {
      const rect = el.getBoundingClientRect();
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        className: (el.className || '').slice(0, 300),
        id: el.id || '',
        textPreview: (el.textContent || '').trim().slice(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0,
        htmlPreview: el.outerHTML.slice(0, 500),
      };
    });
  });
}

async function collectCommentCandidates(page) {
  return page.evaluate(() => {
    const sel = document.querySelectorAll(
      '[class*="comment"], [class*="reply"], [class*="Comment"], [class*="Reply"]'
    );
    return Array.from(sel).map((el, i) => {
      const rect = el.getBoundingClientRect();
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        className: (el.className || '').slice(0, 300),
        textPreview: (el.textContent || '').trim().slice(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        childrenCount: el.children.length,
        htmlPreview: el.outerHTML.slice(0, 500),
      };
    });
  });
}

async function collectStorage(page) {
  return page.evaluate(() => {
    const result = { localStorage: [], sessionStorage: [] };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const val = localStorage.getItem(key) || '';
        result.localStorage.push({ key, valuePreview: val.slice(0, 80) });
      }
    } catch {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        const val = sessionStorage.getItem(key) || '';
        result.sessionStorage.push({ key, valuePreview: val.slice(0, 80) });
      }
    } catch {}
    return result;
  });
}

async function captureCurrentPage(page, outputDir, options) {
  ensureDir(outputDir);

  const files = [];

  const writeJson = (name, data) => {
    writeJSON(path.join(outputDir, name), data);
    files.push(name);
  };

  writeJson('page-info.json', await collectPageInfo(page, options));

  try {
    await page.screenshot({ path: path.join(outputDir, 'screenshot-full.png'), fullPage: true });
    files.push('screenshot-full.png');
  } catch { files.push('screenshot-full.png (failed)'); }

  try {
    await page.screenshot({ path: path.join(outputDir, 'screenshot-viewport.png'), fullPage: false });
    files.push('screenshot-viewport.png');
  } catch { files.push('screenshot-viewport.png (failed)'); }

  try {
    const html = await page.content();
    writeFileSync(path.join(outputDir, 'dom.html'), html, 'utf8');
    files.push('dom.html');
  } catch { files.push('dom.html (failed)'); }

  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    writeFileSync(path.join(outputDir, 'visible-text.txt'), text, 'utf8');
    files.push('visible-text.txt');
  } catch { files.push('visible-text.txt (failed)'); }

  writeJson('interactables.json', await collectInteractables(page));
  writeJson('links.json', await collectLinks(page));
  writeJson('images.json', await collectImages(page));
  writeJson('inputs.json', await collectInputs(page));
  writeJson('buttons.json', await collectButtons(page));
  writeJson('modal-candidates.json', await collectModalCandidates(page));
  writeJson('comment-candidates.json', await collectCommentCandidates(page));
  writeJson('storage.json', await collectStorage(page));

  const interactables = await collectInteractables(page).catch(() => []);
  const links = await collectLinks(page).catch(() => []);
  const images = await collectImages(page).catch(() => []);
  const inputs = await collectInputs(page).catch(() => []);
  const buttons = await collectButtons(page).catch(() => []);
  const commentCandidates = await collectCommentCandidates(page).catch(() => []);
  const modalCandidates = await collectModalCandidates(page).catch(() => []);

  const domStats = {
    elements: interactables.length,
    links: links.length,
    images: images.length,
    buttons: buttons.length,
    inputs: inputs.length,
    commentCandidates: commentCandidates.length,
    modalCandidates: modalCandidates.length,
  };
  writeJson('dom-stats.json', domStats);

  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error('[dev:inspect] 调试页面采集工具');
  console.error(`[dev:inspect] 目标 URL: ${args.url}`);
  if (args.label) console.error(`[dev:inspect] 标签: ${args.label}`);

  let browser = null;
  let context = null;

  try {
    console.error('[dev:inspect] 启动浏览器...');
    const ctx = await createBrowserContext({
      headless: false,
      enableReuse: args.keepOpen,
    });
    context = ctx.context;
    browser = ctx.browser;

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    console.error(`[dev:inspect] 打开 ${args.url}...`);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      console.error('[dev:inspect] 导航超时，继续等待用户操作...');
    });

    console.error('[dev:inspect] 浏览器已启动');
    console.error('[dev:inspect] 请在浏览器中手动操作到目标页面/弹窗/modal/通知面板');
    console.error('[dev:inspect] 准备好后，在当前命令窗口按 Enter 开始采集...');

    await waitForEnter('');

    if (args.waitAfterEnterMs > 0) {
      console.error(`[dev:inspect] 等待 ${args.waitAfterEnterMs}ms...`);
      await page.waitForTimeout(args.waitAfterEnterMs);
    }

    const outputDir = getOutputDir(args.label);
    console.error(`[dev:inspect] 采集到: ${outputDir}`);

    const files = await captureCurrentPage(page, outputDir, args);

    console.error('[dev:inspect] 采集完成:');
    for (const f of files) {
      console.error(`  ${f}`);
    }
    console.error('');
    console.error(`[dev:inspect] 输出目录: ${outputDir}`);

  } catch (err) {
    console.error('[dev:inspect] 错误:', err.message);
    process.exitCode = 1;
  } finally {
    if (!args.keepOpen && browser) {
      try { await context.close(); } catch {}
    }
  }
}

main().catch(err => {
  console.error('[dev:inspect] 未捕获错误:', err.message);
  process.exit(1);
});
