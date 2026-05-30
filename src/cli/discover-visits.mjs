import { getEvents } from '../db/interaction-repository.mjs';
import { generatePlan } from './plan-actions.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { waitForProfileSettled, waitForVideoSettled, waitForHumanObservation } from '../browser/page-settle.mjs';

export const FRIENDLY_RELATIONS = new Set(['friend', 'mutual']);

export function createVisitDiscoveryBase(candidate) {
  return {
    actorName: candidate.actorName || 'unknown',
    actorProfileKey: candidate.actorProfileKey || '',
    actorProfileUrl: candidate.actorProfileUrl || '',
    relation: candidate.relation || 'unknown',
    sourceEventIds: candidate.sourceEventIds || [],
    sourceEventTypes: candidate.sourceEventTypes || [],
    targetWorkUrl: '',
    targetWorkId: null,
    targetWorkTitle: '',
    likeState: 'unknown',
    status: 'blocked',
    plannedActions: [],
    executeAllowed: false,
    previewOnly: true,
    reason: null,
    likeDiagnostics: null,
    likeCheckSignal: null,
    likeCheckConfidence: null,
  };
}

export function classifyLikeResult(likeResult) {
  if (!likeResult || !likeResult.ok) {
    return { status: 'blocked', likeState: 'unknown', reason: 'LIKE_STATE_UNKNOWN', plannedActions: [] };
  }
  const confidence = likeResult.data?.confidence;
  if (confidence !== 'confirmed') {
    return { status: 'blocked', likeState: 'unknown', reason: 'LIKE_STATE_UNKNOWN', plannedActions: [] };
  }
  if (likeResult.data?.alreadyLiked) {
    return { status: 'skipped', likeState: 'already_liked', reason: 'already_liked_skip_comment', plannedActions: [] };
  }
  return { status: 'pending_review', likeState: 'not_liked', reason: null, plannedActions: ['like_work', 'comment_work'] };
}

export function formatTargetWorkId(url, videoId) {
  if (!url && !videoId) return null;
  const u = url || '';
  if (u.includes('/video/')) {
    const m = u.match(/\/video\/(\d+)/);
    if (m) return 'video-' + m[1];
  }
  if (u.includes('/note/')) {
    const m = u.match(/\/note\/(\d+)/);
    if (m) return 'note-' + m[1];
  }
  if (videoId) return 'video-' + videoId;
  return url || null;
}

async function processCandidate(page, candidate, settleOptions) {
  const name = candidate.actorName || 'unknown';
  const r = createVisitDiscoveryBase(candidate);
  const { observeMs, profileSettleMs, videoSettleMs } = settleOptions;

  console.error(`\n[discover] ${name} [${r.relation}]`);

  if (!FRIENDLY_RELATIONS.has(r.relation)) {
    r.status = 'blocked';
    r.reason = 'non_friend_non_mutual';
    console.error(`[discover]   非好友/互关，跳过`);
    return r;
  }

  if (!r.actorProfileUrl) {
    r.status = 'blocked';
    r.reason = 'no_actor_profile_url';
    console.error(`[discover]   缺少主页URL (no_actor_profile_url)`);
    return r;
  }

  console.error(`[discover]   主页: ${r.actorProfileUrl.slice(0, 60)}...`);
  try {
    await page.goto(r.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    r.status = 'blocked';
    r.reason = 'profile_navigation_failed';
    console.error(`[discover]   主页导航失败: ${err.message}`);
    return r;
  }

  const profileSettled = await waitForProfileSettled(page, { profileSettleMs });
  if (!profileSettled.ok) {
    r.status = 'blocked';
    r.reason = profileSettled.message;
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  await waitForHumanObservation(page, '[discover]   主页已打开', observeMs);

  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    r.status = 'blocked';
    r.reason = videoResult.code === RESULT_CODES.BLOCKED ? 'no_non_pinned_video' : videoResult.message || 'no_non_pinned_video';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  r.targetWorkUrl = videoResult.data.videoUrl;
  r.targetWorkId = formatTargetWorkId(videoResult.data.videoUrl, videoResult.data.videoId);
  console.error(`[discover]   视频: ${r.targetWorkUrl.slice(0, 60)} (${r.targetWorkId})`);

  await waitForHumanObservation(page, '[discover]   候选作品已找到', Math.min(observeMs, 3000));

  const navResult = await navigateToVideo(page, r.targetWorkUrl);
  if (!navResult.ok) {
    r.status = 'blocked';
    r.reason = 'video_navigation_failed';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  const videoSettled = await waitForVideoSettled(page, { videoSettleMs });
  if (!videoSettled.ok) {
    r.status = 'blocked';
    r.reason = videoSettled.message;
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  await waitForHumanObservation(page, '[discover]   视频页已打开', observeMs);
  await page.waitForTimeout(1500);

  const likeResult = await checkLikeState(page);

  // Always pass diagnostics through to JSON output
  r.likeDiagnostics = likeResult?.data || null;
  r.likeCheckSignal = likeResult?.data?.signal || likeResult?.data?.confidence || null;
  r.likeCheckConfidence = likeResult?.data?.confidence || null;

  const classification = classifyLikeResult(likeResult);

  r.status = classification.status;
  r.likeState = classification.likeState;
  r.reason = classification.reason;
  r.plannedActions = classification.plannedActions;

  if (classification.status === 'blocked') {
    console.error(`[discover]   点赞状态无法确认 (${r.likeCheckConfidence || 'none'})`);
    return r;
  }

  if (classification.status === 'skipped') {
    console.error('[discover]   已点赞 → skipped (不评论)');
    return r;
  }

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    r.targetWorkTitle = titleResult.data.title;
  }

  console.error(`[discover]   未点赞 → pending_review: "${r.targetWorkTitle.slice(0, 40)}"`);
  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const useJson = commonArgs.options.json;
  const maxItems = commonArgs.options.maxItems || 10;

  if (!useJson) {
    commonArgs.options.keepOpen = true;
  }

  const settleOptions = {
    observeMs: commonArgs.options.observeMs,
    profileSettleMs: commonArgs.options.profileSettleMs,
    videoSettleMs: commonArgs.options.videoSettleMs,
  };

  console.error('[discover] 读取待处理事件...');
  const allEvents = getEvents({ status: 'new', limit: 200 });
  const plan = generatePlan(allEvents);
  const candidates = plan.visitWorkCandidates;
  const totalCandidates = candidates.length;

  if (candidates.length === 0) {
    console.error('[discover] 没有好友回访候选。先运行 npm run interactions:scan 再 npm run actions:plan');
    if (useJson) {
      printJsonResult('visits:discover', { visitDiscoveries: [] }, {
        totalCandidates: 0, processed: 0, pendingReview: 0, skipped: 0, blocked: 0,
      });
    }
    return;
  }

  const slice = candidates.slice(0, maxItems);
  console.error(`[discover] ${totalCandidates} 个候选，本轮最多处理 ${maxItems} 个`);

  const run = createRunContext('visits:discover', commonArgs.options);
  let browser = null;
  let page = null;
  const discoveries = [];

  try {
    console.error('[discover] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  } catch (err) {
    console.error('[discover] 浏览器启动失败:', err.message);
    if (useJson) {
      printJsonError('visits:discover', RESULT_CODES.UNKNOWN_ERROR, '浏览器启动失败: ' + err.message);
    }
    return;
  }

  try {
    for (let i = 0; i < slice.length; i++) {
      const item = await processCandidate(page, slice[i], settleOptions);
      discoveries.push(item);
      run.scanned++;
      if (item.status === 'pending_review') run.planned++;
      else if (item.status === 'skipped') run.skipped++;
      else run.blocked++;
    }
  } catch (err) {
    console.error('[discover] 处理异常:', err.message);
    run.hadError = true;
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (shouldClose && browser) {
      console.error('[discover] 关闭浏览器...');
      await browser.close().catch(() => {});
    }
  }

  const pendingReview = discoveries.filter(d => d.status === 'pending_review').length;
  const skipped = discoveries.filter(d => d.status === 'skipped').length;
  const blocked = discoveries.filter(d => d.status === 'blocked').length;
  const processed = discoveries.length;

  console.error(`\n===== 汇总 =====`);
  console.error(`  候选总数: ${totalCandidates} | 处理: ${processed} | 待审核: ${pendingReview} | 跳过: ${skipped} | 阻塞: ${blocked}`);
  for (const d of discoveries) {
    if (d.status === 'pending_review') {
      console.error(`  [${d.sourceEventIds.join(',')}] ${d.actorName} → ${d.targetWorkUrl}`);
    } else if (d.status === 'skipped') {
      console.error(`  - ${d.actorName}: ${d.reason}`);
    } else {
      console.error(`  x ${d.actorName}: ${d.reason || '未知'}`);
    }
  }

  if (useJson) {
    printJsonResult('visits:discover', { visitDiscoveries: discoveries }, {
      totalCandidates,
      processed,
      pendingReview,
      skipped,
      blocked,
    });
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/discover-visits.mjs') || process.argv[1].endsWith('\\discover-visits.mjs')
);
if (isMain) {
  main().catch(err => {
    console.error('[discover] 错误:', err.message);
    printJsonError('visits:discover', RESULT_CODES.UNKNOWN_ERROR, err.message);
    process.exit(1);
  });
}
