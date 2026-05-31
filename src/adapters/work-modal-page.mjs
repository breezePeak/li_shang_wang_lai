import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

export function extractModalIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/[?&]modal_id=([^&#]+)/);
  return match ? match[1] : null;
}

export async function extractWorkModalContext(page) {
  const currentUrl = page.url();
  const modalId = extractModalIdFromUrl(currentUrl);

  if (!modalId) {
    return blocking(RESULT_CODES.BLOCKED, 'URL 中没有 modal_id，不在作品 modal 中', { recoverable: false });
  }

  let workTitle = '';
  try {
    workTitle = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;

      const specificSelectors = [
        '[class*="video-desc"]',
        '[class*="desc-info"]',
        '[class*="work-desc"]',
        '[class*="aweme-desc"]',
        '[class*="publish-desc"]',
        '[class*="video-info"] [class*="desc"]',
        '[class*="detail-desc"]',
      ];
      for (const sel of specificSelectors) {
        const el = scope.querySelector(sel);
        if (el) {
          const text = (el.innerText || '').trim();
          if (text.length > 2 && text.length < 500 && !text.includes('回复') && !text.includes('评论')) return text;
        }
      }

      const genericDesc = scope.querySelector('[class*="desc"], [class*="caption"], [class*="mark"]');
      if (genericDesc) {
        const text = (genericDesc.innerText || '').trim();
        if (text.length > 2 && text.length < 500 && !text.includes('回复') && !text.includes('评论')) return text;
      }

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = (ogTitle.getAttribute('content') || '').trim();
        if (content.length > 2) return content;
      }

      const title = document.title || '';
      const cleaned = title.replace(/ - 抖音$/, '').replace(/的抖音.*$/, '').trim();
      if (cleaned.length > 2) return cleaned;

      return '';
    });
  } catch {}

  const videoMatch = currentUrl.match(/\/video\/([^/?#]+)/);
  const noteMatch = currentUrl.match(/\/note\/([^/?#]+)/);
  let workType = 'unknown';
  let workId = modalId;
  if (videoMatch) { workType = 'video'; workId = 'video-' + videoMatch[1]; }
  else if (noteMatch) { workType = 'note'; workId = 'note-' + noteMatch[1]; }

  let authorName = '', authorProfileKey = '', authorProfileUrl = '';
  try {
    const authorData = await page.evaluate(() => {
      const modal = document.querySelector('.modal-video-container');
      const scope = modal || document.body;
      let name = '', key = '', url = '';

      const authorLink = scope.querySelector('a[href*="/user/"]');
      if (authorLink) {
        const href = authorLink.getAttribute('href') || '';
        const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
        if (match) { key = match[1]; url = href; }
        const text = (authorLink.innerText || '').trim();
        if (text.length > 0 && text.length < 50) name = text;
      }

      if (!name) {
        const authorEl = scope.querySelector('[class*="author"], [class*="nickname"], [class*="userName"]');
        if (authorEl) {
          const text = (authorEl.innerText || '').trim();
          if (text.length > 0 && text.length < 50) name = text;
        }
      }

      return { name, key, url };
    });
    authorName = authorData.name;
    authorProfileKey = authorData.key;
    authorProfileUrl = authorData.url;
  } catch {}

  return success({
    currentUrl,
    workId,
    workUrl: normalizeDouyinUrl(currentUrl.split('?')[0]) + '?modal_id=' + modalId,
    workTitle: workTitle || null,
    workType,
    modalId,
    isModal: true,
    authorName: authorName || null,
    authorProfileKey: authorProfileKey || null,
    authorProfileUrl: authorProfileUrl || null,
  });
}

export async function waitForWorkModal(page, { timeoutMs = 10000 } = {}) {
  try {
    await page.waitForSelector('.modal-video-container', { state: 'visible', timeout: timeoutMs });
    await page.waitForSelector('.comment-mainContent', { state: 'visible', timeout: 5000 });
    await page.evaluate(MATCH_COMMENT_INNER);
    return success({ modalVisible: true });
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `作品 modal 未出现: ${err.message}`, { recoverable: false });
  }
}

const MATCH_COMMENT_INNER = `
  function matchComment(items, actorName, commentText, eventTimeText) {
    for (let i = 0; i < items.length; i++) {
      const text = (items[i].innerText || '').trim();
      if (!text.includes(commentText)) continue;
      if (actorName && !text.includes(actorName)) continue;
      if (eventTimeText && !text.includes(eventTimeText)) continue;
      const rect = items[i].getBoundingClientRect();
      return { ok: true, commentIndex: i, previewText: text.slice(0, 200), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    for (let i = 0; i < items.length; i++) {
      const text = (items[i].innerText || '').trim();
      if (!text.includes(commentText)) continue;
      const rect = items[i].getBoundingClientRect();
      return { ok: true, commentIndex: i, previewText: text.slice(0, 200), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), fallback: true };
    }
    return null;
  }
`;

export async function findCommentInWorkModal(page, item, { maxScrolls = 10 } = {}) {
  const actorName = (item?.actorName || '').trim();
  const commentText = (item?.commentText || '').trim();
  const eventTimeText = (item?.eventTimeText || '').trim();

  if (!commentText) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, 'commentText 为空，无法定位评论', { recoverable: false });
  }

  try {
    const found = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const items = commentArea.querySelectorAll('.comment-item-info-wrap');
      const match = matchComment(items, actorName, commentText, eventTimeText);
      if (match) return match;

      const canScroll = commentArea.scrollHeight > commentArea.clientHeight + 10;
      return { ok: false, reason: 'no matching comment', totalItems: items.length, canScroll };
    }, { actorName, commentText, eventTimeText });

    if (found.ok) {
      return success(found);
    }

    if (!found.canScroll) {
      return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, found.reason || '评论未找到', { recoverable: true, data: found });
    }

    console.error(`[work-modal] 评论区可滚动，开始滚动查找 (max ${maxScrolls})`);

    for (let s = 0; s < maxScrolls; s++) {
      const scrolled = await page.evaluate(() => {
        const commentArea = document.querySelector('.comment-mainContent');
        if (!commentArea) return { scrolled: false, atEnd: true };
        const prev = commentArea.scrollTop;
        commentArea.scrollTop = commentArea.scrollHeight;
        return { scrolled: true, atEnd: commentArea.scrollTop === prev };
      });

      if (scrolled.atEnd) break;

      await page.waitForTimeout(600);

      const foundAfterScroll = await page.evaluate(({ actorName, commentText, eventTimeText }) => {
        const commentArea = document.querySelector('.comment-mainContent');
        if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };
        const items = commentArea.querySelectorAll('.comment-item-info-wrap');
        const match = matchComment(items, actorName, commentText, eventTimeText);
        if (match) { match.scrolled = true; return match; }
        return { ok: false, reason: 'no matching comment', totalItems: items.length };
      }, { actorName, commentText, eventTimeText });

      if (foundAfterScroll.ok) {
        console.error(`[work-modal] 滚动 ${s + 1} 次后找到评论`);
        return success(foundAfterScroll);
      }
    }

    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, '滚动后仍未找到评论', { recoverable: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, `查找评论异常: ${err.message}`, { recoverable: true });
  }
}

export async function findUnrepliedCommentsInModal(page, { maxScrolls = 10, alreadyRepliedKeys = new Set(), selfNickname = '' } = {}) {
  const allComments = [];

  try {
    const collect = () => page.evaluate(({ alreadyRepliedKeysArr, selfNickname }) => {
      const alreadyRepliedKeys = new Set(alreadyRepliedKeysArr);
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { comments: [], canScroll: false };

      const items = commentArea.querySelectorAll('.comment-item-info-wrap');
      const comments = [];

      for (let i = 0; i < items.length; i++) {
        const text = (items[i].innerText || '').trim();
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 1) continue;

        let actorName = '';
        let commentText = '';
        let hasMyReply = false;
        let commentKey = '';

        const nameLine = lines[0];
        if (nameLine.length > 0 && nameLine.length < 50) actorName = nameLine;

        for (let k = 1; k < lines.length; k++) {
          const line = lines[k];
          if (line === '回复' || line === '赞' || line === '分享') continue;
          if (/^\d+$/.test(line) || /^[刚昨前天周月年]/.test(line) && line.length < 10) continue;
          if (!commentText && line.length > 0) {
            commentText = line;
            break;
          }
        }

        if (!commentText) {
          for (let k = lines.length - 1; k >= 1; k--) {
            const line = lines[k];
            if (line === '回复' || line === '赞' || line === '分享') continue;
            if (line.length > 2 && line.length < 300) {
              commentText = line;
              break;
            }
          }
        }

        const subReplyContainers = items[i].querySelectorAll('.comment-item-info-wrap');
        if (subReplyContainers.length > 0 && selfNickname) {
          for (const sub of subReplyContainers) {
            const subText = (sub.innerText || '').trim();
            const subLines = subText.split('\n').map(l => l.trim()).filter(Boolean);
            if (subLines.length > 0 && subLines[0] === selfNickname) {
              hasMyReply = true;
              break;
            }
          }
        }

        if (!hasMyReply && subReplyContainers.length === 0 && selfNickname) {
          const replyBlocks = items[i].querySelectorAll('[class*="reply"], [class*="sub-comment"]');
          for (const block of replyBlocks) {
            const blockText = (block.innerText || '').trim();
            if (blockText.includes(selfNickname)) {
              hasMyReply = true;
              break;
            }
          }
        }

        commentKey = `${actorName}::${commentText.slice(0, 60)}`;

        const rect = items[i].getBoundingClientRect();
        comments.push({
          commentIndex: i,
          actorName,
          commentText: commentText.slice(0, 300),
          hasMyReply,
          alreadyReplied: alreadyRepliedKeys.has(commentKey),
          commentKey,
          y: Math.round(rect.y),
          visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
        });
      }

      const canScroll = commentArea.scrollHeight > commentArea.clientHeight + 10;
      return { comments, canScroll };
    }, { alreadyRepliedKeysArr: [...alreadyRepliedKeys], selfNickname });

    let result = await collect();
    allComments.push(...result.comments);

    if (result.canScroll) {
      for (let s = 0; s < maxScrolls; s++) {
        const scrolled = await page.evaluate(() => {
          const commentArea = document.querySelector('.comment-mainContent');
          if (!commentArea) return { atEnd: true };
          const prev = commentArea.scrollTop;
          commentArea.scrollTop = commentArea.scrollHeight;
          return { atEnd: commentArea.scrollTop === prev };
        });
        if (scrolled.atEnd) break;
        await page.waitForTimeout(600);

        result = await collect();
        const newComments = result.comments.filter(c => !allComments.some(e => e.commentKey === c.commentKey));
        allComments.push(...newComments);

        if (!result.canScroll) break;
      }
    }

    const unreplied = allComments.filter(c => !c.hasMyReply && !c.alreadyReplied && c.commentText.length > 0);

    console.error(`[work-modal] 评论扫描: 总 ${allComments.length} 条，我未回复 ${unreplied.length} 条`);

    return success({
      total: allComments.length,
      unreplied,
      allKeys: allComments.map(c => c.commentKey),
    });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_ITEM_PARSE_FAILED, `扫描未回复评论异常: ${err.message}`, { recoverable: true });
  }
}

export async function openReplyBoxByIndex(page, commentIndex) {
  console.error(`[work-modal] 按索引打开回复框: commentIndex=${commentIndex}`);

  try {
    const clicked = await page.evaluate((commentIndex) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { ok: false, reason: 'comment-mainContent not found' };

      const items = commentArea.querySelectorAll('.comment-item-info-wrap');
      if (commentIndex < 0 || commentIndex >= items.length) return { ok: false, reason: `index ${commentIndex} out of range (0-${items.length - 1})` };

      const targetItem = items[commentIndex];
      const spans = targetItem.querySelectorAll('span');
      for (const span of spans) {
        if ((span.innerText || '').trim() === '回复') {
          const rect = span.getBoundingClientRect();
          span.click();
          return { ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
      }

      return { ok: false, reason: '回复 span not found in comment item' };
    }, commentIndex);

    if (!clicked.ok) {
      return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, clicked.reason, { recoverable: true });
    }

    console.error(`[work-modal] 已点击回复 span at (${clicked.x}, ${clicked.y})`);

    await page.waitForTimeout(1000);

    const inputVisible = await page.evaluate(() => {
      const commentArea = document.querySelector('.comment-mainContent');
      const scope = commentArea || document.body;
      const inputs = scope.querySelectorAll('input[type="text"]');
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 20) return true;
      }
      return false;
    });

    if (!inputVisible) {
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '点击回复后输入框未出现', { recoverable: true });
    }

    console.error(`[work-modal] 回复输入框已出现`);
    return success({ replyBoxOpened: true });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_REPLY_BUTTON_NOT_FOUND, `打开回复框异常: ${err.message}`, { recoverable: true });
  }
}

export async function fillReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 填入回复(预演): "${replyText.slice(0, 60)}"`);

  try {
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
        return { ok: true };
      }
      return { ok: false };
    }, replyText);

    if (!filled.ok) {
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '找不到回复输入框', { recoverable: true });
    }

    console.error(`[work-modal] 已填入回复，未点击发送`);
    return success({ filled: true, sent: false, method: 'preview' });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, `填入回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function sendReplyInWorkModal(page, replyText) {
  if (!replyText || !replyText.trim()) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空', { recoverable: false });
  }

  console.error(`[work-modal] 发送回复: "${replyText.slice(0, 60)}"`);

  try {
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
        return { ok: true };
      }
      return { ok: false };
    }, replyText);

    if (!filled.ok) {
      return blocking(RESULT_CODES.COMMENT_INPUT_NOT_FOUND, '找不到回复输入框', { recoverable: true });
    }

    await page.waitForTimeout(800);

    const sent = await page.evaluate(() => {
      const commentArea = document.querySelector('.comment-mainContent');
      const scope = commentArea || document.body;

      const spans = scope.querySelectorAll('span');
      for (const span of spans) {
        if ((span.innerText || '').trim() === '发送') {
          span.click();
          return { ok: true, method: 'click_send_span' };
        }
      }

      const buttons = scope.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.innerText || '').trim() === '发送') {
          btn.click();
          return { ok: true, method: 'click_send_button' };
        }
      }

      return { ok: false, reason: 'no_send_button' };
    });

    if (sent.ok) {
      console.error(`[work-modal] 点击发送成功 (${sent.method})`);
      await page.waitForTimeout(2000);
      return success({ sent: true, method: sent.method });
    }

    const commentArea = document.querySelector('.comment-mainContent');
    const scope = commentArea || await page.evaluateHandle(() => document.body);
    const inputLocator = page.locator('.comment-mainContent input[type="text"]').first();
    await inputLocator.press('Enter');
    console.error(`[work-modal] 按 Enter 发送`);
    await page.waitForTimeout(2000);

    return success({ sent: true, method: 'enter_key' });
  } catch (err) {
    return blocking(RESULT_CODES.COMMENT_SEND_BUTTON_NOT_FOUND, `发送回复异常: ${err.message}`, { recoverable: true });
  }
}

export async function verifyReplyInWorkModal(page, item, replyText, { timeoutMs = 5000 } = {}) {
  const commentText = (item?.commentText || '').trim();
  const replyNeedle = replyText.trim();
  const replyPrefix = replyNeedle.slice(0, 20);

  console.error(`[work-modal] 验证回复: "${replyNeedle.slice(0, 40)}"`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await page.evaluate(({ commentText, replyNeedle, replyPrefix }) => {
      const commentArea = document.querySelector('.comment-mainContent');
      if (!commentArea) return { verified: false };

      const text = (commentArea.innerText || '').trim();
      if (text.includes(replyNeedle)) return { verified: true, method: 'full' };
      if (replyPrefix.length >= 5 && text.includes(replyPrefix)) return { verified: true, method: 'prefix' };

      return { verified: false };
    }, { commentText, replyNeedle, replyPrefix });

    if (found.verified) {
      console.error(`[work-modal] 验证成功 method=${found.method}`);
      return success({ verified: true });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.error(`[work-modal] 验证超时`);
  return blocking(RESULT_CODES.COMMENT_SEND_UNCONFIRMED, '回复未出现在评论区', { recoverable: true });
}