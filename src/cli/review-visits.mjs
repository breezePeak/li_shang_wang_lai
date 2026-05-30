import { getEvents } from '../db/interaction-repository.mjs';
import { generatePlan } from './plan-actions.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

export const FRIENDLY_RELATIONS = new Set(['friend', 'mutual']);

export const VISIT_DRAFTS = [
  { text: '支持一下', commentCategory: 'support', replyMode: 'auto_simple', riskLevel: 'low', templateId: 'visit-support-1' },
  { text: '内容不错，来看看', commentCategory: 'praise', replyMode: 'auto_simple', riskLevel: 'low', templateId: 'visit-praise-1' },
  { text: '互相加油', commentCategory: 'encouragement', replyMode: 'auto_simple', riskLevel: 'low', templateId: 'visit-encouragement-1' },
];

export function buildReviewRecord(discovery) {
  return {
    actorName: discovery.actorName,
    actorProfileUrl: discovery.actorProfileUrl,
    relation: discovery.relation,
    sourceEventIds: discovery.sourceEventIds,
    sourceEventTypes: discovery.sourceEventTypes,
    targetWorkUrl: discovery.targetWorkUrl,
    targetWorkId: discovery.targetWorkId,
    targetWorkTitle: discovery.targetWorkTitle,
    likeState: discovery.likeState,
    suggestedActions: discovery.plannedActions,
    commentDrafts: VISIT_DRAFTS,
    selectedCommentDraft: null,
    commentCategory: null,
    replyMode: null,
    riskLevel: null,
    templateId: null,
    manualReviewMethod: null,
    autoExecuteAllowed: false,
    requiresManualReview: true,
    executeAllowed: false,
    previewOnly: true,
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

function formatTargetWorkId(url, videoId) {
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

async function processCandidate(page, candidate) {
  const name = candidate.actorName || 'unknown';
  const record = {
    actorName: name,
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
  };

  console.error(`[review] ${name} [${record.relation}]`);

  if (!FRIENDLY_RELATIONS.has(record.relation)) {
    record.status = 'blocked';
    record.reason = 'non_friend_non_mutual';
    console.error(`[review]   非好友/互关，跳过`);
    return record;
  }

  if (!record.actorProfileUrl) {
    record.status = 'blocked';
    record.reason = 'no_actor_profile_url';
    console.error(`[review]   缺少主页URL (no_actor_profile_url)`);
    return record;
  }

  console.error(`[review]   主页: ${record.actorProfileUrl.slice(0, 60)}...`);
  try {
    await page.goto(record.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
  } catch (err) {
    record.status = 'blocked';
    record.reason = 'profile_navigation_failed';
    console.error(`[review]   主页导航失败: ${err.message}`);
    return record;
  }

  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    record.status = 'blocked';
    record.reason = videoResult.code === RESULT_CODES.BLOCKED ? 'no_non_pinned_video' : videoResult.message || 'no_non_pinned_video';
    console.error(`[review]   ${record.reason}`);
    return record;
  }

  record.targetWorkUrl = videoResult.data.videoUrl;
  record.targetWorkId = formatTargetWorkId(videoResult.data.videoUrl, videoResult.data.videoId);
  console.error(`[review]   视频: ${record.targetWorkUrl.slice(0, 60)} (${record.targetWorkId})`);

  await page.waitForTimeout(2000);

  const navResult = await navigateToVideo(page, record.targetWorkUrl);
  if (!navResult.ok) {
    record.status = 'blocked';
    record.reason = 'video_navigation_failed';
    console.error(`[review]   ${record.reason}`);
    return record;
  }

  const likeResult = await checkLikeState(page);

  const classification = classifyLikeResult(likeResult);

  record.status = classification.status;
  record.likeState = classification.likeState;
  record.reason = classification.reason;
  record.plannedActions = classification.plannedActions;

  if (classification.status === 'blocked') {
    console.error(`[review]   点赞状态无法确认`);
    return record;
  }

  if (classification.status === 'skipped') {
    console.error('[review]   已点赞 → skipped (不评论)');
    return record;
  }

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    record.targetWorkTitle = titleResult.data.title;
  }

  console.error(`[review]   未点赞 → pending_review: "${record.targetWorkTitle.slice(0, 40)}"`);
  return record;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const useJson = commonArgs.options.json;
  const maxItems = commonArgs.options.maxItems || 10;

  console.error('[review] 读取待处理事件...');
  const allEvents = getEvents({ status: 'new', limit: 200 });
  const plan = generatePlan(allEvents);
  const candidates = plan.visitWorkCandidates;
  const totalCandidates = candidates.length;

  if (candidates.length === 0) {
    console.error('[review] 没有好友回访候选。先运行 npm run interactions:scan 再 npm run actions:plan');
    if (useJson) {
      printJsonResult('visits:review', { reviewCandidates: [] }, {
        totalCandidates: 0, processed: 0, pendingReview: 0, skipped: 0, blocked: 0,
      });
    }
    return;
  }

  const slice = candidates.slice(0, maxItems);
  console.error(`[review] ${totalCandidates} 个候选，本轮最多处理 ${maxItems} 个`);

  const run = createRunContext('visits:review', commonArgs.options);
  let browser = null;
  let page = null;
  const discoveries = [];

  try {
    console.error('[review] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  } catch (err) {
    console.error('[review] 浏览器启动失败:', err.message);
    if (useJson) {
      printJsonError('visits:review', RESULT_CODES.UNKNOWN_ERROR, '浏览器启动失败: ' + err.message);
    }
    return;
  }

  try {
    for (let i = 0; i < slice.length; i++) {
      const item = await processCandidate(page, slice[i]);
      discoveries.push(item);
      run.scanned++;
      if (item.status === 'pending_review') run.planned++;
      else if (item.status === 'skipped') run.skipped++;
      else run.blocked++;
    }
  } catch (err) {
    console.error('[review] 处理异常:', err.message);
    run.hadError = true;
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (shouldClose && browser) {
      console.error('[review] 关闭浏览器...');
      await browser.close().catch(() => {});
    }
  }

  // filter to only pending_review and build reviewCandidates
  const pendingDiscoveries = discoveries.filter(d => d.status === 'pending_review');
  const reviewCandidates = pendingDiscoveries.map(buildReviewRecord);

  const pendingReview = pendingDiscoveries.length;
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

  if (reviewCandidates.length > 0) {
    console.error(`\n----- 待审核回访候选 (${reviewCandidates.length}) -----`);
    for (const c of reviewCandidates) {
      console.error(`  ${c.actorName} [${c.relation}] → ${c.targetWorkUrl}`);
      console.error(`    草稿: ${c.commentDrafts.map(d => d.text).join(' | ')}`);
      console.error(`    需人工选择草稿后确认`);
    }
  }

  if (useJson) {
    printJsonResult('visits:review', { reviewCandidates }, {
      totalCandidates,
      processed,
      pendingReview,
      skipped,
      blocked,
    });
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/review-visits.mjs') || process.argv[1].endsWith('\\review-visits.mjs')
);
if (isMain) {
  main().catch(err => {
    console.error('[review] 错误:', err.message);
    printJsonError('visits:review', RESULT_CODES.UNKNOWN_ERROR, err.message);
    process.exit(1);
  });
}
