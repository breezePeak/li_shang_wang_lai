import { buildPreferredDouyinWorkUrl, normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import {
  navigateToVideo,
  checkLikeState,
  getVideoTitle,
  extractVideoCommentContext,
} from '../adapters/video-page.mjs';

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
  const {
    pageLoadRetryCount = 1,
    timeoutMs = 15000,
  } = options;

  const profile = normalizeDouyinUrl(profileUrl || '') || profileUrl;
  const targetAwemeId = String(awemeId || '').trim();
  if (!profile || !targetAwemeId) {
    return { ok: false, reason: 'missing_profile_or_aweme_id' };
  }

  const open = await gotoWithRetry(page, profile, { pageLoadRetryCount, timeoutMs });
  if (!open.ok) {
    return { ok: false, reason: `profile_navigation_failed:${open.error}` };
  }

  const isPrivate = await detectPrivateProfile(page);
  if (isPrivate) {
    return { ok: false, reason: 'private_profile' };
  }

  const clicked = await page.evaluate((id) => {
    function visible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    const candidates = [];
    const links = document.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href.includes(id)) continue;
      if (!/\/video\/|\/note\/|modal_id=/.test(href)) continue;
      if (!visible(link)) continue;
      const rect = link.getBoundingClientRect();
      candidates.push({
        href,
        x: rect.x,
        y: rect.y,
        area: rect.width * rect.height,
      });
    }

    candidates.sort((a, b) => a.y - b.y || a.x - b.x || b.area - a.area);
    const first = candidates[0];
    if (!first) return { ok: false, reason: 'target_work_link_not_found', candidates: 0 };

    const target = Array.from(links).find(link => (link.getAttribute('href') || '') === first.href && visible(link));
    if (!target) return { ok: false, reason: 'target_work_element_missing', candidates: candidates.length };

    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
    return { ok: true, href: first.href, candidates: candidates.length };
  }, targetAwemeId);

  if (!clicked.ok) return clicked;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes(`/video/${targetAwemeId}`) || url.includes(`/note/${targetAwemeId}`) || url.includes(`modal_id=${targetAwemeId}`)) {
      await page.waitForTimeout(1200);
      return { ok: true, url, clickedHref: clicked.href };
    }
    await page.waitForTimeout(250);
  }

  return {
    ok: false,
    reason: 'target_work_open_timeout',
    clickedHref: clicked.href,
    currentUrl: page.url(),
  };
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

  const [titleResult, contextResult, likeResult, referenceComments] = await Promise.all([
    getVideoTitle(page),
    extractVideoCommentContext(page),
    checkLikeState(page),
    extractReferenceComments(page, maxReferenceComments),
  ]);

  const workTitle = titleResult.ok ? (titleResult.data?.title || '') : '';
  const context = contextResult.data || {};
  const workText = context.captionText || context.visibleTextSample || '';
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
  };

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

  const [titleResult, contextResult, likeResult, referenceComments] = await Promise.all([
    getVideoTitle(page),
    extractVideoCommentContext(page),
    checkLikeState(page),
    extractReferenceComments(page, maxReferenceComments),
  ]);

  const workTitle = titleResult.ok ? (titleResult.data?.title || '') : '';
  const context = contextResult.data || {};
  const workText = context.captionText || context.visibleTextSample || '';
  const contentSummary = buildSummary({ title: workTitle, text: workText });
  const publishTime = extractPublishTime(`${context.visibleTextSample || ''} ${workText}`);

  let likeState = 'unknown';
  if (likeResult.ok && likeResult.data?.confidence === 'confirmed') {
    likeState = likeResult.data.alreadyLiked ? 'already_liked' : 'pending';
  }

  const currentUrl = page.url();
  const work = {
    workId: extractWorkIdFromUrl(currentUrl),
    workUrl: normalizeDouyinUrl(currentUrl) || currentUrl,
    workTitle: workTitle || context.targetWorkTitle || null,
    workText: workText || null,
    contentSummary,
    publishTime,
    likeState,
    referenceComments,
  };

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
