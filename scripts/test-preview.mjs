import { chromium } from 'playwright';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');

async function main() {
  console.log('=== 预演模式测试 ===');
  console.log('[1] 启动浏览器...');

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      slowMo: 150,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 800 },
    });
  } catch (e) {
    console.log('[1] Playwright chromium 失败，尝试系统 Chrome...');
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      slowMo: 150,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 800 },
    });
  }

  const page = context.pages()[0] || await context.newPage();
  console.log('[1] 浏览器启动成功');

  console.log('[2] 打开抖音主页...');
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log('[2] 页面标题:', await page.title());

  console.log('[3] hover 通知铃铛...');
  const bell = page.locator('svg.LtuRRess').first();
  await bell.hover({ timeout: 5000 });
  await page.waitForTimeout(3000);

  const ACTION_PATTERNS = ['评论了你的作品', '回复了你的评论'];

  console.log('[4] 找评论通知...');
  const thumbInfo = await page.evaluate((ACTION_PATTERNS) => {
    function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    }

    const panel = findNotificationPanel();
    if (!panel) return { error: 'no panel' };

    const allElements = panel.querySelectorAll('*');
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 5) continue;
      let actionCount = 0;
      for (const pat of ACTION_PATTERNS) {
        let idx = text.indexOf(pat);
        while (idx !== -1) { actionCount++; idx = text.indexOf(pat, idx + 1); }
      }
      if (actionCount === 1) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const imgs = el.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (src.includes('aweme-avatar')) continue;
            const imgRect = img.getBoundingClientRect();
            if (imgRect.width < 20 || imgRect.height < 20) continue;
            return {
              ok: true,
              itemText: text.slice(0, 200),
              x: Math.round(imgRect.x + imgRect.width / 2),
              y: Math.round(imgRect.y + imgRect.height / 2),
            };
          }
        }
      }
    }
    return { error: 'no thumbnail found' };
  }, ACTION_PATTERNS);

  if (thumbInfo.error) {
    console.log('[4] 找不到评论通知:', thumbInfo.error);
    await context.close();
    return;
  }

  console.log('[4] 找到通知:', thumbInfo.itemText.slice(0, 80));

  console.log('[5] 点击缩略图...');
  await page.mouse.click(thumbInfo.x, thumbInfo.y);
  await page.waitForTimeout(5000);

  const urlAfter = page.url();
  console.log('[5] 点击后 URL:', urlAfter);

  const modalIdMatch = urlAfter.match(/[?&]modal_id=([^&#]+)/);
  if (!modalIdMatch) {
    console.log('[5] 未检测到 modal_id，可能未进入 modal');
    await context.close();
    return;
  }
  console.log('[5] modalId:', modalIdMatch[1]);

  console.log('[6] 等待 modal 加载...');
  await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: 10000 });
  await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
  console.log('[6] modal 已加载');

  console.log('[7] 扫描评论...');
  const comments = await page.evaluate(() => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return [];
    const items = commentArea.querySelectorAll('.comment-item-info-wrap');
    const result = [];
    for (let i = 0; i < items.length; i++) {
      const text = (items[i].innerText || '').trim();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const actorName = lines[0] || '';
      let commentText = '';
      for (let k = 1; k < lines.length; k++) {
        if (lines[k] === '回复' || lines[k] === '赞' || lines[k] === '分享') continue;
        if (!commentText && lines[k].length > 0) { commentText = lines[k]; break; }
      }
      const hasReplySpan = items[i].querySelectorAll('span');
      let hasReply = false;
      for (const span of hasReplySpan) {
        if ((span.innerText || '').trim() === '回复') { hasReply = true; break; }
      }
      result.push({ index: i, actorName, commentText: commentText.slice(0, 80), hasReply });
    }
    return result;
  });

  console.log(`[7] 找到 ${comments.length} 条评论:`);
  for (const c of comments) {
    console.log(`    #${c.index}: ${c.actorName} "${c.commentText}" (回复按钮: ${c.hasReply})`);
  }

  if (comments.length === 0) {
    console.log('[8] 无评论，退出');
    await context.close();
    return;
  }

  const target = comments.find(c => c.hasReply) || comments[0];
  console.log(`[8] 选择第 ${target.index} 条评论进行预演回复`);

  console.log('[9] 点击回复按钮...');
  const replyClicked = await page.evaluate((targetIndex) => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return false;
    const items = commentArea.querySelectorAll('.comment-item-info-wrap');
    if (targetIndex >= items.length) return false;
    const spans = items[targetIndex].querySelectorAll('span');
    for (const span of spans) {
      if ((span.innerText || '').trim() === '回复') {
        span.click();
        return true;
      }
    }
    return false;
  }, target.index);

  if (!replyClicked) {
    console.log('[9] 点击回复按钮失败');
    await context.close();
    return;
  }
  console.log('[9] 已点击回复按钮');
  await page.waitForTimeout(1000);

  console.log('[10] 填入预演回复文本...');
  const previewText = `感谢你的评论！这是一条预演回复（未发送）`;
  const filled = await page.evaluate((text) => {
    const commentArea = document.querySelector('.comment-mainContent');
    const scope = commentArea || document.body;
    const inputs = scope.querySelectorAll('input[type="text"]');
    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 20) continue;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return true;
    }
    return false;
  }, previewText);

  if (filled) {
    console.log('[10] ✅ 预演成功！回复文本已填入输入框，未点击发送');
    console.log('[10] 请在浏览器中确认回复内容，然后可以手动点击发送或关闭');
  } else {
    console.log('[10] ❌ 填入失败，找不到输入框');
  }

  console.log('[11] 浏览器保持打开 60 秒供检查...');
  await page.waitForTimeout(60000);

  await context.close();
  console.log('完成');
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });