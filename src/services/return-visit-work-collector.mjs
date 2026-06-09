import { buildPreferredDouyinWorkUrl, normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import {
  navigateToVideo,
  checkLikeState,
  getVideoTitle,
  extractVideoCommentContext,
} from '../adapters/video-page.mjs';
import { extractWorkModalContext } from '../adapters/work-modal-page.mjs';

function createProfilePostApiCollector(page) {
  const awemes = [];
  const seenAwemeIds = new Set();
  const seenResponseUrls = new Set();
  const meta = {
    responseCount: 0,
    parseFailed: 0,
    lastResponseAt: 0,
  };

  async function onResponse(response) {
    const url = typeof response.url === 'function' ? response.url() : '';
    if (!url.includes('/aweme/v1/web/aweme/post/')) return;
    if (typeof response.status === 'function' && response.status() !== 200) return;
    if (seenResponseUrls.has(url)) return;
    seenResponseUrls.add(url);

    let json;
    try {
      json = await response.json();
    } catch (err) {
      meta.parseFailed++;
      console.error(`[return-visit:prepare] 解析作品接口失败: ${err.message}`);
      return;
    }

    const list = Array.isArray(json?.aweme_list) ? json.aweme_list : [];
    let added = 0;
    for (const aweme of list) {
      const awemeId = String(aweme?.aweme_id || '');
      if (!awemeId || seenAwemeIds.has(awemeId)) continue;
      seenAwemeIds.add(awemeId);
      awemes.push(aweme);
      added++;
    }
    meta.responseCount++;
    meta.lastResponseAt = Date.now();
    console.error(`[return-visit:prepare] 捕获作品接口: response=${meta.responseCount}, added=${added}, total=${awemes.length}`);
  }

  page.on('response', onResponse);

  return {
    getAwemes() {
      return awemes.slice();
    },
    getStats() {
      return { ...meta, awemeCount: awemes.length };
    },
    async waitForAwemes({ beforeCount = 0, timeoutMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (awemes.length > beforeCount) return true;
        await page.waitForTimeout(200);
      }
      return awemes.length > beforeCount;
    },
    stop() {
      page.off('response', onResponse);
    },
  };
}

export function normalizeAwemeIdForMatching(value) {
  return String(value || '').trim().replace(/^(video|note|modal)-/, '');
}

export function findAwemeIndexInList(awemeList = [], targetAwemeId = '') {
  const normalizedTarget = normalizeAwemeIdForMatching(targetAwemeId);
  if (!normalizedTarget) return -1;
  return awemeList.findIndex(aweme => normalizeAwemeIdForMatching(aweme?.aweme_id) === normalizedTarget);
}

export function extractAwemeIdFromHref(href = '') {
  const text = String(href || '');
  const match = text.match(/\/(?:video|note)\/(\d+)|[?&]modal_id=(\d+)/);
  return match?.[1] || match?.[2] || '';
}

export function findCardIndexByAwemeId(cards = [], targetAwemeId = '') {
  const normalizedTarget = normalizeAwemeIdForMatching(targetAwemeId);
  if (!normalizedTarget) return -1;
  return cards.findIndex(card => normalizeAwemeIdForMatching(extractAwemeIdFromHref(card?.href || '')) === normalizedTarget);
}

function normalizeProfileBase(profileUrl = '') {
  const normalized = normalizeDouyinUrl(profileUrl || '') || String(profileUrl || '').trim();
  return normalized.split('?')[0];
}

export function isSameProfileUrl(currentUrl = '', profileUrl = '') {
  const currentBase = normalizeProfileBase(currentUrl);
  const profileBase = normalizeProfileBase(profileUrl);
  return Boolean(currentBase && profileBase && currentBase === profileBase);
}

async function readProfileWorkCards(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]');
    for (const link of links) {
      if (!visible(link)) continue;
      const href = link.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      const rect = link.getBoundingClientRect();
      seen.add(href);
      cards.push({
        href: href.startsWith('http') ? href : `https://www.douyin.com${href}`,
        x: rect.x,
        y: rect.y,
      });
    }

    cards.sort((a, b) => a.y - b.y || a.x - b.x);
    return cards;
  });
}

async function clickProfileCardByIndex(page, index, expectedAwemeId = '') {
  return page.evaluate(({ targetIndex, expectedAwemeId }) => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function normalizeAwemeId(value) {
      return String(value || '').trim().replace(/^(video|note|modal)-/, '');
    }

    function extractAwemeId(href = '') {
      const match = String(href || '').match(/\/(?:video|note)\/(\d+)|[?&]modal_id=(\d+)/);
      return match?.[1] || match?.[2] || '';
    }

    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || seen.has(href) || !visible(link)) continue;
      seen.add(href);
      const rect = link.getBoundingClientRect();
      cards.push({ href, x: rect.x, y: rect.y });
    }

    cards.sort((a, b) => a.y - b.y || a.x - b.x);
    const normalizedExpected = normalizeAwemeId(expectedAwemeId);
    const target = normalizedExpected
      ? cards.find(card => normalizeAwemeId(extractAwemeId(card.href)) === normalizedExpected)
      : cards[targetIndex];
    if (!target) return { ok: false };

    const candidate = Array.from(links).find(link => (link.getAttribute('href') || '') === target.href && visible(link));
    if (!candidate) return { ok: false };
    candidate.scrollIntoView({ block: 'center', behavior: 'instant' });
    candidate.click();
    return { ok: true, href: target.href };
  }, { targetIndex: index, expectedAwemeId });
}

async function scrollProfileOnce(page) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(1000);
}

export async function closeCurrentWorkModalToProfile(page, profileUrl, options = {}) {
  const { timeoutMs = 8000 } = options;
  const profileBase = normalizeProfileBase(profileUrl);
  if (!profileBase) {
    return { ok: false, reason: 'missing_profile_url' };
  }

  async function onProfileWithoutModal() {
    const currentUrl = String(page.url?.() || '');
    return isSameProfileUrl(currentUrl, profileBase) && !currentUrl.includes('modal_id=');
  }

  if (await onProfileWithoutModal()) {
    return { ok: true, method: 'already_on_profile', url: page.url() };
  }

  async function tryCloseButton() {
    return page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      }

      const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
      const candidates = [];
      for (const el of nodes) {
        if (!visible(el)) continue;
        const text = (el.innerText || el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        const cls = String(el.getAttribute('class') || '');
        const rect = el.getBoundingClientRect();
        const inTopLeft = rect.left < 140 && rect.top < 140;
        const closeLike = text === '关闭'
          || aria.includes('关闭')
          || cls.includes('close')
          || cls.includes('Close')
          || cls.includes('xgplayer-playswitch-next')
          || cls.includes('semi-icon-close');
        if (!inTopLeft || !closeLike) continue;
        candidates.push({
          el,
          rect,
          text,
          aria,
          cls,
        });
      }

      candidates.sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
      const target = candidates[0]?.el;
      if (!target) return { ok: false };

      target.click?.();
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { ok: true };
    }).catch(() => ({ ok: false }));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    if (await onProfileWithoutModal()) {
      return { ok: true, method: 'escape', url: page.url() };
    }

    const clicked = await tryCloseButton();
    if (clicked.ok) {
      await page.waitForTimeout(700);
      if (await onProfileWithoutModal()) {
        return { ok: true, method: 'close_button', url: page.url() };
      }
    }
  }

  return { ok: false, reason: 'close_modal_to_profile_timeout', currentUrl: page.url() };
}

export function normalizeAwemeForVisit(aweme = {}) {
  const awemeId = String(aweme?.aweme_id || '').trim();
  const desc = String(aweme?.desc || '').trim();
  const itemTitle = String(aweme?.item_title || '').trim();
  const shareUrl = normalizeDouyinUrl(aweme?.share_url || aweme?.share_info?.share_url || '') || '';
  const isMultiContent = aweme?.is_multi_content != null
    ? Number(aweme.is_multi_content)
    : ((Array.isArray(aweme?.images) && aweme.images.length > 1) ? 1 : 0);

  return {
    awemeId,
    workId: awemeId,
    workUrl: buildPreferredDouyinWorkUrl(awemeId, {
      shareUrl,
      awemeType: aweme?.aweme_type,
      mediaType: aweme?.media_type,
      isMultiContent,
    }),
    shareUrl,
    desc,
    itemTitle,
    workTitle: itemTitle || desc || null,
    workText: desc || null,
    contentSummary: [itemTitle, desc].filter(Boolean).join(' ').slice(0, 120) || null,
    publishTime: aweme?.create_time ? String(aweme.create_time) : null,
    createTime: aweme?.create_time || null,
    isTop: Number(aweme?.is_top || 0),
    userDigged: Number(aweme?.user_digged || 0),
    diggCount: Number(aweme?.statistics?.digg_count ?? aweme?.digg_count ?? 0),
    commentCount: Number(aweme?.statistics?.comment_count ?? aweme?.comment_count ?? 0),
    awemeType: aweme?.aweme_type ?? null,
    mediaType: aweme?.media_type ?? null,
    isMultiContent,
  };
}

export function extractWorkIdFromUrl(workUrl) {
  const url = String(workUrl || '');
  let m = url.match(/[?&]modal_id=(\d+)/);
  if (m) return m[1];
  m = url.match(/\/video\/(\d+)/);
  if (m) return m[1];
  m = url.match(/\/note\/(\d+)/);
  if (m) return m[1];
  return null;
}

async function gotoWithRetry(page, url, { timeoutMs = 20000, pageLoadRetryCount = 1 } = {}) {
  let lastError = null;
  for (let i = 0; i <= pageLoadRetryCount; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(1500);
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (i < pageLoadRetryCount) {
        await page.waitForTimeout(1200);
      }
    }
  }
  return { ok: false, error: lastError?.message || 'navigation_failed' };
}

async function detectPrivateProfile(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 2000);
    return /私密账号|该账号已设置为私密|暂时无法查看/.test(text);
  });
}

async function listProfileWorkUrls(page, maxWorks = 2) {
  const result = await page.evaluate((limit) => {
    const items = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href.includes('/video/') && !href.includes('/note/')) continue;
      if (link.closest('[class*="pinned"]') || link.closest('[class*="top"]')) continue;
      const rect = link.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 30) continue;
      const url = href.startsWith('http') ? href : `https://www.douyin.com${href}`;
      const clean = url.split('?')[0];
      if (seen.has(clean)) continue;
      seen.add(clean);
      items.push({ url: clean, x: rect.x, y: rect.y });
    }

    items.sort((a, b) => a.y - b.y || a.x - b.x);
    return items.slice(0, limit).map(x => x.url);
  }, maxWorks);

  return result.map(u => normalizeDouyinUrl(u)).filter(Boolean);
}

export async function openProfileWorkByAwemeId(page, profileUrl, awemeId, options = {}) {
  return openProfileWorkByAwemeIdFromPostApi(page, profileUrl, awemeId, options);
}

export async function openProfileWorkByAwemeIdFromPostApi(page, profileUrl, awemeId, options = {}) {
  const {
    pageLoadRetryCount = 1,
    timeoutMs = 15000,
    maxScrollCount = 20,
    collectorFactory = createProfilePostApiCollector,
    gotoProfile = gotoWithRetry,
    detectPrivate = detectPrivateProfile,
    listCards = readProfileWorkCards,
    clickCard = clickProfileCardByIndex,
    scrollProfile = scrollProfileOnce,
    reuseCurrentProfile = true,
  } = options;

  const profile = normalizeDouyinUrl(profileUrl || '') || profileUrl;
  const targetAwemeId = normalizeAwemeIdForMatching(awemeId);
  if (!profile || !targetAwemeId) {
    return { ok: false, reason: 'missing_profile_or_aweme_id' };
  }

  const collector = collectorFactory(page);
  try {
    const currentUrl = String(page.url?.() || '');
    const canReuseCurrentProfile = reuseCurrentProfile && isSameProfileUrl(currentUrl, profile) && !currentUrl.includes('modal_id=');

    if (!canReuseCurrentProfile) {
      const open = await gotoProfile(page, profile, { pageLoadRetryCount, timeoutMs });
      if (!open.ok) {
        return { ok: false, reason: 'profile_navigation_failed', error: open.error || '' };
      }
    }

    const isPrivate = await detectPrivate(page);
    if (isPrivate) {
      return { ok: false, reason: 'private_profile', stats: collector.getStats?.() || null };
    }

    await page.waitForTimeout(1200);
    const beforeCount = collector.getAwemes().length;
    await collector.waitForAwemes({ beforeCount, timeoutMs: 3000 });

    let cards = await listCards(page);
    let foundIndex = findAwemeIndexInList(collector.getAwemes(), targetAwemeId);
    let domFoundIndex = findCardIndexByAwemeId(cards, targetAwemeId);
    let scrollCount = 0;
    while (domFoundIndex < 0 && scrollCount < maxScrollCount) {
      await scrollProfile(page);
      scrollCount++;
      const currentCount = collector.getAwemes().length;
      await collector.waitForAwemes({ beforeCount: currentCount, timeoutMs: 3000 });
      foundIndex = findAwemeIndexInList(collector.getAwemes(), targetAwemeId);
      cards = await listCards(page);
      domFoundIndex = findCardIndexByAwemeId(cards, targetAwemeId);
    }

    const awemes = collector.getAwemes();
    const matchedAweme = foundIndex >= 0 ? normalizeAwemeForVisit(awemes[foundIndex]) : null;
    const stats = {
      ...(collector.getStats?.() || {}),
      scrollCount,
      foundTargetWork: foundIndex >= 0,
      targetIndex: foundIndex,
      domFoundTargetWork: domFoundIndex >= 0,
      domTargetIndex: domFoundIndex,
      reusedCurrentProfile: canReuseCurrentProfile,
    };
    console.error(`[comments:execute] profile_post_api_response_count=${stats.responseCount || 0} profile_post_api_aweme_count=${stats.awemeCount || 0} target_work_found=${stats.foundTargetWork} target_index=${foundIndex} dom_target_found=${stats.domFoundTargetWork} dom_target_index=${domFoundIndex} reused_current_profile=${stats.reusedCurrentProfile}`);

    if (foundIndex < 0 && domFoundIndex < 0 && ((stats.responseCount || 0) === 0 || (stats.awemeCount || 0) === 0)) {
      return { ok: false, reason: 'profile_post_api_empty', stats };
    }
    if (foundIndex < 0 && domFoundIndex < 0) {
      return { ok: false, reason: 'target_work_not_found_in_profile_post_api', stats };
    }
    if (domFoundIndex < 0) {
      return { ok: false, reason: 'target_work_card_not_found_in_dom', stats };
    }

    const targetIndex = domFoundIndex;
    console.error(`[comments:execute] profile_dom_card_count=${cards.length} click_card_index=${targetIndex}`);
    if (cards.length <= targetIndex) {
      return { ok: false, reason: 'profile_card_index_out_of_range', stats: { ...stats, domCardCount: cards.length } };
    }

    const candidateCard = cards[targetIndex];
    const cardAwemeId = normalizeAwemeIdForMatching(extractAwemeIdFromHref(candidateCard?.href || ''));
    if (cardAwemeId && cardAwemeId !== targetAwemeId) {
      return {
        ok: false,
        reason: 'profile_card_id_mismatch',
        stats: { ...stats, domCardCount: cards.length },
        cardHref: candidateCard?.href || '',
        cardAwemeId,
      };
    }

    const clicked = await clickCard(page, targetIndex, targetAwemeId);
    if (!clicked?.ok) {
      return { ok: false, reason: clicked?.reason || 'profile_card_index_out_of_range', stats: { ...stats, domCardCount: cards.length } };
    }
    const clickedAwemeId = normalizeAwemeIdForMatching(extractAwemeIdFromHref(clicked.href || ''));
    if (clickedAwemeId && clickedAwemeId !== targetAwemeId) {
      return {
        ok: false,
        reason: 'profile_clicked_card_id_mismatch',
        stats: { ...stats, domCardCount: cards.length },
        clickedHref: clicked.href || '',
        clickedAwemeId,
      };
    }
    console.error(`[comments:execute] opened_profile_card_href=${clicked.href || candidateCard?.href || ''}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = page.url();
      if (url.includes(`/video/${targetAwemeId}`) || url.includes(`/note/${targetAwemeId}`) || url.includes(`modal_id=${targetAwemeId}`)) {
        await page.waitForTimeout(1200);
        return { ok: true, url, awemeId: targetAwemeId, index: targetIndex, stats, aweme: matchedAweme };
      }
      await page.waitForTimeout(250);
    }

    return {
      ok: false,
      reason: 'target_work_open_timeout',
      currentUrl: page.url(),
      stats,
    };
  } finally {
    collector.stop();
  }
}

function extractPublishTime(text) {
  const src = String(text || '');
  const patterns = [
    /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/,
    /\d{1,2}月\d{1,2}日/,
    /\d{1,2}:\d{2}/,
    /\d+天前/,
    /\d+小时前/,
    /\d+分钟前/,
    /刚刚/,
  ];
  for (const p of patterns) {
    const m = src.match(p);
    if (m) return m[0];
  }
  return null;
}

function buildSummary({ title, text }) {
  const merged = [title, text].filter(Boolean).join('。').trim();
  if (!merged) return null;
  return merged.length > 100 ? `${merged.slice(0, 100)}...` : merged;
}

function normalizeVisibleFingerprintText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim()
    .slice(0, 160);
}

export function buildVisibleWorkFingerprint(work = {}) {
  const title = normalizeVisibleFingerprintText(work.workTitle);
  const text = normalizeVisibleFingerprintText(work.workText || work.contentSummary);
  const media = String(work.thumbnailSrc || '').trim().slice(0, 160);
  const parts = [title, text, media].filter(part => part && part.length >= 4);
  return parts.join('|');
}

function normalizeCommentText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractReferenceComments(page, maxCount = 5) {
  const comments = await page.evaluate((limit) => {
    const selectors = [
      '[data-e2e="comment-item"]',
      '[class*="commentItem"]',
      '[class*="comment-item"]',
      'li[class*="comment"]',
      'div[class*="comment"]',
    ];
    const result = [];
    const seen = new Set();

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length < 4 || text.length > 80) continue;
        if (/回复|作者|置顶|展开|收起/.test(text) && text.length < 10) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        result.push(text);
        if (result.length >= limit) return result;
      }
    }

    return result;
  }, maxCount);

  return comments
    .map(normalizeCommentText)
    .filter(Boolean)
    .slice(0, maxCount);
}

function isWorkContentSufficient({ workTitle, workText, referenceComments }) {
  const titleLen = String(workTitle || '').replace(/\s+/g, '').length;
  const textLen = String(workText || '').replace(/\s+/g, '').length;
  const refCount = Array.isArray(referenceComments) ? referenceComments.length : 0;
  return titleLen >= 4 || textLen >= 12 || refCount >= 2;
}

export async function collectWorkFromUrl(page, workUrl, options = {}) {
  const { pageLoadRetryCount = 1, maxReferenceComments = 5 } = options;
  let navResult = null;
  let lastErr = null;

  for (let i = 0; i <= pageLoadRetryCount; i++) {
    navResult = await navigateToVideo(page, workUrl);
    if (navResult.ok) break;
    lastErr = navResult.message || navResult.code || 'video_navigation_failed';
    if (i < pageLoadRetryCount) {
      await page.waitForTimeout(1500);
    }
  }

  if (!navResult?.ok) {
    return { ok: false, reason: 'video_navigation_failed', error: lastErr || 'video_navigation_failed' };
  }

  const isModalPage = String(page.url?.() || workUrl || '').includes('modal_id=');
  const [titleResult, contextResult, likeResult, referenceComments, modalContextResult] = await Promise.all([
    getVideoTitle(page),
    extractVideoCommentContext(page),
    checkLikeState(page),
    extractReferenceComments(page, maxReferenceComments),
    isModalPage ? extractWorkModalContext(page).catch(() => null) : Promise.resolve(null),
  ]);

  const modalContext = modalContextResult?.ok ? (modalContextResult.data || {}) : {};
  const workTitle = modalContext.workTitle || (titleResult.ok ? (titleResult.data?.title || '') : '');
  const context = contextResult.data || {};
  const workText = modalContext.workText || context.captionText || context.visibleTextSample || '';
  const contentSummary = buildSummary({ title: workTitle, text: workText });
  const publishTime = extractPublishTime(`${context.visibleTextSample || ''} ${workText}`);

  let likeState = 'unknown';
  if (likeResult.ok && likeResult.data?.confidence === 'confirmed') {
    likeState = likeResult.data.alreadyLiked ? 'already_liked' : 'pending';
  }

  const work = {
    workId: extractWorkIdFromUrl(workUrl),
    workUrl: normalizeDouyinUrl(workUrl) || workUrl,
    workTitle: workTitle || context.targetWorkTitle || null,
    workText: workText || null,
    contentSummary,
    publishTime,
    likeState,
    referenceComments,
    thumbnailSrc: modalContext.thumbnailSrc || null,
  };
  work.visibleFingerprint = buildVisibleWorkFingerprint(work);

  const sufficient = isWorkContentSufficient({
    workTitle: work.workTitle,
    workText: work.workText,
    referenceComments: work.referenceComments,
  });

  return {
    ok: true,
    reason: sufficient ? 'ready' : 'content_too_short',
    sufficient,
    work,
  };
}

export async function collectCurrentOpenedWork(page, options = {}) {
  const { maxReferenceComments = 5 } = options;

  const currentUrl = page.url();
  const isModalPage = String(currentUrl || '').includes('modal_id=');
  const [titleResult, contextResult, likeResult, referenceComments, modalContextResult] = await Promise.all([
    getVideoTitle(page),
    extractVideoCommentContext(page),
    checkLikeState(page),
    extractReferenceComments(page, maxReferenceComments),
    isModalPage ? extractWorkModalContext(page).catch(() => null) : Promise.resolve(null),
  ]);

  const modalContext = modalContextResult?.ok ? (modalContextResult.data || {}) : {};
  const workTitle = modalContext.workTitle || (titleResult.ok ? (titleResult.data?.title || '') : '');
  const context = contextResult.data || {};
  const workText = modalContext.workText || context.captionText || context.visibleTextSample || '';
  const contentSummary = buildSummary({ title: workTitle, text: workText });
  const publishTime = extractPublishTime(`${context.visibleTextSample || ''} ${workText}`);

  let likeState = 'unknown';
  if (likeResult.ok && likeResult.data?.confidence === 'confirmed') {
    likeState = likeResult.data.alreadyLiked ? 'already_liked' : 'pending';
  }

  const work = {
    workId: extractWorkIdFromUrl(currentUrl),
    workUrl: normalizeDouyinUrl(currentUrl) || currentUrl,
    workTitle: workTitle || context.targetWorkTitle || null,
    workText: workText || null,
    contentSummary,
    publishTime,
    likeState,
    referenceComments,
    thumbnailSrc: modalContext.thumbnailSrc || null,
  };
  work.visibleFingerprint = buildVisibleWorkFingerprint(work);

  const sufficient = isWorkContentSufficient({
    workTitle: work.workTitle,
    workText: work.workText,
    referenceComments: work.referenceComments,
  });

  return {
    ok: true,
    reason: sufficient ? 'ready' : 'content_too_short',
    sufficient,
    work,
  };
}

export async function collectCandidateWorkFromProfile(page, profileUrl, options = {}) {
  const {
    maxWorksToCheck = 2,
    pageLoadRetryCount = 1,
    maxReferenceComments = 5,
    validateWork = null,
  } = options;

  const profile = normalizeDouyinUrl(profileUrl || '') || profileUrl;
  if (!profile) {
    return { ok: false, status: 'failed_collect', reason: 'no_profile_url', checkedWorks: [] };
  }

  const open = await gotoWithRetry(page, profile, { pageLoadRetryCount });
  if (!open.ok) {
    return { ok: false, status: 'failed_collect', reason: `profile_navigation_failed:${open.error}`, checkedWorks: [] };
  }

  const isPrivate = await detectPrivateProfile(page);
  if (isPrivate) {
    return { ok: false, status: 'skipped_private', reason: 'private_profile', checkedWorks: [] };
  }

  const workUrls = await listProfileWorkUrls(page, maxWorksToCheck);
  if (workUrls.length === 0) {
    return { ok: false, status: 'skipped_no_work', reason: 'no_work_found', checkedWorks: [] };
  }

  const checkedWorks = [];
  for (const workUrl of workUrls.slice(0, maxWorksToCheck)) {
    const result = await collectWorkFromUrl(page, workUrl, {
      pageLoadRetryCount,
      maxReferenceComments,
    });
    checkedWorks.push({ workUrl, ok: result.ok, reason: result.reason });

    if (!result.ok) continue;
    if (!result.sufficient) continue;

    if (typeof validateWork === 'function') {
      const validation = validateWork(result.work);
      if (!validation?.ok) {
        checkedWorks[checkedWorks.length - 1] = {
          workUrl,
          ok: true,
          reason: validation?.reason || 'work_validator_rejected',
        };
        continue;
      }
    }

    return {
      ok: true,
      status: 'ready',
      reason: 'ready',
      selectedWork: result.work,
      checkedWorks,
    };
  }

  const hadNavigationFailure = checkedWorks.every(x => !x.ok);
  if (hadNavigationFailure) {
    return {
      ok: false,
      status: 'failed_collect',
      reason: 'all_candidate_navigation_failed',
      checkedWorks,
    };
  }

  return {
    ok: false,
    status: 'skipped_no_suitable_work',
    reason: `no_suitable_work_in_first_${maxWorksToCheck}`,
    checkedWorks,
  };
}

export async function collectFirstNonTopAwemeFromProfile(page, profileUrl, options = {}) {
  const {
    pageLoadRetryCount = 1,
    waitTimeoutMs = 3000,
  } = options;

  const profile = normalizeDouyinUrl(profileUrl || '') || profileUrl;
  if (!profile) {
    return { ok: false, status: 'skipped', reason: 'skip_no_homepage_url' };
  }

  const collector = createProfilePostApiCollector(page);
  try {
    const open = await gotoWithRetry(page, profile, { pageLoadRetryCount });
    if (!open.ok) {
      return { ok: false, status: 'skipped', reason: 'skip_homepage_load_failed' };
    }

    const isPrivate = await detectPrivateProfile(page);
    if (isPrivate) {
      return { ok: false, status: 'skipped', reason: 'skip_homepage_load_failed' };
    }

    const beforeCount = collector.getAwemes().length;
    await page.waitForTimeout(1200);
    await collector.waitForAwemes({ beforeCount, timeoutMs: waitTimeoutMs });

    if (collector.getAwemes().length === 0) {
      await page.mouse.wheel(0, 900).catch(() => {});
      await page.waitForTimeout(1000);
      await collector.waitForAwemes({ beforeCount, timeoutMs: waitTimeoutMs });
    }

    const awemeList = collector.getAwemes();
    const stats = collector.getStats();
    if (stats.responseCount === 0 || awemeList.length === 0) {
      return { ok: false, status: 'skipped', reason: 'skip_post_api_empty', stats };
    }

    const nonTop = awemeList.filter(aweme => Number(aweme?.is_top) !== 1);
    if (nonTop.length === 0) {
      const hadAnyAweme = awemeList.some(aweme => String(aweme?.aweme_id || '').trim());
      return {
        ok: false,
        status: 'skipped',
        reason: hadAnyAweme ? 'skip_only_top_aweme' : 'skip_no_aweme',
        stats,
      };
    }

    const selected = normalizeAwemeForVisit(nonTop[0]);
    if (!selected.awemeId) {
      return { ok: false, status: 'skipped', reason: 'skip_aweme_id_missing', stats };
    }

    return {
      ok: true,
      status: 'ready',
      stats,
      aweme: selected,
    };
  } finally {
    collector.stop();
  }
}
