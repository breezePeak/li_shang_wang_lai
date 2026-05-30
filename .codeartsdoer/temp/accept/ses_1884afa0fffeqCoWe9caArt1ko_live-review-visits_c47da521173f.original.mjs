import { createInterface } from 'readline';
import { getEvents } from '../db/interaction-repository.mjs';
import { generatePlan } from './plan-actions.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle, clickLike, confirmLikeSucceeded, postVideoComment, extractVideoCommentContext } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { generateVisitCommentCandidates } from '../domain/visit-comment-generator.mjs';

export const FRIENDLY_RELATIONS = new Set(['friend', 'mutual']);

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
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

export function isExecuteAllowedByRisk(candidate, record) {
  if (!candidate) return false;
  if (!record || !record.selectedCommentText) return false;
  if (candidate.riskLevel === 'high') return false;
  if (candidate.replyMode === 'ignore') return false;
  if (candidate.riskLevel === 'low' && candidate.replyMode === 'auto_simple' && record.manualReviewMethod === 'user_selected_template') return true;
  if (candidate.riskLevel === 'medium' && candidate.replyMode === 'agent_generated_review_required' && record.manualReviewMethod === 'user_selected_agent_comment') return true;
  return false;
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
    selectedCommentText: null,
    commentCategory: null,
    replyMode: null,
    riskLevel: null,
    generationReason: null,
    sourceSignals: null,
    manualReviewMethod: null,
    autoExecuteAllowed: false,
    actionResults: null,
    generatedCommentCandidates: null,
    usedFallback: false,
    commentContext: null,
  };

  console.error(`\n[live-review] ${name} [${record.relation}]`);

  if (!FRIENDLY_RELATIONS.has(record.relation)) {
    record.status = 'blocked';
    record.reason = 'non_friend_non_mutual';
    console.error(`[live-review]   非好友/互关，跳过`);
    return record;
  }

  if (!record.actorProfileUrl) {
    record.status = 'blocked';
    record.reason = 'no_actor_profile_url';
    console.error(`[live-review]   缺少主页URL`);
    return record;
  }

  console.error(`[live-review]   主页: ${record.actorProfileUrl.slice(0, 60)}...`);
  try {
    await page.goto(record.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
  } catch (err) {
    record.status = 'blocked';
    record.reason = 'profile_navigation_failed';
    console.error(`[live-review]   主页导航失败: ${err.message}`);
    return record;
  }

  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    record.status = 'blocked';
    record.reason = videoResult.code === RESULT_CODES.BLOCKED ? 'no_non_pinned_video' : videoResult.message || 'no_non_pinned_video';
    console.error(`[live-review]   ${record.reason}`);
    return record;
  }

  record.targetWorkUrl = videoResult.data.videoUrl;
  record.targetWorkId = formatTargetWorkId(videoResult.data.videoUrl, videoResult.data.videoId);
  console.error(`[live-review]   视频: ${record.targetWorkUrl.slice(0, 60)} (${record.targetWorkId})`);

  await page.waitForTimeout(2000);

  const navResult = await navigateToVideo(page, record.targetWorkUrl);
  if (!navResult.ok) {
    record.status = 'blocked';
    record.reason = 'video_navigation_failed';
    console.error(`[live-review]   ${record.reason}`);
    return record;
  }

  const likeResult = await checkLikeState(page);
  const classification = classifyLikeResult(likeResult);

  record.status = classification.status;
  record.likeState = classification.likeState;
  record.reason = classification.reason;
  record.plannedActions = classification.plannedActions;

  if (classification.status === 'blocked') {
    console.error(`[live-review]   点赞状态无法确认`);
    return record;
  }

  if (classification.status === 'skipped') {
    console.error('[live-review]   已点赞 → skipped');
    return record;
  }

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    record.targetWorkTitle = titleResult.data.title;
  }

  const contextResult = await extractVideoCommentContext(page);
  const commentContext = contextResult.data;
  record.commentContext = commentContext;

  const { generatedCommentCandidates, usedFallback } = generateVisitCommentCandidates(commentContext);
  record.generatedCommentCandidates = generatedCommentCandidates;
  record.usedFallback = usedFallback;

  const isContextual = commentContext.canGenerateContextualComment;
  console.error(`[live-review]   未点赞 → ${record.targetWorkTitle.slice(0, 40)} (context=${isContextual}, candidates=${generatedCommentCandidates.length}, fallback=${usedFallback})`);
  return record;
}

async function interactiveSelect(page, record, isExecute) {
  const candidates = record.generatedCommentCandidates || [];

  console.error(`\n==================== 待审核候选 ====================`);
  console.error(`  用户: ${record.actorName} [${record.relation}]`);
  console.error(`  作品: ${record.targetWorkTitle.slice(0, 60) || record.targetWorkUrl.slice(0, 60)}`);
  console.error(`  ID: ${record.targetWorkId}`);
  console.error(`====================================================`);
  console.error(`  评论候选:`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const riskTag = c.riskLevel === 'low' ? '[low]' : '[med]';
    const modeTag = c.replyMode === 'auto_simple' ? '固定' : '生成';
    console.error(`  ${i === 0 ? '>' : ' '} ${i + 1}. "${c.text}" ${riskTag} ${modeTag}`);
  }

  const promptText = isExecute
    ? '\n请选择评论候选，选择后将立即执行当前条；输入 s 跳过，q 停止。\n> '
    : '\n请选择评论候选用于预览；当前为 dry-run，不会执行真实点赞/评论。\n> ';

  const answer = await ask(promptText);
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === 'q') {
    console.error('[live-review]   用户要求停止本轮');
    return { action: 'quit' };
  }

  if (trimmed === 's') {
    console.error('[live-review]   用户跳过当前条');
    return { action: 'skip' };
  }

  const choice = parseInt(trimmed, 10);
  if (isNaN(choice) || choice < 1 || choice > candidates.length) {
    console.error(`[live-review]   无效输入 "${answer}"，跳过当前条`);
    return { action: 'skip' };
  }

  const selected = candidates[choice - 1];
  record.selectedCommentText = selected.text;
  record.commentCategory = selected.commentCategory;
  record.replyMode = selected.replyMode;
  record.riskLevel = selected.riskLevel;
  record.generationReason = selected.reason;
  record.sourceSignals = selected.sourceSignals;
  record.manualReviewMethod = selected.replyMode === 'auto_simple' ? 'user_selected_template' : 'user_selected_agent_comment';
  record.autoExecuteAllowed = false;
  console.error(`[live-review]   选择 #${choice}: "${selected.text}" (risk=${selected.riskLevel}, mode=${selected.replyMode})`);

  if (!isExecute) {
    console.error(`[live-review]   dry-run 模式，不执行真实操作`);
    return { action: 'selected', selected };
  }

  // risk gate: high or ignore always blocked; also need selectedCommentText + correct manualReviewMethod
  if (!isExecuteAllowedByRisk(selected, record)) {
    record.status = 'blocked';
    record.reason = 'comment_risk_too_high';
    console.error(`[live-review]   风险等级=${selected.riskLevel}, replyMode=${selected.replyMode}，不允许执行`);
    return { action: 'blocked', selected };
  }

  // execute mode: re-check like state on current page, then act
  console.error(`[live-review]   执行模式 — 重新检查点赞状态...`);
  const recheck = await checkLikeState(page);
  const reclass = classifyLikeResult(recheck);

  if (reclass.status === 'blocked') {
    record.actionResults = { like: 'blocked', comment: null, reason: 'LIKE_STATE_UNKNOWN' };
    console.error(`[live-review]   re-check 点赞状态未知，跳过执行`);
    return { action: 'blocked', selected };
  }

  if (reclass.status === 'skipped') {
    record.actionResults = { like: 'skipped', comment: null, reason: 'already_liked' };
    console.error(`[live-review]   re-check 已点赞，跳过评论`);
    return { action: 'skipped', selected };
  }

  // not_liked: execute like + comment
  console.error(`[live-review]   未点赞 — 执行点赞...`);
  const likeExec = await clickLike(page, { execute: true });
  if (!likeExec.ok) {
    record.actionResults = { like: likeExec.code, comment: null, reason: likeExec.message };
    console.error(`[live-review]   点赞失败: ${likeExec.message}`);
    return { action: 'like_failed', selected };
  }

  const confirm = await confirmLikeSucceeded(page);
  if (!confirm.ok) {
    record.actionResults = { like: 'clicked_but_unconfirmed', comment: null };
    console.error(`[live-review]   点赞后无法确认`);
    return { action: 'like_unconfirmed', selected };
  }

  record.actionResults = { like: 'confirmed', comment: null };
  console.error(`[live-review]   点赞成功`);

  // post comment
  console.error(`[live-review]   发表评论: "${selected.text}"...`);
  const commentExec = await postVideoComment(page, selected.text, { execute: true });
  if (!commentExec.ok) {
    record.actionResults.comment = commentExec.code;
    console.error(`[live-review]   评论失败: ${commentExec.message}`);
    return { action: 'comment_failed', selected };
  }

  if (commentExec.data?.unconfirmed) {
    record.actionResults.comment = 'unconfirmed';
    record.actionResults.commentReason = 'comment_not_confirmed';
    console.error(`[live-review]   评论已发送但未确认`);
  } else {
    record.actionResults.comment = 'confirmed';
    console.error(`[live-review]   评论成功`);
  }
  return { action: 'executed', selected };
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const useJson = commonArgs.options.json;
  const maxItems = commonArgs.options.maxItems || 10;
  const isExecute = commonArgs.options.execute;

  console.error('[live-review] 读取待处理事件...');
  const allEvents = getEvents({ status: 'new', limit: 200 });
  const plan = generatePlan(allEvents);
  const candidates = plan.visitWorkCandidates;
  const totalCandidates = candidates.length;

  if (candidates.length === 0) {
    console.error('[live-review] 没有好友回访候选。先运行 npm run interactions:scan 再 npm run actions:plan');
    if (useJson) {
      printJsonResult('visits:live-review', { reviewCandidates: [] }, {
        totalCandidates: 0, processed: 0, pendingReview: 0, skipped: 0, blocked: 0, executed: 0, stopped: false,
      });
    }
    rl.close();
    return;
  }

  const slice = candidates.slice(0, maxItems);
  console.error(`[live-review] ${totalCandidates} 个候选，本轮最多处理 ${maxItems} 个`);

  const run = createRunContext('visits:live-review', commonArgs.options);
  let browser = null;
  let page = null;
  const discoveries = [];

  try {
    console.error('[live-review] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  } catch (err) {
    console.error('[live-review] 浏览器启动失败:', err.message);
    if (useJson) {
      printJsonError('visits:live-review', RESULT_CODES.UNKNOWN_ERROR, '浏览器启动失败: ' + err.message);
    }
    rl.close();
    return;
  }

  let stopped = false;

  try {
    for (let i = 0; i < slice.length; i++) {
      const item = await processCandidate(page, slice[i]);
      discoveries.push(item);
      run.scanned++;

      if (item.status === 'blocked') {
        run.blocked++;
        continue;
      }

      if (item.status === 'skipped') {
        run.skipped++;
        continue;
      }

      // pending_review: enter interactive selection
      run.planned++;
      const result = await interactiveSelect(page, item, isExecute);

      if (result.action === 'quit') {
        stopped = true;
        break;
      }

      if (result.action === 'executed' || result.action === 'comment_failed' || result.action === 'like_failed' || result.action === 'like_unconfirmed') {
        run.executed++;
        if (result.action === 'executed') run.succeeded++;
        else run.failed++;
      }
    }
  } catch (err) {
    console.error('[live-review] 处理异常:', err.message);
    run.hadError = true;
  } finally {
    rl.close();
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (shouldClose && browser) {
      console.error('[live-review] 关闭浏览器...');
      await browser.close().catch(() => {});
    }
  }

  const pendingReview = discoveries.filter(d => d.status === 'pending_review').length;
  const skipped = discoveries.filter(d => d.status === 'skipped').length;
  const blocked = discoveries.filter(d => d.status === 'blocked').length;
  const executed = discoveries.filter(d => d.actionResults?.like === 'confirmed' || d.actionResults?.comment === 'confirmed').length;
  const processed = discoveries.length;

  console.error(`\n===== 汇总 =====`);
  console.error(`  候选总数: ${totalCandidates} | 处理: ${processed} | 待审核: ${pendingReview} | 跳过: ${skipped} | 阻塞: ${blocked} | 已执行: ${executed}`);
  for (const d of discoveries) {
    if (d.status === 'pending_review') {
      const draftInfo = d.selectedCommentText ? ` 评论: "${d.selectedCommentText}"` : ' 未选择';
      const actionInfo = d.actionResults ? ` 执行结果: ${JSON.stringify(d.actionResults)}` : '';
      console.error(`  [${d.sourceEventIds.join(',')}] ${d.actorName} → ${d.targetWorkUrl}${draftInfo}${actionInfo}`);
    } else if (d.status === 'skipped') {
      console.error(`  - ${d.actorName}: ${d.reason}`);
    } else {
      console.error(`  x ${d.actorName}: ${d.reason || '未知'}`);
    }
  }

  if (useJson) {
    const reviewCandidates = discoveries
      .filter(d => d.status === 'pending_review')
      .map(d => ({
        actorName: d.actorName,
        actorProfileUrl: d.actorProfileUrl,
        relation: d.relation,
        sourceEventIds: d.sourceEventIds,
        sourceEventTypes: d.sourceEventTypes,
        targetWorkUrl: d.targetWorkUrl,
        targetWorkId: d.targetWorkId,
        targetWorkTitle: d.targetWorkTitle,
        likeState: d.likeState,
        suggestedActions: d.plannedActions,
        generatedCommentCandidates: d.generatedCommentCandidates || [],
        usedFallback: d.usedFallback,
        selectedCommentText: d.selectedCommentText,
        commentCategory: d.commentCategory,
        replyMode: d.replyMode,
        riskLevel: d.riskLevel,
        generationReason: d.generationReason,
        sourceSignals: d.sourceSignals,
        manualReviewMethod: d.manualReviewMethod,
        autoExecuteAllowed: d.autoExecuteAllowed,
        actionResults: d.actionResults,
        requiresManualReview: true,
        executeAllowed: false,
        previewOnly: !isExecute,
      }));

    printJsonResult('visits:live-review', { reviewCandidates }, {
      totalCandidates,
      processed,
      pendingReview,
      skipped,
      blocked,
      executed,
      stopped,
    });
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/live-review-visits.mjs') || process.argv[1].endsWith('\\live-review-visits.mjs')
);
if (isMain) {
  main().catch(err => {
    console.error('[live-review] 错误:', err.message);
    printJsonError('visits:live-review', RESULT_CODES.UNKNOWN_ERROR, err.message);
    process.exit(1);
  });
}
