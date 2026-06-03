import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  extractComments,
  getSelectedWorkTitle,
} from '../adapters/comment-page.mjs';
import { parseDouyinTimeText } from '../adapters/work-modal-page.mjs';
import { commentFingerprint, commentInitialStatus, normalizeTimeText, notificationFingerprint } from '../domain/event-fingerprint.mjs';
import { normalizeCommentEvent, buildRawPayloadJson } from '../domain/comment-event-normalization.mjs';
import { classifyNotificationAction } from '../domain/notification-action-router.mjs';
import { insertEvent, getEventCounts, findUnstableEvent, promoteUnstableEvent, enrichEvent, upsertNotificationEvent, listEventsForDedupe } from '../db/interaction-repository.mjs';
import { upsertWorkContext, listWorksForDedupe, findWorkByThumbnailKey, findWorkByWorkId } from '../db/work-repository.mjs';
import { upsertWorkComment, listPendingCommentsGroupedByWork, listReplyTrackedCommentKeysForWork, listCommentsForDedupe, findCollectedCommentForWork } from '../db/work-comment-repository.mjs';
import logger from '../utils/logger.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { promptRecoveryAction } from '../browser/interactive-control.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { writeJSON } from '../utils/filesystem.mjs';
import { createHash } from 'crypto';
import { resolve } from 'path';

async function runCommentScan(page, run) {
  console.error('[scan] === 评论扫描 ===');

  console.error('[scan] 导航到评论管理页...');
  const navResult = await ensureCommentPageReady(page);
  if (!navResult.ok) return { ...navResult, data: { ...navResult.data, step: 'comment-navigate' } };

  console.error('[scan] 等待评论列表...');
  const areaResult = await waitForCommentsArea(page);
  if (!areaResult.ok) return { ...areaResult, data: { ...areaResult.data, step: 'comment-wait-area' } };

  if (areaResult.data.pageState === 'empty-comments') {
    console.error('[scan] 暂无评论');
    return success({ commentCount: 0, step: 'comment-scan' });
  }

  const titleResult = await getSelectedWorkTitle(page);
  const workTitle = titleResult.data?.title || '';
  console.error(`[scan] 当前作品: ${workTitle || '(未识别)'}`);

  const extractResult = await extractComments(page);
  if (!extractResult.ok) return { ...extractResult, data: { ...extractResult.data, step: 'comment-extract' } };

  const comments = extractResult.data.comments;
  console.error(`[scan] 发现 ${comments.length} 条评论`);

  let newCount = 0;
  let duplicateCount = 0;
  let parseFailedCount = 0;

  for (const c of comments) {
    try {
      if (!c.username || !c.content) {
        parseFailedCount++;
        continue;
      }
      // Do NOT normalize day-relative time before status check:
      // "昨天23:44" must stay unstable so it doesn't enter prepare/execute.
      // normalizeTimeText is only used for display/normalized storage, not for status.
      const status = commentInitialStatus(c.timeText);
      const fp = commentFingerprint(c, workTitle);

      // If relative-time comment, check if unstable event exists → may be the same
      // comment scanned again with drifted time.
      const existing = status === 'unstable' ? findUnstableEvent(fp) : null;

      if (existing) {
        // Same comment re-scanned with drifted relative time — skip
        duplicateCount++;
        continue;
      }

      // For stable-time comments, check if there's a matching unstable event that should
      // be promoted. Use content-only fingerprint (no PID, no time) to match the unstable entry.
      if (status === 'new') {
        const unstableFp = commentFingerprint({ ...c, platformEventId: '', timeText: '' }, workTitle);
        const unstableExisting = findUnstableEvent(unstableFp);
        if (unstableExisting) {
          const promoted = promoteUnstableEvent(unstableExisting.id, fp, c.timeText, c.platformEventId || null);
          if (promoted) {
            newCount++;
            console.error(`[scan]   ^ ${c.username}: ${c.content.slice(0, 40)} (promoted from unstable event #${unstableExisting.id})`);
            continue;
          }
        }
      }

      const id = insertEvent({
        eventType: 'comment',
        actorName: c.username,
        relation: 'unknown',
        myWorkTitle: workTitle,
        commentText: c.content,
        eventTimeText: c.timeText,
        platformEventId: c.platformEventId || null,
        fingerprint: fp,
        status,
      });

      if (id) {
        newCount++;
        const tag = status === 'unstable' ? ' [unstable]' : '';
        console.error(`[scan]   + ${c.username}: ${c.content.slice(0, 40)}...${tag}`);
      } else {
        duplicateCount++;
      }
    } catch {
      parseFailedCount++;
    }
  }

  run.scanned += comments.length;
  run.parseFailed += parseFailedCount;

  console.error(`[scan] 评论扫描完成: ${newCount} 条新入库, ${duplicateCount} 条重复${parseFailedCount > 0 ? `, ${parseFailedCount} 条解析失败` : ''}`);
  return success({ commentCount: newCount, duplicateCount, parseFailedCount, step: 'comment-scan' });
}

function stableHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function compactLogValue(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildNotificationFallbackKey(n) {
  const actor = n.actorProfileKey || n.actorProfileUrl || n.username || '';
  const work = n.workId || n.workUrl || n.thumbnailKey || '';
  return [
    n.eventType || 'unknown',
    actor,
    work,
    n.eventType === 'comment' ? (n.content || '') : '',
    n.timeText || '',
  ].map(v => String(v || '').trim()).join('||');
}

function getNotificationDedupeKey(n) {
  return n.platformEventId ||
    n.notificationItemKey ||
    buildNotificationFallbackKey(n);
}

function getWorkDedupeKeys(n) {
  const keys = [];
  if (n.workId) keys.push(`work_id:${n.workId}`);
  if (n.workUrl) keys.push(`work_url:${n.workUrl}`);
  if (n.thumbnailKey) keys.push(`thumbnail_key:${n.thumbnailKey}`);
  return keys;
}

function getWorkIdentity(n, modalContext = {}) {
  return {
    workId: modalContext.workId || n.workId || null,
    modalId: modalContext.modalId || null,
    workUrl: modalContext.workUrl || n.workUrl || null,
    thumbnailKey: modalContext.thumbnailKey || n.thumbnailKey || null,
  };
}

function logNotificationSkip(index, n, reason, dedupeKey = '') {
  console.error(
    `[通知跳过] index=${index} eventType=${n.eventType || 'unknown'} actorProfileKey=${compactLogValue(n.actorProfileKey)} ` +
    `actorName=${compactLogValue(n.username)} targetWorkId=${compactLogValue(n.workId)} thumbnailKey=${compactLogValue(n.thumbnailKey)} ` +
    `eventTimeText=${compactLogValue(n.timeText)} dedupeKey=${compactLogValue(dedupeKey)} reason=${reason} rawText=${compactLogValue(n.rawText, 200)}`
  );
}

function logApiNotificationSkip(index, normalized, reason, dedupeKey = '') {
  logNotificationSkip(index, {
    eventType: normalized?.eventType || 'unknown',
    actorProfileKey: normalized?.actorProfileKey || '',
    username: normalized?.actorName || '',
    workId: normalized?.workId || '',
    thumbnailKey: normalized?.thumbnailKey || '',
    timeText: normalized?.eventTimeText || '',
    rawText: normalized?.rawPayloadJson || '',
  }, reason, dedupeKey);
}

function buildCommentKey({ workId, modalId, comment }) {
  if (comment.commentKey) return comment.commentKey;
  const actor = comment.actorProfileKey || comment.actorProfileUrl || comment.actorName || '';
  const raw = [
    workId || modalId || '',
    actor,
    comment.commentText || '',
    comment.eventTimeText || '',
  ].map(v => String(v || '').trim()).join('||');
  return stableHash(raw);
}

function buildDedupeContext(days) {
  const notificationKeys = new Set();
  const workKeys = new Set();
  const commentKeys = new Set();
  const commentWorkHints = new Map();

  for (const row of listEventsForDedupe({ days })) {
    if (row.platform_event_id) notificationKeys.add(row.platform_event_id);
    if (row.notification_item_key) notificationKeys.add(row.notification_item_key);
    if (row.fingerprint) notificationKeys.add(row.fingerprint);
    const fallback = [
      row.event_type || 'unknown',
      row.actor_profile_key || row.actor_profile_url || row.actor_name || '',
      row.target_work_id || row.target_work_url || '',
      row.comment_text || '',
      row.event_time_text || '',
    ].map(v => String(v || '').trim()).join('||');
    notificationKeys.add(fallback);
  }

  for (const row of listWorksForDedupe({ days })) {
    if (row.work_id) workKeys.add(`work_id:${row.work_id}`);
    if (row.modal_id) workKeys.add(`modal_id:${row.modal_id}`);
    if (row.work_url) workKeys.add(`work_url:${row.work_url}`);
    if (row.thumbnail_key) workKeys.add(`thumbnail_key:${row.thumbnail_key}`);
  }

  for (const row of listCommentsForDedupe({ days })) {
    if (row.work_id) workKeys.add(`work_id:${row.work_id}`);
    if (row.modal_id) workKeys.add(`modal_id:${row.modal_id}`);
    if (row.comment_key) commentKeys.add(`${row.work_id || row.modal_id || '__unknown__'}:${row.comment_key}`);
    if (row.actor_name && row.comment_text && (row.work_id || row.modal_id)) {
      commentWorkHints.set(
        `${String(row.actor_name).trim()}||${String(row.comment_text).trim()}`,
        { workId: row.work_id || null, modalId: row.modal_id || null, source: 'comment_hint' }
      );
    }
  }

  return { notificationKeys, workKeys, commentKeys, commentWorkHints };
}

function resolveKnownWorkFromNotification(dedupeContext, n) {
  if (n.workId) {
    const exact = findWorkByWorkId(n.workId);
    if (exact) return { work: exact, matchedBy: `work_id:${n.workId}` };
    const numeric = n.workId.replace(/^(video|note|modal)-/, '');
    if (numeric && numeric !== n.workId) {
      const normalized = findWorkByWorkId(numeric);
      if (normalized) return { work: normalized, matchedBy: `work_id:${numeric}` };
    }
  }
  if (n.thumbnailKey) {
    const byThumb = findWorkByThumbnailKey(n.thumbnailKey);
    if (byThumb) return { work: byThumb, matchedBy: `thumbnail_key:${n.thumbnailKey}` };
  }
  const actorName = String(n.username || '').trim();
  const commentText = String(n.content || '').trim();
  const hinted = dedupeContext.commentWorkHints?.get(`${actorName}||${commentText}`);
  if (hinted) {
    return {
      work: { work_id: hinted.workId || null, modal_id: hinted.modalId || null },
      matchedBy: `comment_hint:${actorName}:${commentText.slice(0, 20)}`,
    };
  }
  return null;
}

function checkCollectedCommentForNotification(dedupeContext, n) {
  const knownWork = resolveKnownWorkFromNotification(dedupeContext, n);
  if (!knownWork) {
    return { shouldSkip: false, reason: 'work_unresolved', detail: getWorkDedupeKeys(n)[0] || '' };
  }

  const actorName = String(n.username || '').trim();
  const commentText = String(n.content || '').trim();
  if (!actorName || !commentText) {
    return { shouldSkip: false, reason: 'missing_actor_or_comment', detail: knownWork.matchedBy };
  }

  const existing = findCollectedCommentForWork({
    workId: knownWork.work.work_id || null,
    modalId: knownWork.work.modal_id || null,
    actorName,
    commentText,
  });
  if (existing) {
    return { shouldSkip: true, reason: 'same_actor_same_comment', detail: `${knownWork.matchedBy} comment_id=${existing.id}` };
  }

  return { shouldSkip: false, reason: 'same_work_new_comment', detail: knownWork.matchedBy };
}

function addWorkKeys(dedupeContext, identity) {
  if (identity.workId) {
    dedupeContext.workKeys.add(`work_id:${identity.workId}`);
    // 通知解析的 workId 带 video-/note-/modal- 前缀，弹窗的不带，两边都加
    const numeric = identity.workId.replace(/^(video|note|modal)-/, '');
    if (numeric !== identity.workId) {
      dedupeContext.workKeys.add(`work_id:${numeric}`);
    }
  }
  if (identity.modalId) dedupeContext.workKeys.add(`modal_id:${identity.modalId}`);
  if (identity.workUrl) dedupeContext.workKeys.add(`work_url:${identity.workUrl}`);
  if (identity.thumbnailKey) dedupeContext.workKeys.add(`thumbnail_key:${identity.thumbnailKey}`);
}

function addCommentWorkHint(dedupeContext, identity, comment) {
  const actorName = String(comment?.actorName || '').trim();
  const commentText = String(comment?.commentText || '').trim();
  const workId = identity?.workId || null;
  const modalId = identity?.modalId || null;
  if (!actorName || !commentText || (!workId && !modalId)) return;
  dedupeContext.commentWorkHints.set(`${actorName}||${commentText}`, {
    workId,
    modalId,
    source: 'runtime_collect',
  });
}

function getRuntimeWorkSeenKeys(work = {}) {
  const keys = [];
  if (work.work_id || work.workId) keys.push(`work_id:${work.work_id || work.workId}`);
  if (work.modal_id || work.modalId) keys.push(`modal_id:${work.modal_id || work.modalId}`);
  return keys.filter(Boolean);
}

function logWorkCollectionDecision(notificationIndex, n, decision) {
  const actor = compactLogValue(n.username, 40);
  const comment = compactLogValue(n.content, 40);
  if (decision.shouldSkip) {
    console.error(`[scan]   - 跳过作品评论 index=${notificationIndex} actor=${actor} comment=${comment} reason=${decision.reason} ${decision.detail}`);
    return;
  }
  if (decision.reason === 'same_work_new_comment') {
    console.error(`[scan]   > 同作品新评论 index=${notificationIndex} actor=${actor} comment=${comment} ${decision.detail}`);
  }
}

async function restoreNotificationPanel(page, panelTools, panelBox) {
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  } catch {}

  try {
    const panelStillVisible = await panelTools.isNotificationPanelVisible(page);
    if (panelStillVisible) {
      const state = await panelTools.waitForNotificationPanelStable(page, { timeoutMs: 2000 });
      if (state.stable && !state.empty && state.panelBox) {
        await panelTools.moveMouseIntoPanel(page, state.panelBox);
        return state.panelBox;
      }
      console.error('[scan] 通知面板可见但未稳定，重新打开通知面板');
    } else {
      console.error('[scan] 通知面板已关闭，重新打开通知面板');
    }

    const opened = await panelTools.openNotificationPanel(page);
    if (!opened) return null;
    const reopenedState = await panelTools.waitForNotificationPanelStable(page);
    if (!reopenedState.stable || reopenedState.empty) return null;
    await panelTools.moveMouseIntoPanel(page, reopenedState.panelBox || panelBox);
    return reopenedState.panelBox || panelBox;
  } catch (err) {
    console.error(`[scan] 通知面板恢复失败: ${err.message}`);
    return null;
  }
}

async function collectCommentsFromNotificationWork(page, n, { sourceEventId, notificationDays, dedupeContext, runtimeCollectedWorkKeys }) {
  const {
    waitForWorkModal,
    extractWorkModalContext,
    findUnrepliedCommentsInModal,
  } = await import('../adapters/work-modal-page.mjs');

  const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
  if (!modalReady.ok) {
    return { ok: false, reason: modalReady.message || modalReady.code || 'work-modal-not-ready' };
  }

  const contextResult = await extractWorkModalContext(page);
  const context = contextResult.ok ? (contextResult.data || {}) : {};
  console.error(`[scan] 作品标题: ${context.workTitle || '(无标题)'}`);
  console.error(`[scan] 作品内容: ${context.workText || '(无内容)'}`);
  const identity = getWorkIdentity(n, context);
  if (!identity.workId && identity.modalId) identity.workId = identity.modalId;

  if (runtimeCollectedWorkKeys) {
    const hit = getRuntimeWorkSeenKeys(identity).find(key => runtimeCollectedWorkKeys.has(key));
    if (hit) {
      console.error(`[scan]   作品 ${identity.workId || identity.modalId} 已在本轮采集过评论，跳过重复采集 (${hit})`);
      return { ok: true, skipped: true, workId: identity.workId, modalId: identity.modalId, total: 0, inWindow: 0, pending: 0, inserted: 0, enriched: 0, duplicate: 0 };
    }
  }

  const workResult = upsertWorkContext({
    workId: identity.workId,
    modalId: identity.modalId,
    workUrl: identity.workUrl,
    workTitle: context.workTitle || n.workTitle || null,
    workType: context.workType || null,
    thumbnailKey: n.thumbnailKey || null,
    thumbnailSrc: context.thumbnailSrc || n.thumbnailSrc || null,
    authorName: context.authorName || null,
    authorProfileUrl: context.authorProfileUrl || null,
    authorProfileKey: context.authorProfileKey || null,
    publishedAt: context.publishedAtText || null,
    rawContextJson: JSON.stringify({
      source: 'notification-comment',
      notificationItemKey: n.notificationItemKey || null,
      rawText: n.rawText || null,
      modalContext: context,
    }),
  });

  addWorkKeys(dedupeContext, identity);

  const alreadyRepliedKeys = new Set(listReplyTrackedCommentKeysForWork({
    workId: identity.workId,
    modalId: identity.modalId,
  }));

  const commentsResult = await findUnrepliedCommentsInModal(page, {
    maxScrolls: 50,
    alreadyRepliedKeys,
    selfNickname: context.authorName || '',
    maxAgeDays: notificationDays,
    oldCommentStopCount: 3,
  });
  if (!commentsResult.ok) {
    return { ok: false, reason: commentsResult.message || commentsResult.code || 'comment-collect-failed', workResult };
  }

  const visibleComments = commentsResult.data?.comments || [];
  const comments = commentsResult.data?.unreplied || [];
  let inserted = 0;
  let duplicate = 0;
  let enriched = 0;

  for (const c of visibleComments) {
    addCommentWorkHint(dedupeContext, identity, c);
  }

  for (const c of comments) {
    const commentKey = buildCommentKey({ workId: identity.workId, modalId: identity.modalId, comment: c });
    const dedupeKey = `${identity.workId || identity.modalId || '__unknown__'}:${commentKey}`;
    if (dedupeContext.commentKeys.has(dedupeKey)) {
      duplicate++;
      console.error(`[scan]   - 评论重复 actor=${compactLogValue(c.actorName, 30)} comment=${compactLogValue(c.commentText, 40)} reason=in_memory_comment_key`);
      continue;
    }

    const result = upsertWorkComment({
      workId: identity.workId,
      workUrl: identity.workUrl,
      modalId: identity.modalId,
      actorName: c.actorName || null,
      actorProfileUrl: c.actorProfileUrl || null,
      actorProfileKey: c.actorProfileKey || null,
      commentText: c.commentText || '',
      eventTimeText: c.eventTimeText || null,
      commentKey,
      sourceEventId,
      sourceNotificationKey: n.notificationItemKey || null,
      rawCommentJson: JSON.stringify({
        source: 'notification-work-modal',
        notificationItemKey: n.notificationItemKey || null,
        rawNotificationText: n.rawText || null,
        comment: c,
      }),
    });

    dedupeContext.commentKeys.add(dedupeKey);
    if (result.action === 'inserted') inserted++;
    else if (result.action === 'enriched') enriched++;
    else {
      duplicate++;
      console.error(`[scan]   - 评论重复 actor=${compactLogValue(c.actorName, 30)} comment=${compactLogValue(c.commentText, 40)} reason=db_upsert_duplicate`);
    }
  }

  return {
    ok: true,
    workResult,
    total: commentsResult.data?.total || 0,
    inWindow: commentsResult.data?.comments?.length || 0,
    pending: comments.length,
    inserted,
    enriched,
    duplicate,
    workId: identity.workId,
    modalId: identity.modalId,
  };
}

function writePendingReplyJson({ days = null, maxCount = 500 } = {}) {
  const groups = listPendingCommentsGroupedByWork({ limit: maxCount, days });
  const works = [];
  let totalComments = 0;

  for (const [workKey, rows] of groups.entries()) {
    totalComments += rows.length;
    works.push({
      workKey,
      comments: rows.map(row => ({
        id: row.id,
        work_id: row.work_id,
        work_url: row.work_url,
        modal_id: row.modal_id,
        actor_name: row.actor_name,
        actor_profile_url: row.actor_profile_url,
        actor_profile_key: row.actor_profile_key,
        comment_text: row.comment_text,
        event_time_text: row.event_time_text,
        comment_key: row.comment_key,
        source_event_id: row.source_event_id,
        source_notification_key: row.source_notification_key,
        reply_status: row.reply_status,
        reply_text: row.reply_text || '',
        collect_status_code: 'COLLECT_PENDING_REPLY',
        prepare_status_code: (row.reply_text && row.reply_text.trim()) ? 'PREPARE_READY' : 'PREPARE_WAIT_REPLY_TEXT',
        execute_status_code: row.reply_status === 'succeeded' ? 'EXECUTE_CONFIRMED' : 'EXECUTE_WAIT_PREPARE',
      })),
    });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = resolve('data', 'pending-replies', `pending-comments-${ts}.json`);
  writeJSON(filePath, works);
  return { filePath, totalComments, workCount: works.length };
}

function getVisitSourceType(event) {
  if (event.notificationAction === 'reply_to_my_comment') return 'reply';
  if (event.notificationAction === 'comment_on_my_work' || event.eventType === 'comment') return 'comment';
  if (event.notificationAction === 'like_received' || event.eventType === 'like') return 'like';
  if (event.notificationAction === 'follow_received') return 'follow';
  return 'other';
}

function writePendingVisitJson(events, { days = null, maxCount = 100, collectTypes = ['like', 'comment', 'reply', 'follow'] } = {}) {
  const allowed = new Set((collectTypes || []).map(type => String(type || '').trim()).filter(Boolean));
  const users = [];
  const seen = new Set();

  for (const event of events || []) {
    const sourceType = getVisitSourceType(event);
    if (allowed.size > 0 && !allowed.has(sourceType)) continue;
    const identityKey = event.actorProfileKey || event.actorProfileUrl || event.actorName || '';
    if (!identityKey || seen.has(identityKey)) continue;
    seen.add(identityKey);
    users.push({
      source_type: sourceType,
      source_event_id: event.eventId || null,
      actor_name: event.actorName || '',
      actor_profile_key: event.actorProfileKey || null,
      actor_profile_url: event.actorProfileUrl || null,
      relation: event.relation || 'unknown',
      target_work_id: event.targetWorkId || null,
      target_work_url: event.targetWorkUrl || null,
      event_time_text: event.eventTimeText || null,
      visit_status: 'pending',
      collect_status_code: 'COLLECT_PENDING_VISIT',
    });
    if (users.length >= maxCount) break;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = resolve('data', 'pending-visits', `pending-visits-${ts}.json`);
  writeJSON(filePath, {
    generatedAt: new Date().toISOString(),
    source: 'interactions:scan',
    task_type: 'return_visit',
    workflow_status_code: 'SCAN_VISIT_JSON_READY',
    status_codes: {
      scan: 'SCAN_VISIT_JSON_READY',
      prepare: 'VISIT_PREPARE_WAIT',
      execute: 'VISIT_EXECUTE_WAIT',
    },
    days,
    maxCount,
    collectTypes,
    totalUsers: users.length,
    users,
  });
  return { filePath, totalUsers: users.length };
}

async function runNotificationScan(page, run, type, pauseAfterOpen = 0, debugNotificationDom = false, scanPlan = {}) {
  console.error('[scan] === 通知面板扫描（notice api 主流程） ===');

  const {
    ensureNotificationPageReady,
    openNotificationPanel,
    closeNotificationPanel,
    extractVisibleNotifications,
    scrollPanelDown,
    waitForNotificationPanelStable,
    moveMouseIntoPanel,
  } = await import('../adapters/notification-page.mjs');
  const { createNoticeApiCollector } = await import('../adapters/notice-api-listener.mjs');
  const { normalizeNoticeApiItem } = await import('../domain/notice-api-normalization.mjs');

  const wantComments = (type === 'all' || type === 'comment');
  const wantLikes = (type === 'all' || type === 'like');
  const notificationDays = Number(run.options?.days || 0) > 0 ? Number(run.options.days) : null;
  const maxCount = Number(scanPlan.maxCount || 0) > 0 ? Number(scanPlan.maxCount) : null;
  const maxScrollRounds = Number(scanPlan.maxScrollRounds || 100);
  const dedupeContext = buildDedupeContext(notificationDays);
  const processedNoticeIds = new Set();
  const allEvents = [];
  const ambiguousEvents = [];
  const failedEvents = [];

  let totalInserted = 0;
  let totalDuplicateCount = 0;
  let totalAmbiguousCount = 0;
  let totalEnrichedCount = 0;
  let totalWorkCommentInserted = 0;
  let totalWorkCommentDuplicate = 0;
  let totalWorkCommentEnriched = 0;
  let totalProfileResolved = 0;
  let totalProfileUnresolved = 0;
  let parseFailedCount = 0;
  let scrollRounds = 0;
  let totalProcessedCount = 0;
  let consecutiveOldRelevantCount = 0;

  const apiCollector = createNoticeApiCollector(page);
  const getTotalParseFailed = () => parseFailedCount + apiCollector.getStats().parseFailed;

  async function processNoticeApiItem(item, notificationIndex) {
    const normalized = normalizeNoticeApiItem(item);
    if (!normalized) {
      console.error(`[scan] 未支持 notice 类型，跳过 index=${notificationIndex} type=${item?.type ?? 'unknown'} nid=${item?.nid_str || item?.nid || ''}`);
      return { counted: false };
    }

    const notificationId = normalized.notificationId || '';
    if (!notificationId || processedNoticeIds.has(notificationId)) {
      return { counted: false };
    }
    processedNoticeIds.add(notificationId);

    if (!wantComments && normalized.eventType === 'comment') {
      logApiNotificationSkip(notificationIndex, normalized, '--type 过滤评论通知', notificationId);
      return { counted: false };
    }
    if (!wantLikes && normalized.eventType === 'like') {
      logApiNotificationSkip(notificationIndex, normalized, '--type 过滤点赞通知', notificationId);
      return { counted: false };
    }

    if (maxCount && totalProcessedCount >= maxCount) {
      logApiNotificationSkip(notificationIndex, normalized, `达到最大采集条数 maxCount=${maxCount}`, notificationId);
      return { counted: false, stop: 'max-count' };
    }

    if (notificationDays && (normalized.eventType === 'comment' || normalized.eventType === 'like')) {
      const eventMs = Number(normalized.eventTimestamp || 0) * 1000;
      if (eventMs > 0 && eventMs < Date.now() - notificationDays * 86400000) {
        consecutiveOldRelevantCount++;
        logApiNotificationSkip(
          notificationIndex,
          normalized,
          `超过 ${notificationDays} 天时间窗口 create_time=${normalized.eventTimestamp}`,
          notificationId
        );
        if (consecutiveOldRelevantCount >= 3) {
          console.error(`[scan] 连续 3 条评论/点赞通知超过 ${notificationDays} 天，停止继续滚动`);
          return { counted: false, stop: 'old-relevant' };
        }
        return { counted: false };
      }
      consecutiveOldRelevantCount = 0;
    }

    totalProcessedCount++;

    const profileResolutionStatus = normalized.actorProfileUrl ? 'api_resolved' : 'unresolved';
    if (normalized.actorProfileUrl) totalProfileResolved++;
    else totalProfileUnresolved++;

    const actionText = normalized.eventType === 'comment' ? '评论了你的作品' : '赞了你的作品';
    const content = normalized.eventType === 'comment' ? normalized.commentText : null;
    const { fp, confidence } = notificationFingerprint({
      eventType: normalized.eventType,
      username: normalized.actorName,
      actorProfileKey: normalized.actorProfileKey,
      actorProfileUrl: normalized.actorProfileUrl,
      action: actionText,
      content,
      rawText: '',
      notificationItemKey: normalized.notificationId,
      platformEventId: normalized.platformEventId,
      workId: normalized.workId,
      workUrl: normalized.workUrl,
      thumbnailKey: normalized.thumbnailKey,
    });

    const result = upsertNotificationEvent({
      eventType: normalized.eventType,
      actorName: normalized.actorName,
      actorProfileKey: normalized.actorProfileKey || null,
      actorProfileUrl: normalized.actorProfileUrl || null,
      relation: normalized.relation,
      commentText: content,
      eventTimeText: normalized.eventTimeText,
      fingerprint: fp,
      dedupConfidence: confidence,
      platformEventId: normalized.platformEventId || null,
      notificationItemKey: normalized.notificationId || null,
      workId: normalized.workId || null,
      workUrl: normalized.workUrl || null,
      action: actionText,
      content,
      rawPayloadJson: normalized.rawPayloadJson,
      targetWorkId: normalized.workId || null,
      targetWorkUrl: normalized.workUrl || null,
      profileResolutionStatus,
      myWorkTitle: normalized.workTitle || null,
    });

    dedupeContext.notificationKeys.add(notificationId);
    if (normalized.platformEventId) dedupeContext.notificationKeys.add(normalized.platformEventId);
    if (fp) dedupeContext.notificationKeys.add(fp);

    upsertWorkContext({
      workId: normalized.workId || null,
      modalId: null,
      workUrl: normalized.workUrl || null,
      workTitle: normalized.workTitle || null,
      workType: normalized.workType || null,
      thumbnailKey: normalized.thumbnailKey || null,
      thumbnailSrc: normalized.thumbnailSrc || null,
      authorName: null,
      authorProfileUrl: null,
      authorProfileKey: null,
      publishedAt: normalized.workCreateTime ? String(normalized.workCreateTime) : null,
      rawContextJson: normalized.rawPayloadJson,
    });

    addWorkKeys(dedupeContext, {
      workId: normalized.workId || null,
      modalId: null,
      workUrl: normalized.workUrl || null,
      thumbnailKey: normalized.thumbnailKey || null,
    });

    if (result.action === 'inserted') totalInserted++;
    else if (result.action === 'enriched') totalEnrichedCount++;
    else if (result.action === 'duplicate') totalDuplicateCount++;
    else if (result.action === 'ambiguous') totalAmbiguousCount++;

    if (result.action === 'ambiguous') {
      ambiguousEvents.push({
        eventType: normalized.eventType,
        actorName: normalized.actorName,
        actorProfileUrl: normalized.actorProfileUrl || null,
        relation: normalized.relation,
        platformEventId: normalized.platformEventId || null,
        targetWorkId: normalized.workId || null,
        error: result.error || 'ambiguous',
      });
      return { counted: true };
    }

    if (normalized.eventType === 'comment') {
      const commentKey = normalized.commentId || stableHash([
        normalized.workId,
        normalized.actorProfileKey,
        normalized.actorName,
        normalized.commentText,
        normalized.eventTimeText,
      ].join('||'));

      const commentResult = upsertWorkComment({
        workId: normalized.workId || null,
        workUrl: normalized.workUrl || null,
        modalId: null,
        actorName: normalized.actorName || null,
        actorProfileUrl: normalized.actorProfileUrl || null,
        actorProfileKey: normalized.actorProfileKey || null,
        commentText: normalized.commentText || '',
        eventTimeText: normalized.eventTimeText || null,
        commentKey,
        sourceEventId: result.eventId || null,
        sourceNotificationKey: normalized.notificationId || null,
        rawCommentJson: normalized.rawPayloadJson,
      });

      const commentDedupeKey = `${normalized.workId || '__unknown__'}:${commentKey}`;
      dedupeContext.commentKeys.add(commentDedupeKey);

      if (commentResult.action === 'inserted') totalWorkCommentInserted++;
      else if (commentResult.action === 'enriched') totalWorkCommentEnriched++;
      else totalWorkCommentDuplicate++;
    }

    allEvents.push({
      eventId: result.eventId || null,
      eventType: normalized.eventType,
      actorName: normalized.actorName,
      actorProfileUrl: normalized.actorProfileUrl || null,
      actorProfileKey: normalized.actorProfileKey || null,
      relation: normalized.relation,
      profileResolutionStatus,
      dbAction: result.action,
      dedupConfidence: confidence,
      notificationAction: normalized.notificationAction,
      platformEventId: normalized.platformEventId || null,
      targetWorkId: normalized.workId || null,
      targetWorkUrl: normalized.workUrl || null,
      eventTimeText: normalized.eventTimeText || null,
    });

    console.error(
      `[scan] api通知处理 index=${notificationIndex} eventType=${normalized.eventType} actor=${compactLogValue(normalized.actorName, 40)} ` +
      `workId=${compactLogValue(normalized.workId, 40)} notificationId=${notificationId} platformEventId=${compactLogValue(normalized.platformEventId, 40)} ` +
      `create_time=${compactLogValue(normalized.eventTimeText, 40)} result=${result.action}`
    );

    return { counted: true };
  }

  try {
    try {
      await ensureNotificationPageReady(page);
    } catch (err) {
      if ((err.message || '').includes('网络不好')) {
        return blocking(RESULT_CODES.BLOCKED, err.message, { recoverable: true, data: { step: 'notify-navigate' } });
      }
      return blocking(RESULT_CODES.NAVIGATION_TIMEOUT, `通知页面导航超时: ${err.message}`, { data: { step: 'notify-navigate' } });
    }

    let opened = false;
    try {
      opened = await openNotificationPanel(page);
    } catch (err) {
      if ((err.message || '').includes('网络不好')) {
        return blocking(RESULT_CODES.BLOCKED, err.message, { recoverable: true, data: { step: 'notify-open-panel' } });
      }
      throw err;
    }
    if (!opened) {
      return blocking(
        RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
        '无法打开通知面板（未找到铃铛图标或面板未出现）',
        { data: { step: 'notify-open-panel' } }
      );
    }

    const panelState = await waitForNotificationPanelStable(page);
    if (panelState.networkBad) {
      return blocking(RESULT_CODES.BLOCKED, panelState.reason || '网络不好', { recoverable: true, data: { step: 'notify-panel-unstable' } });
    }
    if (!panelState.stable || panelState.empty) {
      if (!panelState.stable) {
        return blocking(RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND, '通知面板未稳定或已消失', { data: { step: 'notify-panel-unstable' } });
      }
      console.error('[scan] 通知面板为空（暂无消息）');
      await closeNotificationPanel(page);
      return success({
        inserted: 0, duplicateCount: 0, enriched: 0, ambiguousCount: 0,
        profileResolved: 0, profileUnresolved: 0, parseFailed: 0,
        scrollRounds: 0, events: [], ambiguousEvents: [], failedEvents: [],
        empty: true, step: 'notify-scan',
      });
    }

    await moveMouseIntoPanel(page, panelState.panelBox);
    console.error('[scan] 通知面板已就绪，鼠标保持在面板内');

    if (pauseAfterOpen > 0) {
      console.error(`[scan] --pause-after-open: 暂停 ${pauseAfterOpen}ms，可人工确认面板...`);
      await page.waitForTimeout(pauseAfterOpen);
    }

    await page.waitForTimeout(1200);
    console.error('[scan] 开始使用 notice api 数据采集');

    for (let round = 0; round < maxScrollRounds; round++) {
      const domBatch = await extractVisibleNotifications(page).catch(() => null);
      const currentItems = apiCollector.getItems();
      let roundProcessed = 0;

      for (const item of currentItems) {
        const notificationIndex = totalProcessedCount + 1;
        const result = await processNoticeApiItem(item, notificationIndex);
        if (result?.counted) roundProcessed++;
        if (result?.stop === 'max-count') {
          console.error(`[scan] 达到最大采集条数 maxCount=${maxCount}，停止采集`);
          scrollRounds = round;
          if (!run.options?.keepOpen) await closeNotificationPanel(page);
          const pendingReplyFile = scanPlan.generateReplyJson
            ? writePendingReplyJson({ days: notificationDays, maxCount: maxCount || 500 })
            : null;
          const pendingVisitFile = scanPlan.generateVisitJson
            ? writePendingVisitJson(allEvents, { days: notificationDays, maxCount: maxCount || 100, collectTypes: scanPlan.collectTypes })
            : null;
          return success({
            inserted: totalInserted,
            duplicateCount: totalDuplicateCount,
            enriched: totalEnrichedCount,
            ambiguousCount: totalAmbiguousCount,
            profileResolved: totalProfileResolved,
            profileUnresolved: totalProfileUnresolved,
            parseFailed: getTotalParseFailed(),
            scrollRounds,
            workCommentsInserted: totalWorkCommentInserted,
            workCommentsEnriched: totalWorkCommentEnriched,
            workCommentsDuplicate: totalWorkCommentDuplicate,
            pendingReplyFile,
            pendingVisitFile,
            events: allEvents,
            ambiguousEvents,
            failedEvents,
            step: 'notify-scan',
          });
        }
        if (result?.stop === 'old-relevant') {
          scrollRounds = round;
          const pendingReplyFile = scanPlan.generateReplyJson
            ? writePendingReplyJson({ days: notificationDays, maxCount: maxCount || 500 })
            : null;
          const pendingVisitFile = scanPlan.generateVisitJson
            ? writePendingVisitJson(allEvents, { days: notificationDays, maxCount: maxCount || 100, collectTypes: scanPlan.collectTypes })
            : null;
          if (!run.options?.keepOpen) await closeNotificationPanel(page);
          return success({
            inserted: totalInserted,
            duplicateCount: totalDuplicateCount,
            enriched: totalEnrichedCount,
            ambiguousCount: totalAmbiguousCount,
            profileResolved: totalProfileResolved,
            profileUnresolved: totalProfileUnresolved,
            parseFailed: getTotalParseFailed(),
            scrollRounds,
            workCommentsInserted: totalWorkCommentInserted,
            workCommentsEnriched: totalWorkCommentEnriched,
            workCommentsDuplicate: totalWorkCommentDuplicate,
            pendingReplyFile,
            pendingVisitFile,
            events: allEvents,
            ambiguousEvents,
            failedEvents,
            step: 'notify-scan',
          });
        }
      }

      run.scanned = totalProcessedCount;
      run.enriched = totalEnrichedCount;
      console.error(
        `[scan] 使用 notice api 数据采集: 本轮新增 ${roundProcessed} 条`
      );
      console.error(
        `[scan] api通知入库 +${totalInserted}, 重复 ${totalDuplicateCount}, 补全 ${totalEnrichedCount}, 评论入库 +${totalWorkCommentInserted}, 点赞 ${allEvents.filter(e => e.eventType === 'like').length}`
      );

      if (apiCollector.getMeta().hasMore === 0) {
        console.error('[scan] notice api has_more=0，停止滚动');
        scrollRounds = round;
        break;
      }

      if (domBatch?.ok && domBatch.data?.noMoreData) {
        console.error('[scan] 面板显示"暂无更多数据"，停止采集');
        scrollRounds = round;
        break;
      }

      if (round >= maxScrollRounds - 1) {
        scrollRounds = maxScrollRounds;
        console.error(`[scan] 达到最大滚动轮次 ${maxScrollRounds}，停止采集，防止死循环`);
        break;
      }

      const beforeCount = apiCollector.getItems().length;
      const scrollResult = await scrollPanelDown(page, { deltaY: 600 });
      if (!scrollResult.scrolled) {
        console.error('[scan] 无法滚动通知面板，停止采集');
        scrollRounds = round + 1;
        break;
      }

      scrollRounds = round + 1;
      await apiCollector.waitForNewItems({ beforeCount, timeoutMs: 3000 });

      const stats = apiCollector.getStats();
      if (scrollRounds >= 2 && stats.itemCount === 0 && stats.responseCount === 0) {
        console.error('[scan] 未捕获 notice api 数据，退回 DOM 解析兜底');
        if (!run.options?.keepOpen) {
          await closeNotificationPanel(page).catch(() => {});
        }
        return await runNotificationScanDomFallback(page, run, type, pauseAfterOpen, debugNotificationDom, scanPlan);
      }
    }

    if (!run.options?.keepOpen) {
      await closeNotificationPanel(page);
    }

    const pendingReplyFile = scanPlan.generateReplyJson
      ? writePendingReplyJson({ days: notificationDays, maxCount: maxCount || 500 })
      : null;
    if (pendingReplyFile) {
      console.error(`[scan] 待回复评论 JSON: ${pendingReplyFile.filePath} (${pendingReplyFile.totalComments} 条, ${pendingReplyFile.workCount} 个作品)`);
    } else {
      console.error('[scan] 本次计划不生成待回复评论 JSON');
    }

    const pendingVisitFile = scanPlan.generateVisitJson
      ? writePendingVisitJson(allEvents, { days: notificationDays, maxCount: maxCount || 100, collectTypes: scanPlan.collectTypes })
      : null;
    if (pendingVisitFile) {
      console.error(`[scan] 待回访 JSON: ${pendingVisitFile.filePath} (${pendingVisitFile.totalUsers} 个用户)`);
    } else {
      console.error('[scan] 本次计划不生成待回访 JSON');
    }

    console.error(
      `[scan] 通知扫描完成: ${totalInserted} 条入库 | ${totalDuplicateCount} 重复 | ${totalEnrichedCount} 补全信息 | ${totalAmbiguousCount} 歧义 | ` +
      `${totalProfileResolved} 主页已解析 | ${totalProfileUnresolved} 主页未解析 | work_comments ${totalWorkCommentInserted} 新增/${totalWorkCommentEnriched} 补全/${totalWorkCommentDuplicate} 重复 | ` +
      `${getTotalParseFailed()} 条解析失败 | ${scrollRounds} 轮滚动`
    );

    return success({
      inserted: totalInserted,
      duplicateCount: totalDuplicateCount,
      enriched: totalEnrichedCount,
      ambiguousCount: totalAmbiguousCount,
      profileResolved: totalProfileResolved,
      profileUnresolved: totalProfileUnresolved,
      parseFailed: getTotalParseFailed(),
      scrollRounds,
      workCommentsInserted: totalWorkCommentInserted,
      workCommentsEnriched: totalWorkCommentEnriched,
      workCommentsDuplicate: totalWorkCommentDuplicate,
      pendingReplyFile,
      pendingVisitFile,
      events: allEvents,
      ambiguousEvents,
      failedEvents,
      step: 'notify-scan',
    });
  } catch (err) {
    parseFailedCount++;
    failedEvents.push({ actorName: 'unknown', eventType: 'unknown', error: err.message || 'notice-api-scan-error' });
    return blocking(
      RESULT_CODES.BLOCKED,
      `notice api 扫描失败: ${err.message}`,
      { recoverable: true, data: { step: 'notify-scan' } }
    );
  } finally {
    apiCollector.stop();
  }
}

async function runNotificationScanDomFallback(page, run, type, pauseAfterOpen = 0, debugNotificationDom = false, scanPlan = {}) {
  console.error('[scan] === 通知面板扫描（增量逐批采集） ===');
  console.error('[scan] DOM 兜底模式将使用旧流程，可能点击作品缩略图采集评论');

  const {
    ensureNotificationPageReady, openNotificationPanel, closeNotificationPanel,
    extractVisibleNotifications, scrollPanelDown,
    waitForNotificationPanelStable, moveMouseIntoPanel, isNotificationPanelVisible,
    clickNotificationThumbnail,
  } = await import('../adapters/notification-page.mjs');

  const panelTools = {
    ensureNotificationPageReady,
    openNotificationPanel,
    waitForNotificationPanelStable,
    moveMouseIntoPanel,
    isNotificationPanelVisible,
  };

  try {
    await ensureNotificationPageReady(page);
  } catch (err) {
    if ((err.message || '').includes('网络不好')) {
      return blocking(
        RESULT_CODES.BLOCKED,
        err.message,
        { recoverable: true, data: { step: 'notify-navigate' } }
      );
    }
    return blocking(
      RESULT_CODES.NAVIGATION_TIMEOUT,
      `通知页面导航超时: ${err.message}`,
      { data: { step: 'notify-navigate' } }
    );
  }

  let opened = false;
  try {
    opened = await openNotificationPanel(page);
  } catch (err) {
    if ((err.message || '').includes('网络不好')) {
      return blocking(
        RESULT_CODES.BLOCKED,
        err.message,
        { recoverable: true, data: { step: 'notify-open-panel' } }
      );
    }
    throw err;
  }
  if (!opened) {
    return blocking(
      RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
      '无法打开通知面板（未找到铃铛图标或面板未出现）',
      { data: { step: 'notify-open-panel' } }
    );
  }

  const panelState = await waitForNotificationPanelStable(page);
  if (panelState.networkBad) {
    return blocking(
      RESULT_CODES.BLOCKED,
      panelState.reason || '网络不好',
      { recoverable: true, data: { step: 'notify-panel-unstable' } }
    );
  }
  const { stable, empty } = panelState;
  let panelBox = panelState.panelBox;
  if (!stable || empty) {
    if (!stable) {
      return blocking(
        RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
        '通知面板未稳定或已消失',
        { data: { step: 'notify-panel-unstable' } }
      );
    }
    console.error('[scan] 通知面板为空（暂无消息）');
    await closeNotificationPanel(page);
    return success({
      inserted: 0, duplicateCount: 0, enriched: 0, ambiguousCount: 0,
      profileResolved: 0, profileUnresolved: 0, parseFailed: 0,
      scrollRounds: 0, events: [], ambiguousEvents: [], failedEvents: [],
      empty: true, step: 'notify-scan',
    });
  }

  await moveMouseIntoPanel(page, panelBox);
  console.error('[scan] 通知面板已就绪，鼠标保持在面板内');

  if (pauseAfterOpen > 0) {
    console.error(`[scan] --pause-after-open: 暂停 ${pauseAfterOpen}ms，可人工确认面板...`);
    await page.waitForTimeout(pauseAfterOpen);
  }

  const wantComments = (type === 'all' || type === 'comment');
  const wantLikes = (type === 'all' || type === 'like');
  const wantReplies = (type === 'all' || type === 'reply');
  const wantFollows = (type === 'all' || type === 'follow');
  const notificationDays = Number(run.options?.days || 0) > 0 ? Number(run.options.days) : null;
  const maxCount = Number(scanPlan.maxCount || 0) > 0 ? Number(scanPlan.maxCount) : null;
  const dedupeContext = buildDedupeContext(notificationDays);
  console.error(
    `[scan] 去重上下文: notifications=${dedupeContext.notificationKeys.size} ` +
    `works=${dedupeContext.workKeys.size} comments=${dedupeContext.commentKeys.size}` +
    (notificationDays ? ` days=${notificationDays}` : '')
  );

  let totalInserted = 0;
  let totalDuplicateCount = 0;
  let totalAmbiguousCount = 0;
  let totalEnrichedCount = 0;
  let totalWorkCommentInserted = 0;
  let totalWorkCommentDuplicate = 0;
  let totalWorkCommentEnriched = 0;
  let totalProfileResolved = 0;
  let totalProfileUnresolved = 0;
  let parseFailedCount = 0;
  let scrollRounds = 0;

  const allEvents = [];
  const ambiguousEvents = [];
  const failedEvents = [];
  const seenItemKeys = new Set();
  const runtimeCollectedWorkKeys = new Set();
  let consecutiveOldRelevantCount = 0;
  let stopDueToOldRelevant = false;

  console.error('[scan] 开始逐批采集通知...');

  let debugDumpDone = false;

  while (true) {
    const batchResult = await extractVisibleNotifications(page);
    if (!batchResult || !batchResult.ok) {
      if (scrollRounds === 0) {
        return blocking(
          RESULT_CODES.NOTIFICATION_ITEMS_EMPTY,
          batchResult?.message || '通知解析失败',
          { data: { step: 'notify-extract' } }
        );
      }
      break;
    }

    if (debugNotificationDom && !debugDumpDone) {
      debugDumpDone = true;
      try {
        const { debugDumpNotificationItems } = await import('../adapters/notification-page.mjs');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const debugDir = resolve('data', 'debug', 'notifications', ts);
        console.error(`[scan] --debug-notification-dom: 保存通知 DOM 调试信息到 ${debugDir}`);
        await debugDumpNotificationItems(page, debugDir);
      } catch (err) {
        console.error(`[scan] debug dump 失败: ${err.message}`);
      }
    }

      const notifications = batchResult.data.notifications || [];
      const noMoreData = batchResult.data.noMoreData || false;
      let batchInserted = 0;
    let batchEnriched = 0;
    let batchDuplicate = 0;
    let batchAmbiguous = 0;
    let batchProfileResolved = 0;
    let batchProfileUnresolved = 0;
    let newInBatch = 0;
    let processedInBatch = 0;

    for (const [itemIndex, n] of notifications.entries()) {
      const notificationIndex = run.scanned + itemIndex + 1;
      if (maxCount && seenItemKeys.size >= maxCount) {
        logNotificationSkip(notificationIndex, n, `达到最大采集条数 maxCount=${maxCount}`);
        stopDueToOldRelevant = true;
        break;
      }
      const itemKey = n.notificationItemKey || (n.username + '||' + n.action + '||' + (n.content || ''));
      if (seenItemKeys.has(itemKey)) {
        logNotificationSkip(notificationIndex, n, '本次扫描内重复通知', itemKey);
        continue;
      }
      seenItemKeys.add(itemKey);

      try {
        const route = classifyNotificationAction(n.rawText || n.action || '');
        const notificationDedupeKey = getNotificationDedupeKey(n);

        if (!wantComments && n.eventType === 'comment') {
          logNotificationSkip(notificationIndex, n, '--type 过滤评论通知', notificationDedupeKey);
          continue;
        }
        if (!wantLikes && n.eventType === 'like') {
          logNotificationSkip(notificationIndex, n, '--type 过滤点赞通知', notificationDedupeKey);
          continue;
        }
        if (!wantReplies && n.eventType === 'reply') {
          logNotificationSkip(notificationIndex, n, '--type 过滤回复类通知', notificationDedupeKey);
          continue;
        }
        if (!wantFollows && n.eventType === 'follow') {
          logNotificationSkip(notificationIndex, n, '--type 过滤关注类通知', notificationDedupeKey);
          continue;
        }

        if (dedupeContext.notificationKeys.has(notificationDedupeKey)) {
          if (route.notificationAction !== 'comment_on_my_work') {
            logNotificationSkip(notificationIndex, n, '数据库中已存在通知记录', notificationDedupeKey);
            continue;
          }
          console.error(`[scan]   = ${n.username} [${n.relation}] 通知已存在，检查是否需要补采作品评论`);
        }

        const isRelevantEvent = n.eventType === 'comment' || n.eventType === 'like';
        const parsedNotificationTime = notificationDays && isRelevantEvent ? parseDouyinTimeText(n.timeText || '') : null;
        const isOlderThanWindow = !!(notificationDays && parsedNotificationTime && new Date(parsedNotificationTime).getTime() < Date.now() - notificationDays * 86400000);
        if (isRelevantEvent && notificationDays) {
          if (isOlderThanWindow) {
            const parsedStr = parsedNotificationTime ? new Date(parsedNotificationTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '(解析失败)';
            consecutiveOldRelevantCount++;
            if (consecutiveOldRelevantCount >= 3) {
              console.error(`[scan]   连续 ${consecutiveOldRelevantCount} 条评论/点赞通知超过 ${notificationDays} 天，停止继续滚动`);
              stopDueToOldRelevant = true;
              break;
            }
            logNotificationSkip(notificationIndex, n, `超过 ${notificationDays} 天时间窗口 (解析时间: ${parsedStr})`, notificationDedupeKey);
            continue;
          }
          consecutiveOldRelevantCount = 0;
        }

        newInBatch++;
        processedInBatch++;

        if (n.eventType === 'comment') {
          const normResult = normalizeCommentEvent({
            actorName: n.username,
            actorProfileUrl: n.actorProfileUrl || '',
            commentText: n.content || '',
            eventTimeText: n.timeText || '',
            workTitle: n.workTitle || '',
            workId: n.workId || '',
            workUrl: n.workUrl || '',
            rawText: n.rawText || '',
            notificationItemKey: n.notificationItemKey || '',
          });
          if (!normResult.valid) {
            batchDuplicate++;
            logNotificationSkip(notificationIndex, n, `评论通知规范化失败: ${(normResult.warnings || []).join(',') || 'invalid'}`, notificationDedupeKey);
            continue;
          }
        }

        const profileResolutionStatus = n.actorProfileUrl
          ? (n.profileResolveMethod || 'resolved') : 'unresolved';

        if (n.actorProfileUrl) batchProfileResolved++;
        else batchProfileUnresolved++;

        const { fp, confidence } = notificationFingerprint({
          eventType: n.eventType, username: n.username,
          actorProfileKey: n.actorProfileKey, actorProfileUrl: n.actorProfileUrl,
          action: n.action,
          content: n.eventType === 'comment' ? n.content : null,
          rawText: n.rawText,
          notificationItemKey: n.notificationItemKey,
          platformEventId: n.platformEventId || null,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          thumbnailKey: n.thumbnailKey || null,
        });

        const rawPayload = {
          rawText: n.rawText,
          notificationItemKey: n.notificationItemKey,
          extractSource: 'notification',
          profileResolveMethod: profileResolutionStatus,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          workTitle: n.workTitle || null,
          thumbnailKey: n.thumbnailKey || null,
          thumbnailSrc: n.thumbnailSrc || null,
          thumbnailAlt: n.thumbnailAlt || null,
          dedupConfidence: confidence,
          profileResolutionStatus,
        };

        if (n.eventType === 'comment') {
          const normResult = normalizeCommentEvent({
            actorName: n.username,
            actorProfileUrl: n.actorProfileUrl || '',
            commentText: n.content || '',
            eventTimeText: n.timeText || '',
            workTitle: n.workTitle || '',
            workId: n.workId || '',
            workUrl: n.workUrl || '',
            rawText: n.rawText || '',
            notificationItemKey: n.notificationItemKey || '',
          });
          if (normResult.warnings && normResult.warnings.length > 0) {
            rawPayload.warnings = normResult.warnings;
          }
        }

        const result = upsertNotificationEvent({
          eventType: n.eventType, actorName: n.username,
          actorProfileKey: n.actorProfileKey || null,
          actorProfileUrl: n.actorProfileUrl || null,
          relation: n.relation,
          commentText: n.eventType === 'comment' ? n.content : null,
          eventTimeText: n.timeText,
          fingerprint: fp,
          dedupConfidence: confidence,
          platformEventId: n.platformEventId || null,
          notificationItemKey: n.notificationItemKey || null,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          action: n.action,
          content: n.eventType === 'comment' ? n.content : null,
          rawPayloadJson: JSON.stringify(rawPayload),
          targetWorkId: n.workId || null,
          targetWorkUrl: n.workUrl || null,
          profileResolutionStatus,
          myWorkTitle: n.workTitle || null,
        });

        if (result.action === 'inserted') {
          batchInserted++;
          dedupeContext.notificationKeys.add(notificationDedupeKey);
          if (n.platformEventId) dedupeContext.notificationKeys.add(n.platformEventId);
          if (n.notificationItemKey) dedupeContext.notificationKeys.add(n.notificationItemKey);
          if (fp) dedupeContext.notificationKeys.add(fp);
          const tag = n.actorProfileUrl ? '' : ' [no-profile]';
          console.error(`[scan]   + ${n.username} [${n.relation}] ${n.action} ${n.timeText}${tag}`);
          allEvents.push({
            eventId: result.eventId, eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            actorProfileKey: n.actorProfileKey || null,
            relation: n.relation, profileResolutionStatus,
            dbAction: 'inserted', dedupConfidence: confidence,
            notificationAction: route.notificationAction,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            targetWorkUrl: n.workUrl || null,
            eventTimeText: n.timeText || null,
          });
        } else if (result.action === 'enriched') {
          batchEnriched++;
          dedupeContext.notificationKeys.add(notificationDedupeKey);
          if (n.platformEventId) dedupeContext.notificationKeys.add(n.platformEventId);
          if (n.notificationItemKey) dedupeContext.notificationKeys.add(n.notificationItemKey);
          if (fp) dedupeContext.notificationKeys.add(fp);
          console.error(`[scan]   ~ ${n.username} [${n.relation}] enriched`);
          allEvents.push({
            eventId: result.eventId, eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            actorProfileKey: n.actorProfileKey || null,
            relation: n.relation, profileResolutionStatus,
            dbAction: 'enriched', dedupConfidence: confidence,
            notificationAction: route.notificationAction,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            targetWorkUrl: n.workUrl || null,
            eventTimeText: n.timeText || null,
          });
        } else if (result.action === 'duplicate') {
          batchDuplicate++;
          dedupeContext.notificationKeys.add(notificationDedupeKey);
          logNotificationSkip(notificationIndex, n, '数据库 upsert 判定重复', notificationDedupeKey);
        } else if (result.action === 'ambiguous') {
          batchAmbiguous++;
          console.error(`[scan]   ? ${n.username} [${n.relation}] ambiguous match`);
          ambiguousEvents.push({
            eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            relation: n.relation,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            error: result.error || 'ambiguous',
          });
        }

        if (route.notificationAction === 'comment_on_my_work') {
          const workCheck = checkCollectedCommentForNotification(dedupeContext, n);
          const knownWork = resolveKnownWorkFromNotification(dedupeContext, n);
          const runtimeWorkHit = knownWork
            ? getRuntimeWorkSeenKeys(knownWork.work).find(key => runtimeCollectedWorkKeys.has(key))
            : null;
          if (runtimeWorkHit) {
            logNotificationSkip(notificationIndex, n, `同轮已采集过该作品 ${runtimeWorkHit}`, notificationDedupeKey);
            continue;
          }
          if (workCheck.shouldSkip) {
            logWorkCollectionDecision(notificationIndex, n, workCheck);
            continue;
          }
          logWorkCollectionDecision(notificationIndex, n, workCheck);

          const clicked = await clickNotificationThumbnail(page, n);
          if (!clicked) {
            logNotificationSkip(notificationIndex, n, '未能点击作品缩略图，跳过作品评论采集', notificationDedupeKey);
            continue;
          }

          const collectResult = await collectCommentsFromNotificationWork(page, n, {
            sourceEventId: result.eventId || null,
            notificationDays,
            dedupeContext,
            runtimeCollectedWorkKeys,
          });
          if (!collectResult.ok) {
            logNotificationSkip(notificationIndex, n, `作品评论采集失败: ${collectResult.reason}`, notificationDedupeKey);
          } else {
            for (const key of getRuntimeWorkSeenKeys({ workId: collectResult.workId, modalId: collectResult.modalId })) {
              runtimeCollectedWorkKeys.add(key);
            }
            totalWorkCommentInserted += collectResult.inserted;
            totalWorkCommentDuplicate += collectResult.duplicate;
            totalWorkCommentEnriched += collectResult.enriched;
            if (collectResult.skipped) {
              console.error(`[scan]   作品评论已采集，跳过 workId=${collectResult.workId || ''} modalId=${collectResult.modalId || ''}`);
            } else {
              console.error(
                `[scan]   评论采集 workId=${collectResult.workId || ''} modalId=${collectResult.modalId || ''}: ` +
                `${collectResult.inserted} 新增, ${collectResult.enriched} 补全, ${collectResult.duplicate} 重复, ` +
                `pending=${collectResult.pending}, total=${collectResult.total}`
              );
            }
          }

          const restoredPanelBox = await restoreNotificationPanel(page, panelTools, panelBox);
          if (!restoredPanelBox) {
            console.error('[scan] 作品评论采集后无法恢复通知面板，停止后续滚动');
            stopDueToOldRelevant = true;
            break;
          }
          panelBox = restoredPanelBox;
        } else if (route.notificationAction === 'reply_to_my_comment') {
          logNotificationSkip(notificationIndex, n, '回复/赞评论通知，归入回复分类（暂不后续处理）', notificationDedupeKey);
        } else if (route.notificationAction === 'follow_received') {
          logNotificationSkip(notificationIndex, n, '关注/回关通知，归入粉丝管理分类（暂不后续处理）', notificationDedupeKey);
        } else if (route.notificationAction === 'unknown') {
          logNotificationSkip(notificationIndex, n, '无法识别通知类型，暂不进入后续处理', notificationDedupeKey);
        }
      } catch (err) {
        parseFailedCount++;
        logNotificationSkip(notificationIndex, n, `单条通知处理异常: ${err.message || 'parse error'}`);
        failedEvents.push({
          actorName: n.username || 'unknown',
          eventType: n.eventType || 'unknown',
          error: err.message || 'parse error',
        });
      }
    }

    totalInserted += batchInserted;
    totalDuplicateCount += batchDuplicate;
    totalAmbiguousCount += batchAmbiguous;
    totalEnrichedCount += batchEnriched;
    totalProfileResolved += batchProfileResolved;
    totalProfileUnresolved += batchProfileUnresolved;
    scrollRounds++;
    run.scanned += notifications.length;
    run.enriched = totalEnrichedCount;

    console.error(`[scan]   轮次 ${scrollRounds}: +${batchInserted}条 (${batchDuplicate}重复, ${batchEnriched}补全, ${batchAmbiguous}歧义, ${batchProfileResolved}主页解析, ${newInBatch}新, 评论入库+${totalWorkCommentInserted})`);
    if (stopDueToOldRelevant) {
      break;
    }

    if (noMoreData) {
      console.error('[scan] 面板显示"暂无更多数据"，停止采集');
      break;
    }

    const scrollResult = await scrollPanelDown(page, { deltaY: 600 });
    if (!scrollResult.scrolled) {
      console.error('[scan] 无法滚动通知面板');
      break;
    }
  }

  if (!run.options?.keepOpen) {
    await closeNotificationPanel(page);
  }

  const pendingReplyFile = scanPlan.generateReplyJson
    ? writePendingReplyJson({ days: notificationDays, maxCount: maxCount || 500 })
    : null;
  if (pendingReplyFile) {
    console.error(`[scan] 待回复评论 JSON: ${pendingReplyFile.filePath} (${pendingReplyFile.totalComments} 条, ${pendingReplyFile.workCount} 个作品)`);
  } else {
    console.error('[scan] 本次计划不生成待回复评论 JSON');
  }

  const pendingVisitFile = scanPlan.generateVisitJson
    ? writePendingVisitJson(allEvents, { days: notificationDays, maxCount: maxCount || 100, collectTypes: scanPlan.collectTypes })
    : null;
  if (pendingVisitFile) {
    console.error(`[scan] 待回访 JSON: ${pendingVisitFile.filePath} (${pendingVisitFile.totalUsers} 个用户)`);
  } else {
    console.error('[scan] 本次计划不生成待回访 JSON');
  }

  console.error(`[scan] 通知扫描完成: ${totalInserted} 条入库 | ${totalDuplicateCount} 重复 | ${totalEnrichedCount} 补全信息 | ${totalAmbiguousCount} 歧义 | ${totalProfileResolved} 主页已解析 | ${totalProfileUnresolved} 主页未解析 | work_comments ${totalWorkCommentInserted} 新增/${totalWorkCommentEnriched} 补全/${totalWorkCommentDuplicate} 重复 | ${parseFailedCount} 条解析失败 | ${scrollRounds} 轮滚动`);
  return success({
    inserted: totalInserted,
    duplicateCount: totalDuplicateCount, enriched: totalEnrichedCount,
    ambiguousCount: totalAmbiguousCount,
    profileResolved: totalProfileResolved, profileUnresolved: totalProfileUnresolved,
    parseFailed: parseFailedCount,
    scrollRounds,
    workCommentsInserted: totalWorkCommentInserted,
    workCommentsEnriched: totalWorkCommentEnriched,
    workCommentsDuplicate: totalWorkCommentDuplicate,
    pendingReplyFile,
    pendingVisitFile,
    events: allEvents,
    ambiguousEvents,
    failedEvents,
    step: 'notify-scan',
  });
}

async function main() {
  const { options, remaining } = parseCommonArgs(process.argv.slice(2));

  const typeIdx = remaining.indexOf('--type');
  const type = typeIdx >= 0 ? remaining[typeIdx + 1] : 'all';
  const pauseIdx = remaining.indexOf('--pause-after-open');
  const pauseAfterOpen = pauseIdx >= 0 ? parseInt(remaining[pauseIdx + 1], 10) || 0 : 0;
  const debugNotificationDom = remaining.includes('--debug-notification-dom');
  const maxCountIdx = remaining.indexOf('--max-count');
  const maxCount = maxCountIdx >= 0 ? Math.max(1, parseInt(remaining[maxCountIdx + 1], 10) || 1) : 100;
  const collectTypesIdx = remaining.indexOf('--collect-types');
  const collectTypes = collectTypesIdx >= 0 && remaining[collectTypesIdx + 1]
    ? remaining[collectTypesIdx + 1].split(',').map(type => type.trim()).filter(Boolean)
    : ['like', 'comment', 'reply', 'follow'];
  const displayOnly = remaining.includes('--display-only');
  const explicitReplyJson = remaining.includes('--generate-reply-json');
  const explicitVisitJson = remaining.includes('--generate-visit-json');
  const scanPlan = {
    maxCount,
    collectTypes,
    generateReplyJson: displayOnly ? false : (explicitReplyJson || (!explicitVisitJson && !displayOnly)),
    generateVisitJson: displayOnly ? false : explicitVisitJson,
  };
  const validTypes = ['all', 'comment', 'like', 'reply', 'follow'];
  if (!validTypes.includes(type)) {
    if (options.json) {
      printJsonError('interactions:scan', RESULT_CODES.BLOCKED,
        `Invalid --type: ${type}. Must be one of: ${validTypes.join(', ')}`, { recoverable: false });
    } else {
      console.error(`Invalid --type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    }
    process.exit(1);
  }

  logger.setLevel(options.debug ? 'DEBUG' : 'INFO');
  runMigrations();

  const run = createRunContext('scan-interactions', options);

  let browser = null;
  let page = null;

  try {
    console.error('[scan] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // --- Notification scanning phase (ONLY interaction entry point) ---
    // All new interaction collection flows through the notification center.
    // runCommentScan() is preserved only for reply execution positioning,
    // NOT for new event collection.
    const notifResult = await runPhaseWithRecovery(page, run, 'notification', () => runNotificationScan(page, run, type, pauseAfterOpen, debugNotificationDom, scanPlan), options);
    if (!notifResult.ok) {
      if (options.json) {
        printJsonError('interactions:scan', notifResult.code || RESULT_CODES.BLOCKED,
          notifResult.message || '通知扫描失败', { recoverable: notifResult.recoverable !== false }); return;
      }
      return;
    }
    if (notifResult.action === 'quit-close' || notifResult.action === 'quit-keep-open') return;

    console.error('');
    console.error('[scan] ====== 扫描完成 ======');
    const counts = getEventCounts();
    for (const row of counts) {
      console.error(`[scan] ${row.event_type}/${row.status}: ${row.count}`);
    }

    // --json output for agent consumption
    if (options.json) {
      const notifData = notifResult.data || {};
      printJsonResult('interactions:scan', {
        events: notifData.events || [],
        failedEvents: notifData.failedEvents || [],
        ambiguousEvents: notifData.ambiguousEvents || [],
        counts,
        pendingReplyFile: notifData.pendingReplyFile || null,
        pendingVisitFile: notifData.pendingVisitFile || null,
      }, {
        totalScanned: run.scanned,
        inserted: notifData.inserted || 0,
        duplicates: notifData.duplicateCount || 0,
        enriched: run.enriched || 0,
        ambiguous: notifData.ambiguousCount || 0,
        parseFailed: notifData.parseFailed || 0,
        profileResolved: notifData.profileResolved || 0,
        profileUnresolved: notifData.profileUnresolved || 0,
        scrollRounds: notifData.scrollRounds || 0,
        source: 'notification',
        plan: scanPlan,
      });
    }

  } catch (err) {
    console.error('[scan] 未预期错误:', err.message);
    run.hadError = true;

    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir,
          step: 'unhandled-error',
          code: RESULT_CODES.UNKNOWN_ERROR,
          message: err.message,
          recoverable: false,
        });
        run.evidenceDirectories.push(evidenceDir);
      } catch {
        // evidence capture should not cause secondary crash
      }
    }

    // Structured JSON error on failure
    if (options.json) {
      printJsonError('interactions:scan', RESULT_CODES.UNKNOWN_ERROR,
        err.message, { recoverable: false, evidence: run.evidenceDirectories }); return;
    }

    process.exitCode = 1;
  } finally {
    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);

    if (browser && shouldClose) {
      console.error('[scan] 关闭浏览器...');
      await browser.close();
    } else if (browser) {
      console.error('[scan] 浏览器保持打开，供人工检查。手动关闭窗口或 Ctrl+C 退出。');
    }
  }
}

async function runPhaseWithRecovery(page, run, phaseName, phaseFn, options = {}) {
  let shouldRetry = true;

  while (shouldRetry) {
    const result = await phaseFn();

    if (result.ok) return result;

    run.hadBlocked = true;

    const evidenceData = { step: `${result.step || phaseName}`, code: result.code, message: result.message, recoverable: result.recoverable !== false };
    let evidenceDir;
    try {
      const evidenceResult = await captureEvidence(page, { outputDir: run.outputDir, ...evidenceData });
      evidenceDir = evidenceResult.evidenceDir;
    } catch {
      evidenceDir = run.outputDir;
    }

    run.evidenceDirectories.push(evidenceDir);

    // In --json mode, never show interactive prompts
    if (!run.options.pauseOnError || !evidenceData.recoverable || options.json) {
      return result;
    }

    const choice = await promptRecoveryAction(
      evidenceData.step, evidenceData.code, evidenceData.message, evidenceDir
    );

    switch (choice.action) {
      case 'retry':
        continue;
      case 'skip':
        console.error(`[scan]  跳过 ${phaseName}`);
        return { ...result, action: 'skipped' };
      case 'diagnose':
        try {
          await captureEvidence(page, {
            outputDir: run.outputDir,
            step: `${phaseName}-manual-diagnose`,
            code: result.code,
            message: 'User-requested diagnostic rescan',
            recoverable: true,
          });
          console.error('[scan]  诊断信息已保存。可以再次选择操作。');
        } catch (err) {
          console.error(`[scan]  诊断保存失败: ${err.message}`);
        }
        shouldRetry = true;
        break;
      case 'quit-close':
        console.error('[scan] 用户选择退出，关闭浏览器...');
        return { ...result, action: 'quit-close' };
      case 'quit-keep-open':
        console.error('[scan] 用户选择退出，浏览器保持打开。');
        return { ...result, action: 'quit-keep-open' };
      default:
        shouldRetry = true;
    }
  }
}

main().catch((err) => {
  console.error('[scan] 未捕获错误:', err.message);
  process.exit(1);
});
