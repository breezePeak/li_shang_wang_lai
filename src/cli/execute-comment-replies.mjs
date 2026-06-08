// 评论回复执行命令
// 只支持 interactions:scan 生成的按作品分组 JSON。
//
// 用法：
//   npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
//
// 输入要求：
//   JSON 中每条 comments[] 的 reply_text 由 Agent 根据评论内容、作品上下文和安全规则生成并填写。
//   reply_text 为空的评论会跳过。已经 succeeded/sent_unverified 的评论会跳过重复执行。
//   命令默认真实执行回复，不再需要 --execute。

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, saveReplyText, markCommentReplied, markCommentBlocked, markCommentSentUnverified, findCommentByWorkActorAndText } from '../db/work-comment-repository.mjs';
import { findWorkByIdentity } from '../db/work-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import {
  buildWorkReplyTarget,
  WORK_COMMENT_CONTAINER_SELECTORS,
  WORK_COMMENT_ITEM_SELECTORS,
  clickSendWorkReply,
  collectVisibleWorkCommentCandidates,
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
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

function parseArgs(argv) {
  const args = {
    itemsFile: '',
    json: false,
    diagnosePosition: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items-file' && argv[i + 1]) args.itemsFile = argv[++i];
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--diagnose-position') args.diagnosePosition = true;
  }

  return args;
}

export function loadWorkCommentItemsFromFile(itemsFile) {
  const raw = readFileSync(resolve(itemsFile), 'utf8');
  const parsed = JSON.parse(raw);
  const items = [];

  if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && item.homepage_url && Array.isArray(item.works))) {
    for (const user of parsed) {
      for (const work of user.works) {
        const comments = Array.isArray(work.comments) ? work.comments : [];
        for (const comment of comments) {
          items.push({
            work_url: work.work_url,
            aweme_url: work.aweme_url,
            work_title: work.work_title,
            work_type: work.work_type,
            thumbnail_key: work.thumbnail_key,
            thumbnail_src: work.thumbnail_src,
            published_at: work.published_at,
            ...comment,
            homepage_url: user.homepage_url,
            homepageUrl: user.homepage_url,
            authorProfileUrl: user.homepage_url,
            authorProfileKey: user.id || work.author_profile_key || '',
            workId: work.work_id ?? comment.work_id ?? '',
            modalId: work.modal_id ?? comment.modal_id ?? '',
            workKey: work.work_key ?? work.workKey ?? work.workId ?? work.modalId ?? '',
          });
        }
      }
    }
  } else if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && Array.isArray(item.comments))) {
    for (const work of parsed) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) {
        items.push({
          work_url: work.work_url,
          aweme_url: work.aweme_url,
          work_title: work.work_title,
          work_type: work.work_type,
          thumbnail_key: work.thumbnail_key,
          thumbnail_src: work.thumbnail_src,
          published_at: work.published_at,
          ...comment,
          workKey: work.workKey || work.work_key || '',
        });
      }
    }
  } else
  if (Array.isArray(parsed?.works)) {
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) {
        items.push({
          work_url: work.work_url,
          aweme_url: work.aweme_url,
          work_title: work.work_title,
          work_type: work.work_type,
          thumbnail_key: work.thumbnail_key,
          thumbnail_src: work.thumbnail_src,
          published_at: work.published_at,
          ...comment,
          workKey: work.workKey || work.work_key || '',
        });
      }
    }
  } else if (Array.isArray(parsed?.comments)) {
    items.push(...parsed.comments);
  } else if (Array.isArray(parsed)) {
    items.push(...parsed);
  } else {
    throw new Error('--items-file 必须是 interactions:scan 生成的作品数组、works[].comments[]、comments 数组或评论数组');
  }

  function findWorkMetaByIndex(itemIndex) {
    let currentIndex = -1;
    let foundMeta = null;
    visitJsonComments(parsed, (_comment, work) => {
      currentIndex++;
      if (currentIndex !== itemIndex) return;
      foundMeta = work || null;
    });
    return foundMeta;
  }

  return {
    parsed,
    items: items.map((item, index) => ({
      ...item,
      itemIndex: index,
      commentId: Number(item.id ?? item.commentId ?? item.comment_id ?? item.workCommentId ?? item.work_comment_id),
      replyText: String(item.replyText ?? item.reply_text ?? ''),
      homepageUrl: item.homepageUrl ?? item.homepage_url ?? item.authorProfileUrl ?? item.author_profile_url ?? '',
      homepage_url: item.homepage_url ?? item.homepageUrl ?? item.authorProfileUrl ?? item.author_profile_url ?? '',
      authorProfileUrl: item.authorProfileUrl ?? item.author_profile_url ?? item.homepageUrl ?? item.homepage_url ?? '',
      authorProfileKey: item.authorProfileKey ?? item.author_profile_key ?? '',
      workUrl: item.workUrl ?? item.work_url ?? '',
      awemeUrl: item.awemeUrl ?? item.aweme_url ?? '',
      workId: item.workId ?? item.work_id ?? '',
      modalId: item.modalId ?? item.modal_id ?? '',
      workKey: item.workKey ?? item.work_key ?? item.workId ?? item.work_id ?? item.modalId ?? item.modal_id ?? '',
      actorName: item.actorName ?? item.actor_name ?? '',
      actorProfileUrl: item.actorProfileUrl ?? item.actor_profile_url ?? '',
      commentText: item.commentText ?? item.comment_text ?? '',
      eventTimeText: item.eventTimeText ?? item.event_time_text ?? '',
      targetCommentId: String(item.targetCommentId ?? item.commentTargetId ?? item.commentCid ?? item.cid ?? item.comment_id ?? '').trim(),
      workMeta: findWorkMetaByIndex(index),
    })),
  };
}

function visitJsonComments(parsed, visitor) {
  if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && item.homepage_url && Array.isArray(item.works))) {
    for (const user of parsed) {
      for (const work of user.works) {
        const comments = Array.isArray(work.comments) ? work.comments : [];
        for (const comment of comments) visitor(comment, work, user);
      }
    }
    return;
  }
  if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && Array.isArray(item.comments))) {
    for (const work of parsed) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) visitor(comment, work, null);
    }
    return;
  }
  if (Array.isArray(parsed?.works)) {
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) visitor(comment, work, parsed);
    }
    return;
  }
  if (Array.isArray(parsed?.comments)) {
    for (const comment of parsed.comments) visitor(comment, parsed, null);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const comment of parsed) visitor(comment, null, null);
  }
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

export function isDoneWithoutRetryResult(result) {
  return Boolean(result?.ok)
    || (!result?.ok && result?.status === 'succeeded')
    || (!result?.ok && result?.status === 'sent_unverified');
}

export function updateExecuteJsonFile(itemsFile, parsed, results) {
  if (!itemsFile || !parsed) return;
  const byItemIndex = new Map();
  const byInputId = new Map();
  const byCommentId = new Map();
  for (const result of results) {
    if (Number.isInteger(result?.itemIndex)) byItemIndex.set(result.itemIndex, result);
    if (result?.inputCommentId) byInputId.set(Number(result.inputCommentId), result);
    if (result?.commentId) byCommentId.set(Number(result.commentId), result);
  }
  if (byItemIndex.size === 0 && byInputId.size === 0 && byCommentId.size === 0) return;

  let currentIndex = -1;
  visitJsonComments(parsed, (comment) => {
    currentIndex++;
    const id = Number(comment.id ?? comment.commentId ?? comment.comment_id ?? comment.workCommentId ?? comment.work_comment_id);
    const result = byItemIndex.get(currentIndex)
      || byInputId.get(id)
      || byCommentId.get(id);
    if (!result) return;

    // 本轮真实执行成功
    if (result.ok && result.status === 'succeeded') {
      comment.reply_status = 'succeeded';
      comment.execute_status_code = 'EXECUTE_CONFIRMED';
      comment.execute_error = '';
    // 之前已成功，本轮跳过重复执行
    } else if (!result.ok && result.status === 'succeeded') {
      comment.reply_status = 'succeeded';
      comment.execute_status_code = 'EXECUTE_ALREADY_CONFIRMED';
      comment.execute_error = '已回复，跳过重复执行';
    // 本轮发送未确认
    } else if (result.status === 'sent_unverified' && !result.fromAlready) {
      comment.reply_status = 'sent_unverified';
      comment.execute_status_code = 'EXECUTE_SENT_UNVERIFIED';
      comment.execute_error = result.error || '';
    // 之前已 sent_unverified，本轮跳过重复执行
    } else if (result.status === 'sent_unverified' && result.fromAlready) {
      comment.reply_status = 'sent_unverified';
      comment.execute_status_code = 'EXECUTE_ALREADY_SENT_UNVERIFIED';
      comment.execute_error = '已发送但未确认，跳过重复执行';
    } else if (result.status === 'blocked') {
      comment.reply_status = 'blocked';
      comment.execute_status_code = 'EXECUTE_BLOCKED';
      comment.execute_error = result.error || '';
    } else if (result.status === 'skipped_empty_reply') {
      comment.execute_status_code = 'EXECUTE_SKIPPED_EMPTY';
      comment.execute_error = 'reply_text 为空，跳过执行';
    } else {
      comment.execute_status_code = result.ok ? 'EXECUTE_VALIDATED' : 'EXECUTE_FAILED';
      comment.execute_error = result.ok ? '' : (result.error || 'execute_failed');
    }
  });

  const allDoneWithoutRetry = results.length > 0 && results.every(isDoneWithoutRetryResult);
  parsed.workflow_status_code = allDoneWithoutRetry ? 'EXECUTE_JSON_DONE' : 'EXECUTE_JSON_PARTIAL';
  parsed.status_codes = {
    ...(parsed.status_codes || {}),
    execute: parsed.workflow_status_code,
  };
  writeFileSync(resolve(itemsFile), JSON.stringify(parsed, null, 2), 'utf8');
}

export function validateWorkCommentItem(item) {
  const inputCommentId = Number(item.commentId);
  if (!item.commentId) {
    return { itemIndex: item.itemIndex, inputCommentId, ok: false, error: '缺少 work_comments.id；请使用 interactions:scan 生成的 JSON' };
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

  if (row.reply_status === 'succeeded') {
    console.error(`[comments:execute] commentId=${item.commentId} 已回复成功，跳过重复执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'succeeded' };
  }
  if (row.reply_status === 'sent_unverified') {
    console.error(`[comments:execute] commentId=${item.commentId} 已发送但未确认，跳过重复执行`);
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, status: 'sent_unverified', fromAlready: true };
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
  const authorProfileKey = item.authorProfileKey
    || item.author_profile_key
    || knownWork?.author_profile_key
    || '';

  if (!homepageUrl) {
    return { itemIndex: item.itemIndex, inputCommentId, commentId: row.id, rowId: row.id, ok: false, error: 'homepage_url 为空，无法通过主页定位作品' };
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
        saveBlocked(nextAction.item, reason);
        pendingMap.delete(nextAction.item.commentId);
        blockedCount++;
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'blocked', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] blocked commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const filled = await fillReply(page, nextAction.item.replyText);
      if (!filled.ok) {
        const reason = filled.message || filled.code || 'fill_failed';
        saveBlocked(nextAction.item, reason);
        pendingMap.delete(nextAction.item.commentId);
        blockedCount++;
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'blocked', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] blocked commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const sent = await clickSend(page);
      if (!sent.ok) {
        const reason = sent.message || sent.code || 'send_failed';
        saveBlocked(nextAction.item, reason);
        pendingMap.delete(nextAction.item.commentId);
        blockedCount++;
        progressedInViewport = true;
        const result = { ...nextAction.item, ok: false, status: 'blocked', error: reason };
        localResults.push(result);
        onResult(result);
        console.log(`[comments:execute] blocked commentId=${nextAction.item.commentId} reason=${reason} pending=${pendingMap.size}`);
        continue;
      }

      const verified = await verifyReply(page, {
        commentText: nextAction.target.commentText,
        actorName: nextAction.target.actorName,
      }, nextAction.item.replyText, { timeoutMs: 12000 });
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
    if (Number(stats.hasMore) === 0) {
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
    saveBlocked(leftover, reason);
    blockedCount++;
    const result = { ...leftover, ok: false, status: 'blocked', error: reason };
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
    keepOpen: false,
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

    ctx = await createBrowserContext({ headless: false, enableReuse: false });
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
          const openResult = await openProfileWorkByAwemeIdFromPostApi(
            page,
            targetHomepageUrl,
            currentWork.workId || currentWork.modalId,
            { timeoutMs: 30000, reuseCurrentProfile }
          );
          if (!openResult.ok) {
            console.log(`[comments:execute] open_profile_failed reason=${openResult.reason || openResult.message || openResult.code || 'work_open_failed'}`);
            for (const validated of group) {
              if (!diagnosePosition) markCommentBlocked(validated.commentId, openResult.reason || openResult.message || openResult.code || 'work_open_failed');
              results.push({ ...validated, ok: false, status: 'blocked', error: openResult.reason || openResult.message || openResult.code });
            }
            continue;
          }
          console.log(`[comments:execute] open_profile_success opened_work_url=${openResult.url || ''}`);
          activeHomepageUrl = targetHomepageUrl;

          const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
          if (!modalReady.ok) {
            for (const validated of group) {
              if (!diagnosePosition) markCommentBlocked(validated.commentId, modalReady.message || modalReady.code || 'work_modal_not_ready');
              results.push({ ...validated, ok: false, status: 'blocked', error: modalReady.message || modalReady.code });
            }
            continue;
          }

          const commentAreaReady = await waitForWorkCommentArea(page, { timeoutMs: 10000 });
          if (!commentAreaReady.ok) {
            for (const validated of group) {
              if (!diagnosePosition) markCommentBlocked(validated.commentId, commentAreaReady.message || commentAreaReady.code || 'comment_area_not_ready');
              results.push({ ...validated, ok: false, status: 'blocked', error: commentAreaReady.message || commentAreaReady.code });
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
          if (!diagnosePosition) markCommentBlocked(validated.commentId, err.message);
          results.push({ ...validated, ok: false, status: 'blocked', error: err.message });
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
  }

  return results;
}

function isSkippedResult(result) {
  return result.status === 'skipped_empty_reply'
    || (!result.ok && result.status === 'succeeded')
    || (!result.ok && result.status === 'sent_unverified');
}

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  if (!args.itemsFile) {
    printJsonError(
      'comments:execute',
      RESULT_CODES.INVALID_ARGUMENTS,
      'comments:execute 只支持 --items-file <第一步JSON>',
      { recoverable: false }
    );
    return;
  }

  let loaded = { parsed: null, items: [] };
  try {
    loaded = loadWorkCommentItemsFromFile(args.itemsFile);
  } catch (err) {
    printJsonError('comments:execute', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
    return;
  }

  const results = await executeWorkCommentItems(loaded.items, args);
  if (!args.diagnosePosition) {
    updateExecuteJsonFile(args.itemsFile, loaded.parsed, results);
  }

  const allDoneWithoutRetry = results.length > 0 && results.every(isDoneWithoutRetryResult);
  if (!args.diagnosePosition && allDoneWithoutRetry) {
    try {
      const absPath = resolve(args.itemsFile);
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        console.log(`[comments:execute] 已删除中间 JSON: ${args.itemsFile}`);
      }
    } catch {}
  } else if (!args.diagnosePosition) {
    console.log(`[comments:execute] 保留中间 JSON（未全部成功）: ${args.itemsFile}`);
  } else {
    console.log(`[comments:execute] diagnose-position 模式：未写回 JSON，未更新 DB，未发送回复`);
  }

  const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
  const skipped = results.filter(isSkippedResult).length;
  const failed = results.length - succeeded - skipped;

  const skipReasons = {};
  results.filter(isSkippedResult).forEach(r => {
    const reason = r.status === 'skipped_empty_reply' ? 'empty' : r.status;
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  });
  const skippedLog = skipped > 0 ? `，跳过 ${skipped} 条（${Object.entries(skipReasons).map(([k, v]) => `${k}×${v}`).join(', ')}）` : '';

  if (args.json) {
    printJsonResult('comments:execute', { results }, { succeeded, failed, skipped, mode: args.diagnosePosition ? 'diagnose_position' : 'work_comment_json' });
  } else {
    console.log(`[comments:execute] mode=${args.diagnosePosition ? 'diagnose_position' : 'work_comment_json'} 成功 ${succeeded} 条，失败 ${failed} 条${skippedLog}`);
    for (const item of results) {
      const tag = item.status === 'skipped_empty_reply' ? ' [empty-reply]'
        : (!item.ok && item.status === 'succeeded') ? ' [already-done]'
        : (!item.ok && item.status === 'sent_unverified') ? ' [already-sent]'
        : '';
      console.log(`  [comment#${item.commentId || '-'}] ${item.ok ? item.status : `failed ${item.error}`}${tag}`);
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
