import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import {
  navigateToVideo,
  checkLikeState,
  getVideoTitle,
  extractVideoCommentContext,
} from '../adapters/video-page.mjs';

function extractWorkIdFromUrl(workUrl) {
  const url = String(workUrl || '');
  let m = url.match(/\/video\/(\d+)/);
  if (m) return `video-${m[1]}`;
  m = url.match(/\/note\/(\d+)/);
  if (m) return `note-${m[1]}`;
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

async function listProfileWorkUrls(page, maxWorks = 3) {
  const result = await page.evaluate((limit) => {
    const items = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href.includes('/video/') && !href.includes('/note/')) continue;
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

export async function collectCandidateWorkFromProfile(page, profileUrl, options = {}) {
  const {
    maxWorksToCheck = 3,
    pageLoadRetryCount = 1,
    maxReferenceComments = 5,
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
    reason: 'no_suitable_work_in_first_three',
    checkedWorks,
  };
}
