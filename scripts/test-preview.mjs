import { chromium } from 'playwright';
import { resolve } from 'path';

const PROFILE_DIR = resolve('.playwright/douyin-profile');

const COMMENT_ON_MY_WORK_PATTERNS = ['评论了你的作品'];

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
  await page.waitForTimeout(5000);

  const panelCheck = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 30) continue;
        let c = el.parentElement;
        for (let i = 0; i < 6 && c && c !== document.body; i++) {
          const cr = c.getBoundingClientRect();
          if (cr.width > 250 && cr.height > 300) return { found: true, w: Math.round(cr.width), h: Math.round(cr.height) };
          c = c.parentElement;
        }
      }
    }
    return { found: false };
  });
  console.log('[3] 通知面板:', JSON.stringify(panelCheck));

  if (!panelCheck.found) {
    console.log('[3] 面板未出现，尝试 click 铃铛...');
    await bell.click({ timeout: 5000 });
    await page.waitForTimeout(5000);
  }

  console.log('[4] 找评论了你的作品通知...');
  const thumbInfo = await page.evaluate((PATTERNS) => {
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

    const panelRect = panel.getBoundingClientRect();
    const ALL_ACTION_PATTERNS = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '评论了你的作品', '回复了你的评论'];
    const allElements = panel.querySelectorAll('*');
    const candidates = [];

    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20) continue;
      if (rect.height > panelRect.height * 0.4) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 5) continue;

      let hasTargetAction = false;
      for (const pat of PATTERNS) {
        if (text.includes(pat)) { hasTargetAction = true; break; }
      }
      if (!hasTargetAction) continue;

      let totalActionCount = 0;
      for (const pat of ALL_ACTION_PATTERNS) {
        let idx = text.indexOf(pat);
        while (idx !== -1) { totalActionCount++; idx = text.indexOf(pat, idx + 1); }
      }
      if (totalActionCount !== 1) continue;

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      const imgs = el.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (src.includes('aweme-avatar')) continue;
        const imgRect = img.getBoundingClientRect();
        if (imgRect.width < 20 || imgRect.height < 20) continue;
        const isLikelyAvatar = imgRect.width <= 60 && imgRect.height <= 60;
        if (imgRect.y < 0 || imgRect.y > window.innerHeight || imgRect.bottom < 0 || imgRect.top > window.innerHeight) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        const finalRect = img.getBoundingClientRect();
        candidates.push({
          ok: true,
          itemText: text.slice(0, 200),
          x: Math.round(finalRect.x + finalRect.width / 2),
          y: Math.round(finalRect.y + finalRect.height / 2),
          imgW: Math.round(finalRect.width),
          imgH: Math.round(finalRect.height),
          imgSrc: src.slice(0, 100),
          isLikelyAvatar,
          priority: isLikelyAvatar ? 0 : 1,
        });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);

    if (candidates.length === 0) {
      const panelText = (panel.innerText || '').trim().slice(0, 500);
      return { error: 'no comment_on_my_work thumbnail found', panelTextPreview: panelText };
    }

    return candidates[0];
  }, COMMENT_ON_MY_WORK_PATTERNS);

  if (thumbInfo.error) {
    console.log('[4] 找不到评论了你的作品通知:', thumbInfo.error);
    if (thumbInfo.panelTextPreview) {
      console.log('[4] 面板内容预览:', thumbInfo.panelTextPreview.slice(0, 300));
    }
    await context.close();
    return;
  }

  console.log('[4] 找到通知:', thumbInfo.itemText.slice(0, 80));
  console.log(`[4] 缩略图: (${thumbInfo.x}, ${thumbInfo.y}) ${thumbInfo.imgW}x${thumbInfo.imgH} src=${thumbInfo.imgSrc}`);

  console.log('[5] 点击缩略图...');
  const urlBefore = page.url();
  await page.mouse.click(thumbInfo.x, thumbInfo.y);
  await page.waitForTimeout(5000);

  const urlAfter = page.url();
  console.log('[5] 点击前:', urlBefore);
  console.log('[5] 点击后:', urlAfter);

  const modalIdMatch = urlAfter.match(/[?&]modal_id=([^&#]+)/);
  if (!modalIdMatch) {
    console.log('[5] 未检测到 modal_id，检查页面状态...');

    const pageInfo = await page.evaluate(() => {
      const url = location.href;
      const title = document.title;
      const hasModal = !!document.querySelector('.modal-video-container');
      const hasComment = !!document.querySelector('.comment-mainContent');
      const videoMatch = url.match(/\/video\/([^/?#]+)/);
      const noteMatch = url.match(/\/note\/([^/?#]+)/);
      return { url, title, hasModal, hasComment, videoId: videoMatch?.[1] || null, noteId: noteMatch?.[1] || null };
    });
    console.log('[5] 页面状态:', JSON.stringify(pageInfo, null, 2));

    if (pageInfo.hasModal && pageInfo.hasComment) {
      console.log('[5] modal 已存在但 URL 无 modal_id，继续测试');
    } else {
      console.log('[5] modal 未出现，可能需要点击其他位置或等待更久');
      await page.waitForTimeout(5000);
      const retryInfo = await page.evaluate(() => ({
        url: location.href,
        hasModal: !!document.querySelector('.modal-video-container'),
        hasComment: !!document.querySelector('.comment-mainContent'),
      }));
      console.log('[5] 重试:', JSON.stringify(retryInfo));

      if (!retryInfo.hasModal) {
        console.log('[5] 仍然没有 modal，退出');
        await context.close();
        return;
      }
    }
  } else {
    console.log('[5] modalId:', modalIdMatch[1]);
  }

  console.log('[6] 等待 modal 加载...');
  try {
    await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
    console.log('[6] modal 已加载');
  } catch (e) {
    console.log('[6] modal 加载失败:', e.message);
    await context.close();
    return;
  }

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

      const commentItem = items[i].closest('[data-e2e="comment-item"]') || items[i].parentElement?.parentElement;
      let replySpanInfo = null;
      if (commentItem) {
        const statsContainer = commentItem.querySelector('.comment-item-stats-container');
        if (statsContainer) {
          const spans = statsContainer.querySelectorAll('span');
          for (const span of spans) {
            if ((span.innerText || '').trim() === '回复') {
              const rect = span.getBoundingClientRect();
              replySpanInfo = { visible: rect.width > 0 && rect.height > 0, y: Math.round(rect.y), inViewport: rect.y >= 0 && rect.y <= window.innerHeight };
              break;
            }
          }
        }
      }

      result.push({ index: i, actorName, commentText: commentText.slice(0, 80), replySpan: replySpanInfo });
    }
    return result;
  });

  console.log(`[7] 找到 ${comments.length} 条评论:`);
  for (const c of comments) {
    console.log(`    #${c.index}: ${c.actorName} "${c.commentText}" 回复span=${JSON.stringify(c.replySpan)}`);
  }

  if (comments.length === 0) {
    console.log('[8] 无评论，退出');
    await context.close();
    return;
  }

  const target = comments.find(c => c.replySpan?.visible && c.replySpan?.inViewport) || comments.find(c => c.replySpan?.visible) || comments[0];
  console.log(`[8] 选择第 ${target.index} 条评论进行预演回复`);

  console.log('[9] 点击回复按钮...');
  const replyClicked = await page.evaluate((targetIndex) => {
    const commentArea = document.querySelector('.comment-mainContent');
    if (!commentArea) return { ok: false, reason: 'no comment area' };
    const items = commentArea.querySelectorAll('.comment-item-info-wrap');
    if (targetIndex >= items.length) return { ok: false, reason: 'index out of range' };

    const targetInfoWrap = items[targetIndex];
    const commentItem = targetInfoWrap.closest('[data-e2e="comment-item"]') || targetInfoWrap.parentElement?.parentElement;

    if (commentItem) {
      const statsContainer = commentItem.querySelector('.comment-item-stats-container');
      if (statsContainer) {
        const spans = statsContainer.querySelectorAll('span');
        for (const span of spans) {
          if ((span.innerText || '').trim() === '回复') {
            const rect = span.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              if (rect.y < 0 || rect.y > window.innerHeight) {
                commentItem.scrollIntoView({ block: 'center', behavior: 'instant' });
              }
              span.click();
              return { ok: true, method: 'stats-container', buttonText: (span.innerText || '').trim() };
            }
          }
        }
      }
    }

    return { ok: false, reason: 'reply span not found' };
  }, target.index);

  if (!replyClicked.ok) {
    console.log('[9] 点击回复按钮失败:', replyClicked.reason);
    await context.close();
    return;
  }
  console.log('[9] 已点击回复按钮:', JSON.stringify(replyClicked));
  await page.waitForTimeout(1500);

  console.log('[10] 查找输入框...');
  const inputInfo = await page.evaluate(() => {
    const allInputs = document.querySelectorAll('input[type="text"]');
    const results = [];
    for (const input of allInputs) {
      const rect = input.getBoundingClientRect();
      const placeholder = input.getAttribute('placeholder') || '';
      const value = input.value || '';
      results.push({
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0,
        placeholder,
        valuePreview: value.slice(0, 80),
        className: (input.className || '').slice(0, 100),
      });
    }
    return results;
  });

  console.log(`[10] 找到 ${inputInfo.length} 个 input[type="text"]:`);
  for (const inp of inputInfo) {
    console.log(`    (${inp.x},${inp.y}) ${inp.w}x${inp.h} visible=${inp.visible} placeholder="${inp.placeholder}" value="${inp.valuePreview}"`);
  }

  const targetInput = inputInfo.find(i => i.visible && i.w > 50 && i.h > 20);
  if (!targetInput) {
    console.log('[10] 没有可见的输入框，退出');
    await context.close();
    return;
  }

  console.log('[11] 填入预演回复文本...');
  const previewText = `感谢你的评论！这是一条预演回复（未发送）`;
  const filled = await page.evaluate((text) => {
    const SEARCH_PHRASES = ['搜索', 'search', '查询'];
    function isSearchInput(input) {
      const ph = (input.getAttribute('placeholder') || '').toLowerCase();
      const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
      return SEARCH_PHRASES.some(s => (ph + ' ' + ariaLabel).includes(s));
    }
    const allInputs = document.querySelectorAll('input[type="text"]');
    const candidates = [];
    for (const input of allInputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 20) continue;
      if (isSearchInput(input)) continue;
      candidates.push({ input, rect, placeholder: input.getAttribute('placeholder') || '' });
    }
    if (candidates.length === 0) return { ok: false };
    for (const c of candidates) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(c.input, text);
      c.input.dispatchEvent(new Event('input', { bubbles: true }));
      c.input.dispatchEvent(new Event('change', { bubbles: true }));
      c.input.focus();
      return { ok: true, placeholder: c.placeholder, valueAfter: c.input.value.slice(0, 80) };
    }
    return { ok: false };
  }, previewText);

  if (filled.ok) {
    console.log(`[11] ✅ 预演成功！回复文本已填入输入框`);
    console.log(`[11] placeholder="${filled.placeholder}" value="${filled.valueAfter}"`);
    console.log(`[11] 请在浏览器中确认回复内容，然后可以手动按 Enter 发送或关闭`);
  } else {
    console.log('[11] ❌ 填入失败，找不到输入框');
  }

  console.log('[12] 检查是否有发送按钮...');
  const sendButtons = await page.evaluate(() => {
    const results = [];
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      if ((span.innerText || '').trim() === '发送') {
        const rect = span.getBoundingClientRect();
        results.push({ tag: 'span', x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 });
      }
    }
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.innerText || '').trim() === '发送') {
        const rect = btn.getBoundingClientRect();
        results.push({ tag: 'button', x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 });
      }
    }
    return results;
  });
  console.log(`[12] 发送按钮: ${sendButtons.length} 个`, sendButtons.length > 0 ? JSON.stringify(sendButtons) : '(无，需用 Enter 发送)');

  console.log('[13] 浏览器保持打开 60 秒供检查...');
  await page.waitForTimeout(60000);

  await context.close();
  console.log('完成');
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });
