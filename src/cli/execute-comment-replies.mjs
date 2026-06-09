// 评论回复执行命令
// 默认从数据库查询 pending 回评，直接调用 Hermes/OpenClaw 生成 reply_text 后执行回复。
//
// 用法：
//   npm run comments:execute -- --days 7 --limit 50
//   npm run comments:execute -- --days 7 --limit 50 --agent-only
//
// 输入要求：
//   命令只从数据库查询待回评评论，并自动生成缺失的 reply_text。
//   已经 succeeded/sent_unverified 的评论会跳过重复执行。
//   命令默认真实执行回复，不再需要 --execute。

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, saveReplyText, markCommentReplied, markCommentBlocked, markCommentPending, markCommentSentUnverified, markCommentSkipped, findCommentByWorkActorAndText, listPendingCommentsGroupedByHomepageAndWork } from '../db/work-comment-repository.mjs';
import { findWorkByIdentity } from '../db/work-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
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
  pickWorkCommentCandidate,
  scrollCommentAreaOnce,
  waitForWorkCommentArea,
  waitForWorkModal,
  verifyWorkReplyVisible,
} from '../adapters/work-modal-page.mjs';
import { createCommentListApiCollector } from '../adapters/comment-list-api-listener.mjs';
import { closeCurrentWorkModalToProfile, openProfileWorkByAwemeIdFromPostApi } from '../services/return-visit-work-collector.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { LocalAgentProvider } from '../agent/local-agent-provider.mjs';
import { normalizeNoticeApiItem } from '../domain/notice-api-normalization.mjs';
import { countVisibleChars, getReplyMinLength, hasAgentDisclosure, hasForbiddenReplyPersona, hasReplyAgentPersona } from '../agent/comment-agent-server.mjs';

export function parseArgs(argv) {
  const args = {
    unsupportedItemsFile: false,
    json: false,
    diagnosePosition: false,
    keepOpen: false,
    limit: null,
    days: null,
    agentOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items-file') {
      args.unsupportedItemsFile = true;
      if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) i++;
    }
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--diagnose-position') args.diagnosePosition = true;
    if (argv[i] === '--keep-open') args.keepOpen = true;
    if ((argv[i] === '--limit' || argv[i] === '--max-count') && argv[i + 1]) args.limit = Number(argv[++i] || 0) || null;
    if (argv[i] === '--days' && argv[i + 1]) args.days = Number(argv[++i] || 0) || null;
    if (argv[i] === '--agent-only') args.agentOnly = true;
  }

  return args;
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
    author_name: row.joined_author_name || '',
    actorName: row.actor_name || '',
    actorProfileUrl: row.actor_profile_url || '',
    actorProfileKey: row.actor_profile_key || '',
    commentText: row.comment_text || '',
    eventTimeText: row.event_time_text || '',
    targetCommentId: extractTargetCommentId({}, row),
    raw_comment_json: row.raw_comment_json || '',
  }));
}

export function buildReplyContext(item = {}) {
  const maxLength = Number(process.env.COMMENT_MAX_LENGTH || 30);
  const minLength = Number(process.env.REPLY_MIN_LENGTH || process.env.COMMENT_MIN_LENGTH || getReplyMinLength());
  return {
    taskId: `work_comment_${item.commentId}`,
    work: {
      workId: item.workId || item.modalId || '',
      title: item.work_title || item.workTitle || '',
      desc: item.work_desc || item.workText || '',
      authorNickname: item.author_name || '',
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
      requireAgentDisclosure: true,
      tone: '自然、简短、像真人',
    },
  };
}

export function isReplyTextInvalid(replyText, { minLength = getReplyMinLength(), requireAgentDisclosure = true } = {}) {
  const text = String(replyText || '').trim();
  if (!text) return false;
  if (countVisibleChars(text) < minLength) return true;
  if (requireAgentDisclosure && !hasAgentDisclosure(text)) return true;
  if (requireAgentDisclosure && !hasReplyAgentPersona(text)) return true;
  if (requireAgentDisclosure && hasForbiddenReplyPersona(text)) return true;
  return false;
}

export const isReplyTextTooShort = isReplyTextInvalid;

export async function generateMissingReplies(items = [], { agentProvider = new LocalAgentProvider() } = {}) {
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
      markCommentPending(decision.commentId, `agent_generate_failed:${message}`);
      decision.result = { commentId: decision.commentId, ok: false, error: message };
    }
    return decisions.map(decision => decision.result);
  }

  try {
    console.error(`[agent] batch 请求生成回复 count=${pendingContexts.length}`);
    const replies = await agentProvider.generateReplies(pendingContexts);
    if (!Array.isArray(replies)) throw new Error('Agent 返回格式错误: replies 必须是数组');
    if (replies.length !== pendingContexts.length) {
      throw new Error(`Agent 返回回复数量不匹配: ${replies.length}/${pendingContexts.length}`);
    }

    const expectedTaskIds = new Set(pendingContexts.map(context => String(context.taskId || '').trim()));
    const byTaskId = new Map();
    for (const item of replies) {
      const taskId = String(item?.taskId || '').trim();
      const reply = String(item?.reply || '').trim();
      if (!expectedTaskIds.has(taskId)) throw new Error(`Agent 返回未知 taskId: ${taskId || '(empty)'}`);
      if (byTaskId.has(taskId)) throw new Error(`Agent 返回重复 taskId: ${taskId}`);
      if (taskId) byTaskId.set(taskId, reply);
    }

    for (const context of pendingContexts) {
      const taskId = String(context.taskId || '').trim();
      if (!byTaskId.has(taskId)) throw new Error(`Agent 缺少回复 taskId: ${taskId}`);
      const reply = byTaskId.get(taskId);
      if (!reply || isReplyTextInvalid(reply, context.requirements)) {
        throw new Error(`Agent 返回回复不符合发送要求 taskId=${taskId}`);
      }
    }

    for (const decision of decisions.filter(item => item.type === 'generate')) {
      const reply = byTaskId.get(decision.taskId);
      saveReplyText(decision.commentId, reply);
      decision.item.replyText = reply;
      console.error(`[agent] commentId=${decision.commentId} 回复生成成功 reply=${reply}`);
      decision.result = { commentId: decision.commentId, ok: true, reply };
    }
  } catch (err) {
    const message = err?.message || String(err);
    for (const decision of decisions.filter(item => item.type === 'generate')) {
      markCommentPending(decision.commentId, `agent_generate_failed:${message}`);
      console.error(`[agent] commentId=${decision.commentId} failed reason=${message}`);
      decision.result = { commentId: decision.commentId, ok: false, error: message };
    }
  }

  return decisions.map(decision => decision.result);
}

function saveRetryablePending(item, reason) {
  markCommentPending(item.commentId, reason);
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
    const minLength = Number(process.env.REPLY_MIN_LENGTH || process.env.COMMENT_MIN_LENGTH || getReplyMinLength());
    const reason = countVisibleChars(replyText) < minLength
      ? `reply_text_too_short:${countVisibleChars(replyText)}/${minLength}`
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
    const availableCandidates = (visibleCandidates || []).filter(candidate => !usedDomIndexes.has(candidate.domIndex));
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
  maxViewportRounds = 20,
  maxNoProgressRounds = 3,
  collectCandidates = collectVisibleWorkCommentCandidates,
  expandReplies = expandVisibleWorkCommentReplies,
  openMatchedReplyBox = openReplyBoxForMatchedWorkComment,
  fillReply = fillWorkReplyText,
  clickSend = clickSendWorkReply,
  verifyReply = verifyWorkReplyVisible,
  scrollOnce = scrollCommentAreaOnce,
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

  console.log(`[comments:execute] single-pass start work=${currentWork.workId || currentWork.modalId || currentWork.workUrl} pending=${pendingMap.size}`);

  while (pendingMap.size > 0 && viewportRound <= maxViewportRounds) {
    await expandReplies(page, { maxClicks: 6 }).catch(() => null);
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
          saveBlocked(blockedEntry.item, reason);
          pendingMap.delete(blockedEntry.item.commentId);
          blockedCount++;
          progressedInViewport = true;
          const result = { ...blockedEntry.item, ok: false, status: 'blocked', error: reason };
          localResults.push(result);
          onResult(result);
          console.log(`[comments:execute] blocked commentId=${blockedEntry.item.commentId} reason=${pickedReasonLabel(blockedEntry.picked.reason)} pending=${pendingMap.size}`);
        }
        continue;
      }

      const nextAction = plan.actionable[0];
      if (!nextAction) break;

      const opened = await openMatchedReplyBox(page, nextAction.target, nextAction.picked.candidate, {
        matchedBy: nextAction.picked.matchedBy,
      });
      if (!opened.ok) {
        const reason = opened.message || opened.code || 'reply_box_not_opened';
        saveRetryable(nextAction.item, `reply_box_not_opened:${reason}`);
        pendingMap.delete(nextAction.item.commentId);
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'pending', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const filled = await fillReply(page, nextAction.item.replyText);
      if (!filled.ok) {
        const reason = filled.message || filled.code || 'fill_failed';
        saveRetryable(nextAction.item, `fill_failed:${reason}`);
        pendingMap.delete(nextAction.item.commentId);
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'pending', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const sent = await clickSend(page);
      if (!sent.ok) {
        const reason = sent.message || sent.code || 'send_failed';
        saveRetryable(nextAction.item, `send_failed:${reason}`);
        pendingMap.delete(nextAction.item.commentId);
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'pending', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] pending_retry commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

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

      saveSucceeded(nextAction.item);
      pendingMap.delete(nextAction.item.commentId);
      succeededCount++;
      progressedInViewport = true;
      const result = {
        ...nextAction.item,
        ok: true,
        status: 'succeeded',
        mode: 'execute',
        matchedBy: nextAction.picked.matchedBy,
      };
      localResults.push(result);
      onResult(result);
      console.log(`[comments:execute] replied commentId=${nextAction.item.commentId} matchedBy=${nextAction.picked.matchedBy} pending=${pendingMap.size}`);

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

    if (noProgressRounds > maxNoProgressRounds || viewportRound === maxViewportRounds) {
      break;
    }

    const scrollResult = await scrollOnce(page);
    if (!scrollResult.ok) {
      break;
    }

    viewportRound++;
    console.log(`[comments:execute] scroll round=${viewportRound} pending=${pendingMap.size}`);
  }

  for (const leftover of pendingMap.values()) {
    const reason = 'single_pass_not_found';
    saveRetryable(leftover, reason);
    const result = { ...leftover, ok: false, status: 'pending', error: reason };
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

async function executeWorkCommentItems(items, args) {
  const diagnosePosition = Boolean(args.diagnosePosition);
  const run = createRunContext('comment-execute-json', {
    debug: true,
    dryRun: false,
    execute: !diagnosePosition,
    json: args.json,
    keepOpen: Boolean(args.keepOpen) && !args.json,
    keepOpenOnError: !args.json && !diagnosePosition,
    pauseOnError: !args.json && !diagnosePosition,
    writeRunFiles: false,
  });

  let browser = null;
  let ctx = null;
  let page = null;
  const results = [];

  function isFatalPageError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('target page, context or browser has been closed')
        || msg.includes('execution context was destroyed');
  }

  async function recreatePage() {
    if (page && !page.isClosed()) {
      try { await page.close().catch(() => {}); } catch {}
    }
    if (ctx && ctx.context) {
      try {
        page = await ctx.context.newPage();
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

  try {
    const prepared = items.map(validateWorkCommentItem);
    const executable = prepared.filter(item => item.ok);
    for (const item of prepared) {
      if (!item.ok) results.push(item);
    }
    if (executable.length === 0) {
      return results;
    }

    ctx = await createBrowserContext({ headless: false, enableReuse: Boolean(args.keepOpen) && !args.json });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    const workGroups = groupExecutableItemsByWork(executable);
    let activeHomepageUrl = '';
    for (const group of workGroups) {
      const currentWork = group[0];
      try {
        if (page.isClosed()) {
          throw new Error('Target page, context or browser has been closed');
        }

        console.log(`[comments:execute] current_homepage_url=${currentWork.homepageUrl || currentWork.authorProfileUrl || ''} current_work_id=${currentWork.workId || ''} current_modal_id=${currentWork.modalId || ''} group_comment_count=${group.length}`);
        const targetHomepageUrl = currentWork.authorProfileUrl || currentWork.homepageUrl || '';
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
            console.log(`[comments:execute] open_profile_failed reason=${openResult.reason || openResult.message || openResult.code || 'work_open_failed'}`);
            for (const validated of group) {
              const reason = openResult.reason || openResult.message || openResult.code || 'work_open_failed';
              if (!diagnosePosition) markCommentPending(validated.commentId, `work_open_failed:${reason}`);
              results.push({ ...validated, ok: false, status: 'pending', error: reason });
            }
            continue;
          }
          console.log(`[comments:execute] open_profile_success opened_work_url=${openResult.url || ''}`);
          activeHomepageUrl = openResult.fallback ? '' : targetHomepageUrl;

          const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
          if (!modalReady.ok) {
            for (const validated of group) {
              const reason = modalReady.message || modalReady.code || 'work_modal_not_ready';
              if (!diagnosePosition) markCommentPending(validated.commentId, `work_modal_not_ready:${reason}`);
              results.push({ ...validated, ok: false, status: 'pending', error: reason });
            }
            continue;
          }

          const commentAreaReady = await waitForWorkCommentArea(page, { timeoutMs: 10000 });
          if (!commentAreaReady.ok) {
            for (const validated of group) {
              const reason = commentAreaReady.message || commentAreaReady.code || 'comment_area_not_ready';
              if (!diagnosePosition) markCommentPending(validated.commentId, `comment_area_not_ready:${reason}`);
              results.push({ ...validated, ok: false, status: 'pending', error: reason });
            }
            continue;
          }

          const groupResults = await executeSinglePassForWorkGroup(page, group, commentListCollector, {
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
            } : {}),
            onResult(result) {
              results.push(result);
            },
          });
          if (groupResults.some(result => !result.ok && result.status === 'blocked')) {
            run.hadBlocked = true;
          }

          const nextGroup = workGroups[workGroups.indexOf(group) + 1] || null;
          const shouldReturnToProfile = Boolean(nextGroup && (nextGroup[0]?.authorProfileUrl || nextGroup[0]?.homepageUrl) === targetHomepageUrl);
          if (shouldReturnToProfile) {
            const closeResult = await closeCurrentWorkModalToProfile(page, targetHomepageUrl, { timeoutMs: 10000 });
            if (closeResult.ok) {
              console.log(`[comments:execute] return_to_profile_success method=${closeResult.method} url=${closeResult.url || ''}`);
            } else {
              console.log(`[comments:execute] return_to_profile_failed reason=${closeResult.reason || 'close_modal_to_profile_failed'}`);
            }
          }
        } finally {
          commentListCollector.stop();
        }
      } catch (err) {
        run.hadBlocked = true;
        for (const validated of group) {
          if (!diagnosePosition) markCommentPending(validated.commentId, `group_execute_failed:${err.message}`);
          results.push({ ...validated, ok: false, status: 'pending', error: err.message });
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
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) await browser.close();
    else if (browser && typeof browser.disconnect === 'function') await browser.disconnect();
  }

  return results;
}

function isSkippedResult(result) {
  return result.status === 'skipped_empty_reply'
    || result.status === 'skipped'
    || (!result.ok && result.status === 'succeeded')
    || (!result.ok && result.status === 'sent_unverified');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.unsupportedItemsFile) {
    printJsonError(
      'comments:execute',
      RESULT_CODES.INVALID_ARGUMENTS,
      'comments:execute 不再支持 --items-file；请使用 --days N --limit M 从数据库查询并执行',
      { recoverable: false }
    );
    return;
  }

  let loaded = { items: [] };
  let agentResults = [];

  if (!Number(args.days || 0) || !Number(args.limit || 0)) {
    printJsonError(
      'comments:execute',
      RESULT_CODES.INVALID_ARGUMENTS,
      'comments:execute 必须手动输入采集天数和最大条数限制，例如：comments:execute --days 7 --limit 50',
      { recoverable: false }
    );
    return;
  }

  runMigrations();
  const rows = listPendingCommentsGroupedByHomepageAndWork({ limit: args.limit, days: args.days });
  loaded = { items: buildWorkCommentItemsFromDbRows(rows) };
  console.log(`[comments:execute] loaded pending comments from db: ${loaded.items.length}`);

  agentResults = await generateMissingReplies(loaded.items);

  if (args.agentOnly) {
    const generated = agentResults.filter(r => r.ok && r.reply).length;
    const failedAgent = agentResults.filter(r => !r.ok).length;
    if (args.json) {
      printJsonResult('comments:execute', { agentResults }, { generated, failed: failedAgent, mode: 'agent_only' });
    } else {
      console.log(`[comments:execute] agent-only generated=${generated} failed=${failedAgent}`);
    }
    return;
  }

  const results = await executeWorkCommentItems(loaded.items, args);
  console.log(args.diagnosePosition
    ? `[comments:execute] diagnose-position 模式：不更新 DB，未发送回复`
    : `[comments:execute] DB 模式：不生成/读取/写回中间 JSON`);

  const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
  const skipped = results.filter(isSkippedResult).length;
  const failed = results.length - succeeded - skipped;

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
        : (!item.ok && item.status === 'succeeded') ? ' [already-done]'
        : (!item.ok && item.status === 'sent_unverified') ? ' [already-sent]'
        : '';
      const lineStatus = item.ok ? item.status : (item.status === 'skipped' ? `skipped ${item.error}` : `failed ${item.error}`);
      console.log(`  [comment#${item.commentId || '-'}] ${lineStatus}${tag}`);
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    printJsonError('comments:execute', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    process.exit(1);
  });
}
