// 评论回复执行命令
// 默认从数据库查询 pending 回评，直接调用 Hermes/OpenClaw 生成 reply_text 后执行回复。
//
// 用法：
//   npm run comments:execute
//   npm run comments:execute -- --limit 50
//   npm run comments:execute -- --agent-only
//
// 输入要求：
//   命令只从数据库查询待回评评论，并自动生成缺失的 reply_text。
//   已经 succeeded/sent_unverified 的评论会跳过重复执行。
//   命令默认真实执行回复，不再需要 --execute。

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, saveReplyText, markCommentReplied, markCommentBlocked, markCommentPending, markCommentSentUnverified, markCommentSkipped, markCommentManuallyReplied, markCommentRetryFailure, findCommentByWorkActorAndText, listPendingCommentsGroupedByHomepageAndWork, WORK_COMMENT_MAX_RETRY_COUNT } from '../db/work-comment-repository.mjs';
import { findWorkByIdentity } from '../db/work-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { createBrowserContext, replaceContextPage } from '../browser/browser-context.mjs';
import { detectDouyinSecurityVerification } from '../browser/douyin-auth-state.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { buildDouyinWorkUrl } from '../utils/douyin-url.mjs';
import {
  buildWorkReplyTarget,
  WORK_COMMENT_CONTAINER_SELECTORS,
  WORK_COMMENT_ITEM_SELECTORS,
  clickSendWorkReply,
  collectVisibleWorkCommentCandidates,
  expandVisibleWorkCommentReplies,
  fillWorkReplyText,
  openReplyBoxForMatchedWorkComment,
  parseDouyinTimeText,
  pickWorkCommentCandidate,
  scrollCommentAreaOnce,
  waitForWorkCommentArea,
  waitForWorkModal,
  quietWorkModalMedia,
  releaseWorkModalMediaQuietGuard,
  verifyWorkReplyVisible,
} from '../adapters/work-modal-page.mjs';
import { createCommentSubmitApiWatcher } from '../adapters/comment-submit-api-listener.mjs';
import { createCommentListApiCollector } from '../adapters/comment-list-api-listener.mjs';
import { closeCurrentWorkModalToProfile, openProfileWorkByAwemeIdFromPostApi } from '../services/return-visit-work-collector.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { createRunDebugRecorder } from '../browser/run-debug-recorder.mjs';
import { LocalAgentProvider } from '../agent/local-agent-provider.mjs';
import { createAgentProvider } from '../agent/agent-provider-factory.mjs';
import { normalizeNoticeApiItem } from '../domain/notice-api-normalization.mjs';
import { countVisibleChars, getReplyLengthTolerance, getReplyMaxLength, getReplyMinLength, hasForbiddenReplyPersona, hasLowQualityReplyText } from '../agent/comment-agent-server.mjs';

export function parseArgs(argv) {
  const args = {
    unsupportedItemsFile: false,
    json: false,
    diagnosePosition: false,
    keepOpen: false,
    headless: undefined,
    limit: null,
    hours: null,
    maxScrollRounds: null,
    agentOnly: false,
    debug: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items-file') {
      args.unsupportedItemsFile = true;
      if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) i++;
    }
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--diagnose-position') args.diagnosePosition = true;
    if (argv[i] === '--keep-open') args.keepOpen = true;
    if (argv[i] === '--headless') args.headless = true;
    if (argv[i] === '--debug') args.debug = true;
    if ((argv[i] === '--limit' || argv[i] === '--max-count') && argv[i + 1]) args.limit = Number(argv[++i] || 0) || null;
    if (argv[i] === '--hours' && argv[i + 1]) args.hours = Number(argv[++i] || 0) || null;
    if (argv[i] === '--max-scroll-rounds' && argv[i + 1]) args.maxScrollRounds = Number(argv[++i] || 0) || null;
    if (argv[i] === '--agent-only') args.agentOnly = true;
  }

  return args;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveCommentActionCooldown(env = process.env) {
  const minMs = readPositiveInt(env.LISHANGWANGLAI_COMMENT_ACTION_COOLDOWN_MIN_MS, 3000);
  const maxMs = Math.max(minMs, readPositiveInt(env.LISHANGWANGLAI_COMMENT_ACTION_COOLDOWN_MAX_MS, 6000));
  return { minMs, maxMs };
}

function randomIntBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function waitCommentActionCooldown(page, env = process.env) {
  const { minMs, maxMs } = resolveCommentActionCooldown(env);
  const delayMs = randomIntBetween(minMs, maxMs);
  console.error(`[comments:execute] 风控冷却 ${delayMs}ms 后继续下一条回评`);
  if (typeof page?.waitForTimeout === 'function') await page.waitForTimeout(delayMs);
  else await new Promise(resolve => setTimeout(resolve, delayMs));
}

export function buildWorkCommentItemsFromDbRows(rows = []) {
  return rows.map((row, index) => ({
    itemIndex: index,
    commentId: Number(row.id),
    replyText: String(row.reply_text || ''),
    homepageUrl: row.joined_author_profile_url || '',
    homepage_url: row.joined_author_profile_url || '',
    authorProfileUrl: row.joined_author_profile_url || '',
    authorProfileKey: row.joined_author_profile_key || '',
    workUrl: row.joined_work_url || row.work_url || '',
    awemeUrl: row.joined_work_url || row.work_url || '',
    workId: row.joined_work_id || row.work_id || '',
    modalId: row.joined_modal_id || row.modal_id || '',
    workKey: row.joined_work_id || row.work_id || row.joined_modal_id || row.modal_id || '',
    work_title: row.joined_work_title || '',
    work_desc: row.joined_work_desc || '',
    work_type: row.joined_work_type || '',
    work_published_at: row.joined_published_at || '',
    author_name: row.joined_author_name || '',
    actorName: row.actor_name || '',
    actorProfileUrl: row.actor_profile_url || '',
    actorProfileKey: row.actor_profile_key || '',
    commentText: row.comment_text || '',
    eventTimeText: row.event_time_text || '',
    firstSeenAt: row.first_seen_at || '',
    lastSeenAt: row.last_seen_at || '',
    repliedAt: row.replied_at || '',
    createdAt: row.created_at || '',
    targetCommentId: extractTargetCommentId({}, row),
    replyStatus: row.reply_status || '',
    raw_comment_json: row.raw_comment_json || '',
  }));
}

export function buildReplyContext(item = {}) {
  const maxLength = getReplyMaxLength();
  const minLength = getReplyMinLength();
  const workId = item.workId || item.modalId || '';
  const workUrl = item.workUrl || item.awemeUrl || '';
  return {
    taskId: `work_comment_${item.commentId}`,
    work: {
      workId,
      url: workUrl,
      title: item.work_title || item.workTitle || '',
      desc: item.work_desc || item.workText || '',
      authorNickname: item.author_name || '',
      publishedAt: item.work_published_at || '',
    },
    comment: {
      commentId: item.commentId || '',
      actorName: item.actorName || '',
      text: item.commentText || '',
      timeText: item.eventTimeText || '',
    },
    requirements: {
      minLength,
      maxLength,
      tone: '自然、简短、像真人',
      uniquenessPolicy: '同一好友在不同作品下不要复用同一句回复',
      actorWorkKey: `${item.actorName || ''}::${workId || workUrl || item.commentId || ''}`,
      avoidReplyText: item.avoidReplyText || '',
    },
  };
}

export function isReplyTextInvalid(replyText, { minLength = getReplyMinLength(), maxLength = getReplyMaxLength(), lengthTolerance = getReplyLengthTolerance() } = {}) {
  const text = String(replyText || '').trim();
  if (!text) return false;
  const visibleLength = countVisibleChars(text);
  const minAllowed = Math.max(1, Number(minLength) - Number(lengthTolerance));
  const maxAllowed = Number(maxLength) + Number(lengthTolerance);
  if (visibleLength < minAllowed) return true;
  if (visibleLength > maxAllowed) return true;
  if (hasForbiddenReplyPersona(text)) return true;
  if (hasLowQualityReplyText(text)) return true;
  return false;
}

export const isReplyTextTooShort = isReplyTextInvalid;

function normalizeReplyComparisonText(text = '') {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?\-~～"'`]/g, '')
    .trim();
}

function buildSameActorReplyConflictGroups(batchDecisions = [], byTaskId = new Map()) {
  const groups = new Map();
  for (const decision of batchDecisions) {
    const item = decision.item || {};
    const actorName = String(item.actorName || '').trim();
    const workKey = String(item.workKey || item.workId || item.modalId || item.workUrl || '').trim();
    const reply = String(byTaskId.get(decision.taskId) || '').trim();
    const normalizedReply = normalizeReplyComparisonText(reply);
    if (!actorName || !workKey || !normalizedReply) continue;
    const groupKey = `${actorName}::${normalizedReply}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ decision, actorName, workKey, reply });
  }

  return [...groups.values()].filter(group => {
    if (group.length < 2) return false;
    return new Set(group.map(entry => entry.workKey)).size > 1;
  });
}

function buildDistinctReplyFallback(item = {}, originalReply = '') {
  const topic = String(item.work_title || item.work_desc || item.commentText || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?\-~～"'`]/g, '')
    .slice(0, 12);
  const reply = topic
    ? `你提到的这点和${topic}这条内容挺贴，我也继续顺着聊聊。`
    : '你提到的这点我记住了，这条内容里也刚好能接上聊聊。';
  const normalizedFallback = normalizeReplyComparisonText(reply);
  if (!reply || normalizedFallback === normalizeReplyComparisonText(originalReply) || isReplyTextInvalid(reply)) {
    throw new Error(`同好友跨作品回复去重失败 commentId=${item.commentId}`);
  }
  return reply;
}

async function resolveSameActorReplyConflicts(batchDecisions = [], byTaskId = new Map(), agentProvider) {
  const conflictGroups = buildSameActorReplyConflictGroups(batchDecisions, byTaskId);
  if (conflictGroups.length === 0) return;
  if (typeof agentProvider?.generateReply !== 'function') {
    throw new Error('agentProvider.generateReply 不存在，无法对同好友跨作品重复回复做单条重生成');
  }

  for (const group of conflictGroups) {
    const [, ...conflictedEntries] = group;
    for (const entry of conflictedEntries) {
      const { decision, reply: oldReply } = entry;
      const context = buildReplyContext({
        ...(decision.item || {}),
        avoidReplyText: oldReply,
      });

      let regenerated = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        regenerated = String(await agentProvider.generateReply(context) || '').trim();
        if (!regenerated) continue;
        if (isReplyTextInvalid(regenerated, context.requirements)) continue;
        if (normalizeReplyComparisonText(regenerated) === normalizeReplyComparisonText(oldReply)) continue;
        break;
      }

      if (!regenerated
        || isReplyTextInvalid(regenerated, context.requirements)
        || normalizeReplyComparisonText(regenerated) === normalizeReplyComparisonText(oldReply)) {
        regenerated = buildDistinctReplyFallback(decision.item, oldReply);
      }

      byTaskId.set(decision.taskId, regenerated);
    }
  }
}

export async function generateMissingReplies(items = [], { agentProvider = new LocalAgentProvider(), batchSize = 8 } = {}) {
  const decisions = [];
  const pendingContexts = [];

  for (const item of items) {
    const commentId = Number(item.commentId || 0);
    const existing = String(item.replyText || '').trim();
    if (!commentId) {
      decisions.push({ result: { commentId, ok: true, skipped: true, reason: 'missing_comment_id' } });
      continue;
    }
    if (existing && !isReplyTextInvalid(existing)) {
      decisions.push({ result: { commentId, ok: true, skipped: true, reason: 'reply_text_exists' } });
      continue;
    }

    const context = buildReplyContext(item);
    pendingContexts.push(context);
    decisions.push({ type: 'generate', item, commentId, taskId: context.taskId });
  }

  if (pendingContexts.length === 0) return decisions.map(decision => decision.result);

  if (typeof agentProvider.generateReplies !== 'function') {
    const message = 'agentProvider.generateReplies 不存在，无法一次性生成待回评列表';
    for (const decision of decisions.filter(item => item.type === 'generate')) {
      saveRetryablePending({ commentId: decision.commentId }, `agent_generate_failed:${message}`);
      decision.result = { commentId: decision.commentId, ok: false, error: message };
    }
    return decisions.map(decision => decision.result);
  }

  const resolvedBatchSize = Math.max(1, Math.min(Number(batchSize) || 8, 20));
  const batchCount = Math.ceil(pendingContexts.length / resolvedBatchSize);

  console.error(`[agent] batch 分 ${batchCount} 批生成回复, 每批最多 ${resolvedBatchSize} 条, 共 ${pendingContexts.length} 条`);

  for (let batchIndex = 0; batchIndex < pendingContexts.length; batchIndex += resolvedBatchSize) {
    const batchContexts = pendingContexts.slice(batchIndex, batchIndex + resolvedBatchSize);
    const batchDecisions = decisions.filter(decision => {
      return decision.type === 'generate' && batchContexts.some(context => context.taskId === decision.taskId);
    });

    try {
      console.error(`[agent] batch ${Math.floor(batchIndex / resolvedBatchSize) + 1}/${batchCount} 请求生成回复 count=${batchContexts.length}`);
      const replies = await agentProvider.generateReplies(batchContexts);
      if (!Array.isArray(replies)) throw new Error('Agent 返回格式错误: replies 必须是数组');
      if (replies.length !== batchContexts.length) {
        throw new Error(`Agent 返回回复数量不匹配: ${replies.length}/${batchContexts.length}`);
      }

      const expectedTaskIds = new Set(batchContexts.map(context => String(context.taskId || '').trim()));
      const byTaskId = new Map();
      for (const item of replies) {
        const taskId = String(item?.taskId || '').trim();
        const reply = String(item?.reply || '').trim();
        if (!expectedTaskIds.has(taskId)) throw new Error(`Agent 返回未知 taskId: ${taskId || '(empty)'}`);
        if (byTaskId.has(taskId)) throw new Error(`Agent 返回重复 taskId: ${taskId}`);
        if (taskId) byTaskId.set(taskId, reply);
      }

      for (const context of batchContexts) {
        const taskId = String(context.taskId || '').trim();
        if (!byTaskId.has(taskId)) throw new Error(`Agent 缺少回复 taskId: ${taskId}`);
        const reply = byTaskId.get(taskId);
        if (!reply || isReplyTextInvalid(reply, context.requirements)) {
          throw new Error(`Agent 返回回复不符合发送要求 taskId=${taskId}`);
        }
      }

      await resolveSameActorReplyConflicts(batchDecisions, byTaskId, agentProvider);

      for (const decision of batchDecisions) {
        const reply = byTaskId.get(decision.taskId);
        saveReplyText(decision.commentId, reply);
        decision.item.replyText = reply;
        console.error(`[agent] commentId=${decision.commentId} 回复生成成功 reply=${reply}`);
        decision.result = { commentId: decision.commentId, ok: true, reply };
      }
    } catch (err) {
      const message = err?.message || String(err);
      for (const decision of batchDecisions) {
        saveRetryablePending({ commentId: decision.commentId }, `agent_generate_failed:${message}`);
        console.error(`[agent] commentId=${decision.commentId} failed reason=${message}`);
        decision.result = { commentId: decision.commentId, ok: false, error: message };
      }
    }
  }

  return decisions.map(decision => decision.result);
}

function saveRetryablePending(item, reason) {
  const failed = markCommentRetryFailure(item.commentId, reason, {
    maxRetryCount: WORK_COMMENT_MAX_RETRY_COUNT,
  });
  return failed?.finalStatus || 'pending';
}

export function groupExecutableItemsByWork(items) {
  const groups = new Map();
  for (const item of items) {
    const homepageKey = item.homepageUrl || item.authorProfileUrl || item.homepage_url || '';
    const workKey = item.workId || item.modalId || `comment:${item.commentId}`;
    const key = `${homepageKey}::${workKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

export function resolveWorkUrlFromItem(item = {}, row = {}) {
  const directUrl = item.workUrl || item.work_url || row.work_url || '';
  if (directUrl) return directUrl;

  const awemeUrl = item.awemeUrl || item.aweme_url || row.aweme_url || '';
  if (awemeUrl) return awemeUrl;

  const workId = item.workId || item.work_id || row.work_id || '';
  if (workId) return `https://www.douyin.com/video/${workId}`;

  const modalId = item.modalId || item.modal_id || row.modal_id || '';
  if (modalId) return `https://www.douyin.com/video/${modalId}`;

  return '';
}

export function extractTargetCommentId(item = {}, row = {}) {
  const direct = String(
    item.targetCommentId ??
    item.commentTargetId ??
    item.commentCid ??
    item.cid ??
    item.comment_key ??
    item.comment_id ??
    row.target_comment_id ??
    row.comment_key ??
    ''
  ).trim();
  if (direct) return direct;

  const rawCommentJson = row.raw_comment_json || item.raw_comment_json || '';
  if (!rawCommentJson) return '';

  try {
    const parsed = JSON.parse(rawCommentJson);
    return String(
      parsed?.comment?.comment?.commentId ??
      parsed?.comment?.comment?.cid ??
      parsed?.comment?.commentId ??
      parsed?.comment?.cid ??
      parsed?.targetCommentId ??
      ''
    ).trim();
  } catch {
    return '';
  }
}

export function classifyStoredWorkCommentRaw(rawCommentJson = '') {
  if (!rawCommentJson) return { ok: true, action: 'unknown', eventType: 'unknown', reason: 'missing_raw' };

  try {
    const parsed = JSON.parse(rawCommentJson);

    // Only raw notification payloads carry a Douyin notice type. Other sources such
    // as comment-list snapshots are already scoped to an opened work and cannot be
    // safely reclassified here.
    if (parsed?.type !== 31 || !parsed?.comment) {
      return { ok: true, action: 'unknown', eventType: 'unknown', reason: 'not_notice_api_raw' };
    }

    const normalized = normalizeNoticeApiItem(parsed);
    const action = normalized?.notificationAction || 'unknown';
    const eventType = normalized?.eventType || 'unknown';

    if (action !== 'comment_on_my_work' || eventType !== 'comment') {
      return {
        ok: false,
        action,
        eventType,
        reason: `not_comment_on_my_work:${action || eventType || 'unknown'}`,
      };
    }

    return { ok: true, action, eventType, reason: 'comment_on_my_work' };
  } catch {
    return { ok: true, action: 'unknown', eventType: 'unknown', reason: 'parse_failed' };
  }
}

export function isDoneWithoutRetryResult(result) {
  return Boolean(result?.ok)
    || (!result?.ok && result?.status === 'succeeded')
    || (!result?.ok && result?.status === 'sent_unverified');
}

export function isSecurityVerificationResult(result = {}) {
  return Boolean(result?.securityVerification)
    || result?.code === RESULT_CODES.IDENTITY_NOT_VERIFIED
    || result?.error === 'security_verification_required';
}

export function validateWorkCommentItem(item) {
  const inputCommentId = Number(item.commentId);
  if (!item.commentId) {
    return { itemIndex: item.itemIndex, inputCommentId, ok: false, error: '缺少 work_comments.id；请先执行 interactions:scan 入库' };
  }
  let row = getWorkComment(item.commentId);
  if (!row) {
    row = findCommentByWorkActorAndText({
      workId: item.workId || '',
      modalId: item.modalId || '',
      actorName: item.actorName || '',
      commentText: item.commentText || '',
    });
    if (row) {
      console.error(`[comments:execute] commentId=${item.commentId} 已失效，回退命中当前记录 id=${row.id}`);
    }
  }
  if (!row) {
    return { itemIndex: item.itemIndex, inputCommentId, commentId: item.commentId, ok: false, error: `找不到 work_comments.id=${item.commentId}` };
  }

  const replyText = String(item.replyText || row.reply_text || '').trim();
  if (!replyText) {
    console.error(`[comments:execute] commentId=${item.commentId} reply_text 为空，跳过执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'skipped_empty_reply' };
  }
  if (isReplyTextInvalid(replyText)) {
    const visibleLength = countVisibleChars(replyText);
    const minAllowed = Math.max(1, getReplyMinLength() - getReplyLengthTolerance());
    const maxAllowed = getReplyMaxLength() + getReplyLengthTolerance();
    const reason = visibleLength < minAllowed
      ? `reply_text_too_short:${visibleLength}/${minAllowed}`
      : visibleLength > maxAllowed
        ? `reply_text_too_long:${visibleLength}/${maxAllowed}`
        : 'reply_text_missing_agent_disclosure';
    markCommentPending(row.id, reason);
    console.error(`[comments:execute] commentId=${item.commentId} reply_text 不符合发送要求，跳过执行 reason=${reason}`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'skipped', error: reason };
  }

  if (row.reply_status === 'succeeded') {
    console.error(`[comments:execute] commentId=${item.commentId} 已回复成功，跳过重复执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'succeeded' };
  }
  if (row.reply_status === 'sent_unverified') {
    console.error(`[comments:execute] commentId=${item.commentId} 已发送但未确认，跳过重复执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'sent_unverified', fromAlready: true };
  }
  if (row.reply_status === 'manually_replied') {
    console.error(`[comments:execute] commentId=${item.commentId} 作者已手动回复，跳过执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'manually_replied' };
  }

  const rawClass = classifyStoredWorkCommentRaw(row.raw_comment_json || item.raw_comment_json || '');
  if (!rawClass.ok) {
    const reason = rawClass.reason || 'not_comment_on_my_work';
    markCommentSkipped(row.id, reason);
    console.error(`[comments:execute] commentId=${row.id} 跳过非“别人评论我的作品”通知 reason=${reason}`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'skipped', error: reason };
  }

  const workId = item.workId || row.work_id || '';
  const modalId = item.modalId || row.modal_id || '';
  if (!workId && !modalId) {
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, error: 'work_id/modal_id 为空，无法在主页作品列表匹配作品' };
  }

  const knownWork = findWorkByIdentity({ workId, modalId });
  const homepageUrl = item.homepageUrl
    || item.homepage_url
    || item.authorProfileUrl
    || item.author_profile_url
    || knownWork?.author_profile_url
    || '';
  const workUrl = item.workUrl
    || item.awemeUrl
    || item.work_url
    || row.work_url
    || knownWork?.work_url
    || buildDouyinWorkUrl(workId || modalId);
  const authorProfileKey = item.authorProfileKey
    || item.author_profile_key
    || knownWork?.author_profile_key
    || '';

  if (!homepageUrl && !workUrl) {
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, error: 'homepage_url/work_url 均为空，无法定位作品' };
  }

  return {
    ...item,
    itemIndex: item.itemIndex,
    inputCommentId,
    commentId: row.id,
    ok: true,
    status: row.reply_status,
    rowId: row.id,
    rawCommentJson: row.raw_comment_json || '',
    firstSeenAt: row.first_seen_at || item.firstSeenAt || '',
    lastSeenAt: row.last_seen_at || item.lastSeenAt || '',
    repliedAt: row.replied_at || item.repliedAt || '',
    createdAt: row.created_at || item.createdAt || '',
    homepageUrl,
    homepage_url: homepageUrl,
    authorProfileUrl: homepageUrl,
    authorProfileKey,
    workUrl,
    awemeUrl: workUrl,
    workId,
    modalId,
    workKey: item.workKey || workId || modalId || '',
    actorName: item.actorName || row.actor_name || '',
    actorProfileUrl: item.actorProfileUrl || row.actor_profile_url || '',
    commentText: item.commentText || row.comment_text || '',
    eventTimeText: item.eventTimeText || row.event_time_text || '',
    targetCommentId: extractTargetCommentId(item, row),
    replyText,
  };
}

function buildPendingMap(group) {
  return new Map(group.map(item => [item.commentId, item]));
}

function normalizeVisibleCandidatesResult(collected) {
  if (!collected?.ok) return [];
  return Array.isArray(collected.candidates) ? collected.candidates : [];
}

function getCollectorTargetComment(validated, commentListCollector) {
  if (!validated?.targetCommentId || !commentListCollector?.getByCid) return null;
  return commentListCollector.getByCid(validated.targetCommentId) || null;
}

function shouldBlockViewportMismatch(target, picked) {
  if (!picked?.reason) return false;

  if (picked.reason === 'not_unique') {
    return true;
  }

  if (picked.reason === 'actor_not_verified') {
    return Boolean(target?.targetCommentId);
  }

  if (picked.reason === 'time_not_verified') {
    if (target?.targetCommentId) return true;
    return Number(picked.total || 0) === 1;
  }

  return false;
}

export function planViewportPendingMatches(pendingItems, visibleCandidates, {
  commentListCollector = null,
  buildTarget = buildWorkReplyTarget,
  pickCandidate = pickWorkCommentCandidate,
} = {}) {
  const actionable = [];
  const blocked = [];
  const usedDomIndexes = new Set();

  for (const pendingItem of pendingItems) {
    const apiComment = getCollectorTargetComment(pendingItem, commentListCollector);
    const target = buildTarget(pendingItem, apiComment);

    if (apiComment?.hasAuthorReply) {
      blocked.push({
        item: pendingItem,
        target,
        picked: {
          ok: true,
          reason: 'manually_replied',
          matchedBy: 'comment_list_api_author_reply',
          candidate: null,
        },
        blockedReason: 'manually_replied',
      });
      continue;
    }

    const availableCandidates = (visibleCandidates || []).filter(candidate => !usedDomIndexes.has(candidate.domIndex));
    const manualPicked = pickCandidate(
      availableCandidates.filter(candidate => candidate.hasAuthorReply),
      target,
      { requireReplyButton: false }
    );

    if (manualPicked.ok && manualPicked.candidate) {
      manualPicked.reason = 'manually_replied';
      blocked.push({ item: pendingItem, target, picked: manualPicked, blockedReason: 'manually_replied' });
      continue;
    }

    const picked = pickCandidate(availableCandidates, target);

    if (picked.ok && picked.candidate) {
      usedDomIndexes.add(picked.candidate.domIndex);
      actionable.push({ item: pendingItem, target, picked });
      continue;
    }

    if (shouldBlockViewportMismatch(target, picked)) {
      blocked.push({ item: pendingItem, target, picked });
    }
  }

  return { actionable, blocked };
}

function formatBlockedReason(blockedEntry) {
  if (blockedEntry?.blockedReason === 'manually_replied') {
    return 'manually_replied:author_already_replied';
  }
  const picked = blockedEntry?.picked || {};
  const target = blockedEntry?.target || {};
  if (picked.reason === 'not_unique') {
    return `not_unique:${target.commentText || ''}`;
  }
  if (picked.reason === 'actor_not_verified') {
    return `actor_not_verified:${target.actorName || ''}`;
  }
  if (picked.reason === 'time_not_verified') {
    return `time_not_verified:${target.eventTimeText || ''}`;
  }
  return picked.reason || 'blocked';
}

function getCandidateSignature(candidates = []) {
  return (candidates || [])
    .map(candidate => `${candidate.domIndex}:${candidate.cid || ''}:${candidate.actorName || ''}:${candidate.commentText || ''}`)
    .join('|');
}

function getUnixTimestampMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num > 1000000000000) return num;
  if (num > 1000000000) return num * 1000;
  return null;
}

function parseRawCommentCreateTime(rawCommentJson = '') {
  if (!rawCommentJson) return null;
  try {
    const parsed = JSON.parse(rawCommentJson);
    return getUnixTimestampMs(
      parsed?.comment?.comment?.create_time ??
      parsed?.comment?.create_time ??
      parsed?.create_time ??
      parsed?.comment?.comment?.createTime ??
      parsed?.comment?.createTime ??
      null
    );
  } catch {
    return null;
  }
}

function getApiCommentTimestampMs(apiComment = null) {
  if (!apiComment) return null;
  const unixMs = getUnixTimestampMs(apiComment.createTime ?? apiComment.create_time);
  if (unixMs) return unixMs;
  const parsed = Date.parse(apiComment.eventCreatedAt || apiComment.createdAt || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function toComparableTimestamp(text, { anchorAt = '' } = {}) {
  if (!text) return null;
  const anchorMs = Date.parse(anchorAt || '');
  const iso = parseDouyinTimeText(text, Number.isFinite(anchorMs) ? { now: new Date(anchorMs) } : {});
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : null;
}

function getCandidateTimestampMs(candidate = {}, commentListCollector = null) {
  const apiComment = candidate?.cid && commentListCollector?.getByCid
    ? commentListCollector.getByCid(candidate.cid)
    : null;
  return getApiCommentTimestampMs(apiComment) ?? toComparableTimestamp(candidate?.timeText || '');
}

function getPendingItemTimestampMs(item = {}, commentListCollector = null) {
  const apiComment = item?.targetCommentId && commentListCollector?.getByCid
    ? commentListCollector.getByCid(item.targetCommentId)
    : null;
  return getApiCommentTimestampMs(apiComment)
    ?? parseRawCommentCreateTime(item.rawCommentJson || item.raw_comment_json || '')
    ?? toComparableTimestamp(item?.eventTimeText || '', {
      anchorAt: item.firstSeenAt || item.first_seen_at || item.createdAt || item.created_at || item.lastSeenAt || item.last_seen_at || '',
    });
}

function summarizeViewportTimeRange(visibleCandidates = [], commentListCollector = null) {
  const timestamps = (visibleCandidates || [])
    .map(candidate => getCandidateTimestampMs(candidate, commentListCollector))
    .filter(ms => Number.isFinite(ms));
  if (timestamps.length === 0) return null;
  return {
    newestMs: Math.max(...timestamps),
    oldestMs: Math.min(...timestamps),
  };
}

function distanceFromTimeRangeToTarget(range, targetMs) {
  if (!range || !Number.isFinite(targetMs)) return null;
  if (targetMs >= range.oldestMs && targetMs <= range.newestMs) return 0;
  return Math.min(
    Math.abs(targetMs - range.newestMs),
    Math.abs(targetMs - range.oldestMs),
  );
}

function closestDistanceFromTimeRange(range, targetTimes = []) {
  const distances = (targetTimes || [])
    .map(targetMs => distanceFromTimeRangeToTarget(range, targetMs))
    .filter(distance => Number.isFinite(distance));
  if (distances.length === 0) return null;
  return Math.min(...distances);
}

const REPLY_SEARCH_TIMEOUT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function findReplySearchTimedOutItems(pendingItems = [], currentRange = null, {
  commentListCollector = null,
  timeoutDays = REPLY_SEARCH_TIMEOUT_DAYS,
} = {}) {
  if (!currentRange) return [];
  const timeoutMs = Number(timeoutDays || REPLY_SEARCH_TIMEOUT_DAYS) * MS_PER_DAY;
  if (!(timeoutMs > 0)) return [];

  return (pendingItems || [])
    .map(item => ({ item, targetMs: getPendingItemTimestampMs(item, commentListCollector) }))
    .filter(entry => Number.isFinite(entry.targetMs))
    .filter(entry => currentRange.newestMs < entry.targetMs - timeoutMs)
    .map(entry => ({
      ...entry,
      reason: `reply_timeout:visible_comment_older_than_target_over_${timeoutDays}_days`,
    }));
}

function shouldStartRollbackByTime(pendingItems = [], visibleCandidates = [], lastViewportTimeRange = null, { commentListCollector = null } = {}) {
  const currentRange = summarizeViewportTimeRange(visibleCandidates, commentListCollector);
  if (!currentRange || !lastViewportTimeRange) {
    return { shouldRollback: false, currentRange };
  }

  const pendingTimes = (pendingItems || [])
    .map(item => getPendingItemTimestampMs(item, commentListCollector))
    .filter(ms => Number.isFinite(ms));
  if (pendingTimes.length === 0) {
    return { shouldRollback: false, currentRange };
  }

  const currentClosestDistanceMs = closestDistanceFromTimeRange(currentRange, pendingTimes);
  const lastClosestDistanceMs = closestDistanceFromTimeRange(lastViewportTimeRange, pendingTimes);
  const minMeaningfulDriftMs = 60 * 1000;
  const movingFarther =
    Number.isFinite(currentClosestDistanceMs) &&
    Number.isFinite(lastClosestDistanceMs) &&
    currentClosestDistanceMs > lastClosestDistanceMs + minMeaningfulDriftMs;

  const overshot = pendingTimes.some(targetMs => currentRange.newestMs < targetMs);
  const movingOlder =
    currentRange.newestMs < lastViewportTimeRange.newestMs &&
    currentRange.oldestMs < lastViewportTimeRange.oldestMs;

  return {
    shouldRollback: movingFarther || (overshot && movingOlder),
    currentRange: {
      ...currentRange,
      closestDistanceMs: currentClosestDistanceMs,
    },
  };
}

async function scrollCommentViewport(page, { direction = 'down' } = {}) {
  if (direction !== 'up') {
    return scrollCommentAreaOnce(page);
  }

  const result = await page.evaluate((selectors) => {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const canScroll = el.scrollHeight > el.clientHeight + 20;
        if (!canScroll) continue;
        const before = el.scrollTop;
        const delta = Math.max(400, Math.round(el.clientHeight * 0.8));
        el.scrollTop = Math.max(0, before - delta);
        return {
          ok: true,
          scrolled: el.scrollTop !== before,
          atStart: el.scrollTop <= 5,
          before,
          after: el.scrollTop,
          direction: 'up',
        };
      }
    }
    return { ok: false, reason: 'comment_container_not_found', direction: 'up' };
  }, WORK_COMMENT_CONTAINER_SELECTORS).catch(() => ({ ok: false, reason: 'comment_container_not_found', direction: 'up' }));

  await page.waitForTimeout?.(600).catch(() => {});
  return result;
}

async function captureSinglePassDebugSnapshot(page, {
  currentWork = {},
  viewportRound = 0,
  visibleCandidates = [],
  pendingItems = [],
  commentListCollector = null,
} = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    return null;
  }
  try {
    const dir = resolve('data', 'debug', 'comment-single-pass');
    mkdirSync(dir, { recursive: true });
    const workKey = String(currentWork.workId || currentWork.modalId || currentWork.workUrl || 'unknown')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 120);
    const filePath = resolve(dir, `${workKey}-round${viewportRound}.json`);

    const domSnapshot = await page.evaluate(({ containerSelectors, itemSelectors }) => {
      function visible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function findContainer() {
        for (const selector of containerSelectors) {
          const el = document.querySelector(selector);
          if (visible(el)) return el;
        }
        return null;
      }

      const commentArea = findContainer();
      if (!commentArea) {
        return { found: false };
      }

      const itemSet = [];
      const seen = new Set();
      for (const selector of itemSelectors) {
        for (const item of commentArea.querySelectorAll(selector)) {
          if (!visible(item) || seen.has(item)) continue;
          seen.add(item);
          itemSet.push(item);
        }
      }

      const items = itemSet.slice(0, 20).map((item, index) => ({
        index,
        text: (item.innerText || '').trim(),
        html: item.outerHTML.slice(0, 4000),
      }));

      return {
        found: true,
        areaText: (commentArea.innerText || '').trim(),
        areaHtml: commentArea.outerHTML.slice(0, 12000),
        items,
      };
    }, {
      containerSelectors: WORK_COMMENT_CONTAINER_SELECTORS,
      itemSelectors: WORK_COMMENT_ITEM_SELECTORS,
    }).catch(err => ({ found: false, error: err.message }));

    const collectorComments = commentListCollector?.getAllComments?.() || [];
    const payload = {
      capturedAt: new Date().toISOString(),
      url: page.url(),
      work: {
        workId: currentWork.workId || '',
        modalId: currentWork.modalId || '',
        workUrl: currentWork.workUrl || '',
      },
      viewportRound,
      pendingItems: pendingItems.map(item => ({
        commentId: item.commentId,
        targetCommentId: item.targetCommentId || '',
        actorName: item.actorName || '',
        commentText: item.commentText || '',
        eventTimeText: item.eventTimeText || '',
      })),
      visibleCandidates,
      collectorComments: collectorComments.slice(0, 20),
      collectorStats: commentListCollector?.getStats?.() || null,
      domSnapshot,
    };

    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[comments:execute] debug snapshot saved file=${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[comments:execute] debug snapshot failed: ${err.message}`);
    return null;
  }
}

export async function executeSinglePassForWorkGroup(page, group, commentListCollector, {
  maxNoProgressRounds = 3,
  maxScrollRounds = 20,
  days = 0,
  collectCandidates = collectVisibleWorkCommentCandidates,
  expandReplies = expandVisibleWorkCommentReplies,
  openMatchedReplyBox = openReplyBoxForMatchedWorkComment,
  fillReply = fillWorkReplyText,
  clickSend = clickSendWorkReply,
  verifyReply = verifyWorkReplyVisible,
  scrollOnce = scrollCommentViewport,
  detectSecurityVerification = detectDouyinSecurityVerification,
  waitCooldown = waitCommentActionCooldown,
  saveSucceeded = (item) => {
    markCommentReplied(item.commentId);
    saveReplyText(item.commentId, item.replyText);
  },
  saveBlocked = (item, reason) => {
    markCommentBlocked(item.commentId, reason);
  },
  saveRetryable = (item, reason) => {
    saveRetryablePending(item, reason);
  },
  saveSentUnverified = (item, reason) => {
    markCommentSentUnverified(item.commentId, reason);
  },
  saveManuallyReplied = (item, reason) => {
    markCommentManuallyReplied(item.commentId, reason);
  },
  saveTimedOut = (item, reason) => {
    markCommentSkipped(item.commentId, reason);
  },
  createSubmitWatcher = (currentPage, expectedText, expectedTargetCommentId = '') => createCommentSubmitApiWatcher(currentPage, { expectedText, expectedTargetCommentId }),
  onResult = () => {},
} = {}) {
  const currentWork = group[0] || {};
  const pendingMap = buildPendingMap(group);
  const localResults = [];
  let viewportRound = 0;
  let noProgressRounds = 0;
  let lastSignature = '';
  let succeededCount = 0;
  let blockedCount = 0;
  let lastViewportTimeRange = null;
  let scrollRounds = 0;
  let rollbackRounds = 0;

  function stopForSecurityVerification(verification = null) {
    const reason = verification?.reason || 'security_verification_required';
    console.log('[comments:execute] 检测到手机号/短信安全认证，暂停自动回评并保留当前浏览器窗口');
    for (const item of pendingMap.values()) {
      const result = {
        ...item,
        ok: false,
        status: 'blocked',
        code: RESULT_CODES.IDENTITY_NOT_VERIFIED,
        error: reason,
        recoverable: false,
        securityVerification: verification || null,
      };
      localResults.push(result);
      onResult(result);
    }
    pendingMap.clear();
    return localResults;
  }

  console.log(`[comments:execute] single-pass start work=${currentWork.workId || currentWork.modalId || currentWork.workUrl} pending=${pendingMap.size}`);

  while (pendingMap.size > 0) {
    await quietWorkModalMedia(page, { installGuard: true, reason: 'single_pass_viewport_start' }).catch(() => null);
    await expandReplies(page, { maxClicks: 6 }).catch(() => null);
    await quietWorkModalMedia(page, { installGuard: true, reason: 'after_expand_replies' }).catch(() => null);
    const collected = await collectCandidates(page);
    const visibleCandidates = normalizeVisibleCandidatesResult(collected);
    const signature = getCandidateSignature(visibleCandidates);

    console.log(`[comments:execute] viewport round=${viewportRound} visible=${visibleCandidates.length} pending=${pendingMap.size}`);

    let progressedInViewport = false;

    while (pendingMap.size > 0) {
      const pendingItems = [...pendingMap.values()];
      const plan = planViewportPendingMatches(pendingItems, visibleCandidates, { commentListCollector });

      if (plan.blocked.length > 0) {
        await captureSinglePassDebugSnapshot(page, {
          currentWork,
          viewportRound,
          visibleCandidates,
          pendingItems: plan.blocked.map(entry => entry.item),
          commentListCollector,
        });
        for (const blockedEntry of plan.blocked) {
          if (!pendingMap.has(blockedEntry.item.commentId)) continue;
          const reason = formatBlockedReason(blockedEntry);
          if (blockedEntry.blockedReason === 'manually_replied') {
            saveManuallyReplied(blockedEntry.item, reason);
            pendingMap.delete(blockedEntry.item.commentId);
            blockedCount++;
            progressedInViewport = true;
            const result = { ...blockedEntry.item, ok: false, status: 'manually_replied', error: reason };
            localResults.push(result);
            onResult(result);
            console.log(`[comments:execute] manually_replied commentId=${blockedEntry.item.commentId} pending=${pendingMap.size}`);
          } else {
            saveBlocked(blockedEntry.item, reason);
            pendingMap.delete(blockedEntry.item.commentId);
            blockedCount++;
            progressedInViewport = true;
            const result = { ...blockedEntry.item, ok: false, status: 'blocked', error: reason };
            localResults.push(result);
            onResult(result);
            console.log(`[comments:execute] blocked commentId=${blockedEntry.item.commentId} reason=${pickedReasonLabel(blockedEntry.picked.reason)} pending=${pendingMap.size}`);
          }
        }
        continue;
      }

      const nextAction = plan.actionable[0];
      if (!nextAction) break;

      const opened = await openMatchedReplyBox(page, nextAction.target, nextAction.picked.candidate, {
        matchedBy: nextAction.picked.matchedBy,
      });
      await quietWorkModalMedia(page, { installGuard: true, reason: 'after_open_reply_box' }).catch(() => null);
      if (!opened.ok) {
        const reason = opened.message || opened.code || 'reply_box_not_opened';
        const finalStatus = saveRetryable(nextAction.item, `reply_box_not_opened:${reason}`) || 'pending';
        pendingMap.delete(nextAction.item.commentId);
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: finalStatus, error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const filled = await fillReply(page, nextAction.item.replyText);
      if (!filled.ok) {
        const reason = filled.message || filled.code || 'fill_failed';
        const finalStatus = saveRetryable(nextAction.item, `fill_failed:${reason}`) || 'pending';
        pendingMap.delete(nextAction.item.commentId);
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: finalStatus, error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const submitWatcher = createSubmitWatcher(
        page,
        nextAction.item.replyText,
        nextAction.item.targetCommentId || nextAction.target.targetCommentId || ''
      );
      let apiConfirmed = null;
      try {
        const sent = await clickSend(page);
        if (!sent.ok) {
          if (sent.code === RESULT_CODES.IDENTITY_NOT_VERIFIED) {
            return stopForSecurityVerification(sent.data || { reason: 'security_verification_required' });
          }
          const reason = sent.message || sent.code || 'send_failed';
          const finalStatus = saveRetryable(nextAction.item, `send_failed:${reason}`) || 'pending';
          pendingMap.delete(nextAction.item.commentId);
          progressedInViewport = true;
          const result = { ...nextAction.item, ok: false, status: finalStatus, error: reason };
          localResults.push(result);
          onResult(result);
          console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
          continue;
        }

        apiConfirmed = await submitWatcher.waitForSuccess({ timeoutMs: 2500 });
        if (!apiConfirmed) {
          const verified = await verifyReply(page, {
            commentText: nextAction.target.commentText,
            actorName: nextAction.target.actorName,
          }, nextAction.item.replyText, { timeoutMs: 20000 });
          if (!verified.ok) {
            const reason = verified.message || verified.code || 'send_unverified';
            saveSentUnverified(nextAction.item, reason);
            pendingMap.delete(nextAction.item.commentId);
            progressedInViewport = true;
            const result = { ...nextAction.item, ok: false, status: 'sent_unverified', error: reason };
            localResults.push(result);
            onResult(result);
            console.log(`[comments:execute] sent_unverified commentId=${nextAction.item.commentId} pending=${pendingMap.size}`);
            continue;
          }
        }
      } finally {
        submitWatcher.stop();
      }

      saveSucceeded(nextAction.item);
      pendingMap.delete(nextAction.item.commentId);
      succeededCount++;
      progressedInViewport = true;
      const result = {
        ...nextAction.item,
        ok: true,
        status: 'succeeded',
        mode: 'execute',
        matchedBy: apiConfirmed ? 'submit_api_success' : nextAction.picked.matchedBy,
      };
      localResults.push(result);
      onResult(result);
      console.log(`[comments:execute] replied commentId=${nextAction.item.commentId} matchedBy=${nextAction.picked.matchedBy} pending=${pendingMap.size}`);

      if (pendingMap.size > 0) await waitCooldown(page).catch(() => null);

      break;
    }

    if (pendingMap.size === 0) break;

    if (progressedInViewport) {
      noProgressRounds = 0;
      lastSignature = '';
      continue;
    }

    if (viewportRound === 0) {
      await captureSinglePassDebugSnapshot(page, {
        currentWork,
        viewportRound,
        visibleCandidates,
        pendingItems: [...pendingMap.values()],
        commentListCollector,
      });
    }

    const pendingItems = [...pendingMap.values()];
    const rollbackDecision = shouldStartRollbackByTime(
      pendingItems,
      visibleCandidates,
      lastViewportTimeRange,
      { commentListCollector },
    );
    lastViewportTimeRange = rollbackDecision.currentRange || lastViewportTimeRange;

    const timedOutEntries = findReplySearchTimedOutItems(pendingItems, rollbackDecision.currentRange, { commentListCollector });
    if (timedOutEntries.length > 0) {
      for (const entry of timedOutEntries) {
        if (!pendingMap.has(entry.item.commentId)) continue;
        saveTimedOut(entry.item, entry.reason);
        pendingMap.delete(entry.item.commentId);
        const result = { ...entry.item, ok: false, status: 'skipped', error: entry.reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] timeout commentId=${entry.item.commentId} reason=${entry.reason} pending=${pendingMap.size}`);
      }
      if (pendingMap.size === 0) break;
      noProgressRounds = 0;
      lastSignature = '';
      continue;
    }

    const stats = commentListCollector?.getStats?.() || {};
    if (Number(stats.hasMore) === 0 && viewportRound > 2) {
      break;
    }

    if (signature === lastSignature) {
      noProgressRounds++;
    } else {
      noProgressRounds = 1;
      lastSignature = signature;
    }

    if (days > 0 && visibleCandidates.length > 0 && visibleCandidates.every(c => isTimeBeyondDays(c.timeText, days))) {
      if (noProgressRounds >= 3) break;
      noProgressRounds = Math.max(noProgressRounds, 3);
    }

    if (noProgressRounds > maxNoProgressRounds && Number(stats.hasMore) === 0) {
      break;
    }

    if (scrollRounds >= maxScrollRounds) {
      break;
    }

    const scrollDirection = rollbackDecision.shouldRollback ? 'up' : 'down';
    await quietWorkModalMedia(page, { installGuard: true, reason: 'before_comment_scroll' }).catch(() => null);
    const scrollResult = await scrollOnce(page, { direction: scrollDirection });
    await quietWorkModalMedia(page, { installGuard: true, reason: 'after_comment_scroll' }).catch(() => null);
    if (!scrollResult.ok) {
      break;
    }
    if (scrollDirection === 'up') {
      rollbackRounds++;
      console.log(`[comments:execute] rollback round=${rollbackRounds} pending=${pendingMap.size}`);
      if (scrollResult.atStart && rollbackRounds >= 2) {
        break;
      }
    } else {
      rollbackRounds = 0;
    }

    scrollRounds++;
    viewportRound++;
    console.log(`[comments:execute] scroll round=${viewportRound} direction=${scrollDirection} pending=${pendingMap.size}`);
  }

  for (const leftover of pendingMap.values()) {
    const reason = scrollRounds >= maxScrollRounds
      ? `single_pass_not_found:scroll_limit_${maxScrollRounds}`
      : 'single_pass_not_found';
    const finalStatus = saveRetryable(leftover, reason) || 'pending';
    const result = { ...leftover, ok: false, status: finalStatus, error: reason };
    localResults.push(result);
    onResult(result);
  }

  console.log(`[comments:execute] single-pass done work=${currentWork.workId || currentWork.modalId || currentWork.workUrl} succeeded=${succeededCount} blocked=${blockedCount}`);
  return localResults;
}

function pickedReasonLabel(reason) {
  if (!reason) return 'blocked';
  return reason;
}

function isTimeBeyondDays(timeText, days) {
  if (!timeText || !days) return false;
  const text = String(timeText).trim();
  const dayMatch = text.match(/^(\d+)天前/);
  if (dayMatch) return Number(dayMatch[1]) > days;
  return false;
}

async function executeWorkCommentItems(items, args, run, recorder) {
  const diagnosePosition = Boolean(args.diagnosePosition);
  let browser = null;
  let ctx = null;
  let page = null;
  let groupIndex = -1;
  const results = [];

  function isFatalPageError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('target page, context or browser has been closed')
        || msg.includes('execution context was destroyed');
  }

  async function recreatePage() {
    if (ctx && ctx.context) {
      try {
        page = await replaceContextPage(ctx.context, page);
        recorder?.instrumentPage(page, { label: 'comments.execute.page' });
        console.error('[comments:execute] 已重建页面');
        return true;
      } catch {
        console.error('[comments:execute] 重建页面失败');
      }
    }
    return false;
  }

  async function captureGroupEvidence(err, currentWork) {
    if (!page || page.isClosed()) return;
    try {
      const { evidenceDir } = await captureEvidence(page, {
        outputDir: run.outputDir,
        step: `work-comment-group-${currentWork.commentId || 'unknown'}`,
        code: RESULT_CODES.UNKNOWN_ERROR,
        message: err.message,
        recoverable: true,
      });
      run.evidenceDirectories.push(evidenceDir);
    } catch {}
  }

  async function stopGroupForSecurityVerification(group, phase = 'unknown') {
    const verification = await detectDouyinSecurityVerification(page).catch(() => null);
    if (!verification) return false;
    run.hadBlocked = true;
    console.log(`[comments:execute] 检测到手机号/短信安全认证 phase=${phase}，暂停自动回评并保留当前浏览器窗口`);
    for (const validated of group) {
      results.push({
        ...validated,
        ok: false,
        status: 'blocked',
        code: RESULT_CODES.IDENTITY_NOT_VERIFIED,
        error: 'security_verification_required',
        recoverable: false,
        securityVerification: verification,
      });
    }
    return true;
  }

  try {
    const prepared = items.map(validateWorkCommentItem);
    const executable = prepared.filter(item => item.ok);
    for (const item of prepared) {
      if (!item.ok) results.push(item);
    }
    if (executable.length === 0) {
      return results;
    }

    ctx = await createBrowserContext({ headless: args.headless, enableReuse: Boolean(args.keepOpen) && !args.json });
    browser = ctx.browser;
    page = await replaceContextPage(ctx.context, ctx.context.pages()[0] || null);
    recorder?.instrumentPage(page, { label: 'comments.execute.page' });

    const workGroups = groupExecutableItemsByWork(executable);
    let activeHomepageUrl = '';
    for (const group of workGroups) {
      groupIndex++;
      const currentWork = group[0];
      const targetHomepageUrl = currentWork.authorProfileUrl || currentWork.homepageUrl || '';
      try {
        await recorder?.capture(page, 'comments.work_group.start', {
          groupIndex,
          groupSize: group.length,
          workId: currentWork?.workId || '',
          modalId: currentWork?.modalId || '',
        });
        if (groupIndex > 0) {
          const canReuseCurrentProfile = Boolean(activeHomepageUrl && targetHomepageUrl && activeHomepageUrl === targetHomepageUrl);
          if (canReuseCurrentProfile) {
            console.error(`[comments:execute] 复用当前主页执行作品组 group_index=${groupIndex + 1}/${workGroups.length}`);
          } else {
            page = await replaceContextPage(ctx.context, page);
            recorder?.instrumentPage(page, { label: 'comments.execute.page' });
            activeHomepageUrl = '';
            console.error(`[comments:execute] 切换到新页面执行作品组 group_index=${groupIndex + 1}/${workGroups.length}`);
          }
        }
        if (page.isClosed()) {
          throw new Error('Target page, context or browser has been closed');
        }

        console.log(`[comments:execute] current_homepage_url=${currentWork.homepageUrl || currentWork.authorProfileUrl || ''} current_work_id=${currentWork.workId || ''} current_modal_id=${currentWork.modalId || ''} group_comment_count=${group.length}`);
        const reuseCurrentProfile = Boolean(activeHomepageUrl && targetHomepageUrl && activeHomepageUrl === targetHomepageUrl);
        const commentListCollector = createCommentListApiCollector(page);
        try {
          let openResult = await openProfileWorkByAwemeIdFromPostApi(
            page,
            targetHomepageUrl,
            currentWork.workId || currentWork.modalId,
            { timeoutMs: 30000, reuseCurrentProfile }
          );

          if (!openResult.ok) {
            const fallbackWorkUrl = currentWork.workUrl
              || currentWork.awemeUrl
              || buildDouyinWorkUrl(currentWork.workId || currentWork.modalId);
            if (fallbackWorkUrl) {
              const reason = openResult.reason || openResult.message || openResult.code || 'work_open_failed';
              console.log(`[comments:execute] open_profile_failed reason=${reason}; fallback_open_work_url=${fallbackWorkUrl}`);
              await page.goto(fallbackWorkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForTimeout(1500);
              openResult = { ok: true, url: page.url(), fallback: 'direct_work_url', previousReason: reason };
            }
          }

          if (!openResult.ok) {
            if (await stopGroupForSecurityVerification(group, 'open_profile_failed')) break;
            console.log(`[comments:execute] open_profile_failed reason=${openResult.reason || openResult.message || openResult.code || 'work_open_failed'}`);
            for (const validated of group) {
              const reason = openResult.reason || openResult.message || openResult.code || 'work_open_failed';
              const finalStatus = diagnosePosition ? 'pending' : saveRetryablePending(validated, `work_open_failed:${reason}`);
              results.push({ ...validated, ok: false, status: finalStatus, error: reason });
            }
            continue;
          }
          console.log(`[comments:execute] open_profile_success opened_work_url=${openResult.url || ''}`);
          activeHomepageUrl = openResult.fallback ? '' : targetHomepageUrl;
          if (await stopGroupForSecurityVerification(group, 'after_open_work')) break;
          await quietWorkModalMedia(page, { installGuard: true, reason: 'after_open_work' }).catch(() => null);

          const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
          if (!modalReady.ok) {
            if (await stopGroupForSecurityVerification(group, 'work_modal_not_ready')) break;
            for (const validated of group) {
              const reason = modalReady.message || modalReady.code || 'work_modal_not_ready';
              const finalStatus = diagnosePosition ? 'pending' : saveRetryablePending(validated, `work_modal_not_ready:${reason}`);
              results.push({ ...validated, ok: false, status: finalStatus, error: reason });
            }
            continue;
          }

          const commentAreaReady = await waitForWorkCommentArea(page, { timeoutMs: 10000 });
          if (!commentAreaReady.ok) {
            if (await stopGroupForSecurityVerification(group, 'comment_area_not_ready')) break;
            for (const validated of group) {
              const reason = commentAreaReady.message || commentAreaReady.code || 'comment_area_not_ready';
              const finalStatus = diagnosePosition ? 'pending' : saveRetryablePending(validated, `comment_area_not_ready:${reason}`);
              results.push({ ...validated, ok: false, status: finalStatus, error: reason });
            }
            continue;
          }

          const groupResults = await executeSinglePassForWorkGroup(page, group, commentListCollector, {
            days: args.days,
            maxScrollRounds: args.maxScrollRounds || Number(process.env.LISHANGWANGLAI_COMMENT_MAX_SCROLL_ROUNDS || 0) || undefined,
            ...(diagnosePosition ? {
              openMatchedReplyBox: async (_page, target, candidate, { matchedBy }) => {
                console.log(`[comments:execute:diagnose] matched commentId=${target?.targetCommentId || ''} matchedBy=${matchedBy} actor="${target?.actorName || ''}" comment="${String(target?.commentText || '').slice(0, 60)}" domIndex=${candidate?.domIndex}`);
                return { ok: true, data: { diagnoseOnly: true, target, candidate, matchedBy } };
              },
              fillReply: async () => ({ ok: true, data: { diagnoseOnly: true } }),
              clickSend: async () => ({ ok: true, data: { diagnoseOnly: true } }),
              verifyReply: async () => ({ ok: true, data: { diagnoseOnly: true } }),
              saveSucceeded: () => {},
              saveBlocked: () => {},
              saveRetryable: () => {},
              saveSentUnverified: () => {},
              saveManuallyReplied: () => {},
              saveTimedOut: () => {},
            } : {}),
            onResult(result) {
              results.push(result);
            },
          });
          const hasSecurityVerification = groupResults.some(isSecurityVerificationResult);
          if (hasSecurityVerification) {
            run.hadBlocked = true;
          }
          await recorder?.capture(page, 'comments.work_group.finish', {
            groupIndex,
            groupSize: group.length,
            hadBlocked: hasSecurityVerification,
          });

          // 真实认证只能由发送接口判定。此时停在当前作品并保留浏览器，供用户完成认证。
          if (hasSecurityVerification) break;

          const nextGroup = workGroups[workGroups.indexOf(group) + 1] || null;
          const shouldReturnToProfile = Boolean(nextGroup && (nextGroup[0]?.authorProfileUrl || nextGroup[0]?.homepageUrl) === targetHomepageUrl);
          if (shouldReturnToProfile) {
            const closeResult = await closeCurrentWorkModalToProfile(page, targetHomepageUrl, { timeoutMs: 10000 });
            if (closeResult.ok) {
              activeHomepageUrl = targetHomepageUrl;
              console.log(`[comments:execute] return_to_profile_success method=${closeResult.method} url=${closeResult.url || ''}`);
            } else {
              activeHomepageUrl = '';
              console.log(`[comments:execute] return_to_profile_failed reason=${closeResult.reason || 'close_modal_to_profile_failed'}`);
            }
          }
        } finally {
          commentListCollector.stop();
          await releaseWorkModalMediaQuietGuard(page).catch(() => null);
        }
      } catch (err) {
        run.hadError = true;
        for (const validated of group) {
          const finalStatus = diagnosePosition ? 'pending' : saveRetryablePending(validated, `group_execute_failed:${err.message}`);
          results.push({ ...validated, ok: false, status: finalStatus, error: err.message });
        }
        await captureGroupEvidence(err, currentWork);

        if (isFatalPageError(err)) {
          console.error(`[comments:execute] 检测到页面致命错误，重建页面: ${err.message}`);
          const recreated = await recreatePage();
          if (!recreated) {
            console.error('[comments:execute] 页面重建失败，停止执行');
            break;
          }
        }
      }
    }
  } finally {
    if (page && !page.isClosed?.()) {
      await releaseWorkModalMediaQuietGuard(page).catch(() => null);
    }
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) await browser.close();
    else if (browser && typeof browser.disconnect === 'function') await browser.disconnect();
  }

  return results;
}

function isSkippedResult(result) {
  return result.status === 'skipped_empty_reply'
    || result.status === 'skipped'
    || result.status === 'manually_replied'
    || (!result.ok && result.status === 'succeeded')
    || (!result.ok && result.status === 'sent_unverified');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = createRunContext('comments:execute', {
    debug: args.debug,
    dryRun: false,
    execute: !args.diagnosePosition,
    json: args.json,
    keepOpen: Boolean(args.keepOpen) && !args.json,
    keepOpenOnError: !args.json && !args.diagnosePosition,
    pauseOnError: !args.json && !args.diagnosePosition,
    writeRunFiles: args.debug,
    headless: args.headless,
    maxItems: args.limit || 0,
  });
  const recorder = createRunDebugRecorder(run, { command: 'comments:execute' });
  recorder.startConsoleCapture();

  try {
    if (args.unsupportedItemsFile) {
      printJsonError(
        'comments:execute',
        RESULT_CODES.INVALID_ARGUMENTS,
        'comments:execute 不再支持 --items-file；请直接从数据库执行，--limit 可选，不传默认处理全部 pending',
        { recoverable: false }
      );
      return;
    }

    let loaded = { items: [] };
    let agentResults = [];

    runMigrations();
    const rows = listPendingCommentsGroupedByHomepageAndWork({
      limit: args.limit,
      hours: args.hours,
      includeBlocked: true,
    });
    loaded = { items: buildWorkCommentItemsFromDbRows(rows) };
    run.scanned = loaded.items.length;
    console.log(`[comments:execute] loaded pending comments from db: ${loaded.items.length}`);

    const agentProvider = createAgentProvider();
    try {
      agentResults = await generateMissingReplies(loaded.items, {
        agentProvider,
        batchSize: Number(process.env.REPLY_BATCH_SIZE || 8),
      });
    } finally {
      await agentProvider.close?.();
    }

    if (args.agentOnly) {
      const generated = agentResults.filter(r => r.ok && r.reply).length;
      const failedAgent = agentResults.filter(r => !r.ok).length;
      run.processed = loaded.items.length;
      run.succeeded = generated;
      run.failed = failedAgent;
      if (args.json) {
        printJsonResult('comments:execute', { agentResults }, { generated, failed: failedAgent, mode: 'agent_only' });
      } else {
        console.log(`[comments:execute] agent-only generated=${generated} failed=${failedAgent}`);
      }
      return;
    }

    const results = await executeWorkCommentItems(loaded.items, args, run, recorder);
    console.log(args.diagnosePosition
      ? `[comments:execute] diagnose-position 模式：不更新 DB，未发送回复`
      : `[comments:execute] DB 模式：不生成/读取/写回中间 JSON`);

    const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
    const skipped = results.filter(isSkippedResult).length;
    const failed = results.length - succeeded - skipped;
    run.processed = results.length;
    run.succeeded = succeeded;
    run.failed = failed;
    run.skipped = skipped;

    const skipReasons = {};
    results.filter(isSkippedResult).forEach(r => {
      const reason = r.status === 'skipped_empty_reply' ? 'empty' : (r.error || r.status);
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    });
    const skippedLog = skipped > 0 ? `，跳过 ${skipped} 条（${Object.entries(skipReasons).map(([k, v]) => `${k}×${v}`).join(', ')}）` : '';

    if (args.json) {
      printJsonResult('comments:execute', { agentResults, results }, { succeeded, failed, skipped, mode: args.diagnosePosition ? 'diagnose_position' : 'db_agent_execute' });
    } else {
      console.log(`[comments:execute] mode=${args.diagnosePosition ? 'diagnose_position' : 'db_agent_execute'} 成功 ${succeeded} 条，失败 ${failed} 条${skippedLog}`);
      for (const item of results) {
        const tag = item.status === 'skipped_empty_reply' ? ' [empty-reply]'
          : item.status === 'skipped' ? ' [skipped]'
          : item.status === 'manually_replied' ? ' [manually-replied]'
          : (!item.ok && item.status === 'succeeded') ? ' [already-done]'
          : (!item.ok && item.status === 'sent_unverified') ? ' [already-sent]'
          : '';
        const lineStatus = item.ok ? item.status : (item.status === 'skipped' ? `skipped ${item.error}` : `failed ${item.error}`);
        console.log(`  [comment#${item.commentId || '-'}] ${lineStatus}${tag}`);
      }
    }
  } finally {
    saveRunSummary(run);
    recorder.stopConsoleCapture();
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    printJsonError('comments:execute', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    process.exit(1);
  });
}
