import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureNotificationPageReady,
  openNotificationPanel,
  waitForNotificationPanelStable,
  moveMouseIntoPanel,
  closeNotificationPanel,
  extractVisibleNotifications,
  scrollPanelDown,
} from '../adapters/notification-page.mjs';
import {
  waitForWorkModal,
  extractWorkModalContext,
  findUnrepliedCommentsInModal,
  openReplyBoxByIndex,
  fillReplyInWorkModal,
  sendReplyInWorkModal,
  verifyReplyInWorkModal,
  detectVideoRemoved,
  parseDouyinTimeText,
} from '../adapters/work-modal-page.mjs';
import { clickNotificationWorkThumbnail } from '../adapters/work-context-page.mjs';
import { checkWorkOwner, getSelfProfile } from '../adapters/work-context-page.mjs';
import { generateReplyText } from '../domain/reply-template.mjs';
import { classifyNotificationAction } from '../domain/notification-action-router.mjs';
import { analyzeReturnVisitContext, generateReturnVisitComment } from '../services/return-visit-comment-generator.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { upsertNotificationEvent } from '../db/interaction-repository.mjs';
import { upsertWorkContext, findWorkByModalId, findWorkByWorkId, findWorkByThumbnailKey } from '../db/work-repository.mjs';
import { upsertWorkComment, listPendingCommentsGroupedByWork, listPreparedComments, markCommentReplyPrepared, markCommentReplied, markCommentSentUnverified, markCommentBlocked, markCommentSkipped, findCommentByActorAndText, listReplyTrackedCommentKeysForWork } from '../db/work-comment-repository.mjs';
import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import {
  RETURN_VISIT_STATUS,
  createOrUpdateReturnVisitTasksFromEvents,
  listReturnVisitPrepareTasks,
  listReturnVisitExecuteTasks,
  updateReturnVisitTask,
  markReturnVisitFailure,
  markReturnVisitDone,
} from '../services/return-visit-task-service.mjs';
import { collectCandidateWorkFromProfile } from '../services/return-visit-work-collector.mjs';
import { executeReturnVisitTask } from '../services/return-visit-executor.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

function recordAction(db, eventId, planId, targetTitle, targetUrl, actionText, actionType, status, reason, evidenceJson) {
  if (!eventId) return;
  const validStatuses = ['planned','prepared','approved','dry_run_ok','execute_confirmed','running','succeeded','failed','blocked','skipped','sent_unverified'];
  const safeStatus = validStatuses.includes(status) ? status : 'skipped';
  db.prepare(`
    INSERT INTO actions (event_id, plan_id, action_type, target_title, target_url, action_text, status, reason, evidence_json, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, planId, actionType || 'reply_comment', targetTitle, targetUrl, actionText, safeStatus, reason || null, evidenceJson || null, new Date().toISOString());
}

function updateEventWorkInfo(db, eventId, workId, workUrl, workTitle, rawPayloadJson) {
  const fields = [];
  const params = [];
  if (workId) { fields.push('target_work_id = ?'); params.push(workId); }
  if (workUrl) { fields.push('target_work_url = ?'); params.push(workUrl); }
  if (workTitle) { fields.push('my_work_title = ?'); params.push(workTitle); }
  if (rawPayloadJson) { fields.push('raw_payload_json = ?'); params.push(rawPayloadJson); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(eventId);
  db.prepare(`UPDATE interaction_events SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function normalizeNotificationWorkLookup(workId) {
  const id = (workId || '').trim();
  if (!id) return { workId: '', modalId: '' };
  if (id.startsWith('modal-')) return { workId: id, modalId: id.slice('modal-'.length) };
  if (id.startsWith('video-')) return { workId: id, modalId: id.slice('video-'.length) };
  if (id.startsWith('note-')) return { workId: id, modalId: id.slice('note-'.length) };
  return { workId: id, modalId: id };
}

async function replyToOneComment(page, comment, workCtx, db, run, options) {
  const r = {
    actorName: comment.actorName,
    commentText: comment.commentText,
    commentKey: comment.commentKey,
    commentDbId: comment.dbId || null,
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
  };

  if (run.processed >= run.options.maxItems) {
    r.reason = `已达到 maxItems ${run.options.maxItems}`;
    return r;
  }
  run.processed++;

  console.log(`[live]     回复: ${comment.actorName} "${comment.commentText.slice(0, 30)}"`);

  if (options.dryRun && !options.preview) {
    r.status = 'skipped';
    r.reason = 'dry-run 模式';
    r.code = RESULT_CODES.DRY_RUN_REQUIRED;
    console.log(`[live]     (dry-run) 将回复此评论`);
    return r;
  }

  const { replyText, reason: templateReason } = generateReplyText(comment.commentText);
  console.log(`[live]     生成回复: "${replyText}" (${templateReason})`);

  if (r.commentDbId) {
    markCommentReplyPrepared(r.commentDbId, replyText, `template:${templateReason}`);
  }

  r.step = 'open-reply-box';
  const openResult = await openReplyBoxByIndex(page, comment.commentIndex);
  if (!openResult.ok) {
    r.status = 'blocked';
    r.reason = `打开回复框失败: ${openResult.message}`;
    r.code = openResult.code;
    console.log(`[live]     ✗ ${r.reason}`);
    if (r.commentDbId) markCommentBlocked(r.commentDbId, r.reason);
    run.hadBlocked = true;
    return r;
  }

  r.step = 'send-reply';
  if (options.preview) {
    console.log(`[live]     [预演] 填入回复但不发送...`);
    const fillResult = await fillReplyInWorkModal(page, replyText);
    if (!fillResult.ok) {
      r.status = 'blocked';
      r.reason = `填入回复失败: ${fillResult.message}`;
      r.code = fillResult.code;
      console.log(`[live]     ✗ ${r.reason}`);
      if (r.commentDbId) markCommentBlocked(r.commentDbId, r.reason);
      run.hadBlocked = true;
      return r;
    }
    r.status = 'succeeded';
    r.reason = '预演：已填入回复，未发送';
    console.log(`[live]     ✓ [预演] 已填入: "${replyText.slice(0, 30)}"`);
    run.succeeded++;
    return r;
  }

  const sendResult = await sendReplyInWorkModal(page, replyText);
  if (!sendResult.ok) {
    r.status = 'blocked';
    r.reason = `发送失败: ${sendResult.message}`;
    r.code = sendResult.code;
    console.log(`[live]     ✗ ${r.reason}`);
    if (r.commentDbId) markCommentBlocked(r.commentDbId, r.reason);
    run.hadBlocked = true;
    return r;
  }

  r.step = 'verify-reply';
  const verifyResult = await verifyReplyInWorkModal(page, { actorName: comment.actorName, commentText: comment.commentText }, replyText);
  if (!verifyResult.ok) {
    r.status = 'sent_unverified';
    r.reason = verifyResult.message;
    r.code = verifyResult.code;
    console.log(`[live]     ⚠ 发送后未确认: ${verifyResult.message}`);
    if (r.commentDbId) markCommentSentUnverified(r.commentDbId, r.reason);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  r.reason = '回复成功';
  console.log(`[live]     ✓ 回复成功: "${replyText.slice(0, 30)}"`);

  if (r.commentDbId) markCommentReplied(r.commentDbId);
  run.succeeded++;

  return r;
}

async function processWorkModal(page, notification, db, run, options, state) {
  const r = {
    eventId: notification.eventId || 0,
    actorName: notification.username || '',
    commentText: notification.content || '',
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
    modalReplies: [],
  };

  const notifCommentKey = `${r.actorName}::${r.commentText.slice(0, 60)}`;
  if (state.repliedCommentKeys.has(notifCommentKey)) {
    r.status = 'skipped';
    r.reason = '此评论已回复过，跳过';
    console.log(`[live]   跳过已回复评论: ${r.actorName} "${r.commentText.slice(0, 30)}"`);
    return r;
  }

  // 终极前置去重：在点击缩略图进入视频 Modal 前，通过超链接中的作品 ID 或缩略图 Key 实施完美阻断
  if (notification.workId) {
    const lookup = normalizeNotificationWorkLookup(notification.workId);
    const existingWork = findWorkByModalId(lookup.modalId) || findWorkByWorkId(lookup.workId) || findWorkByWorkId(lookup.modalId);
    if (existingWork || state.visitedModalIds.has(lookup.modalId) || state.visitedModalIds.has(lookup.workId)) {
      r.status = 'skipped';
      r.reason = `作品已采集过 (workId=${notification.workId})`;
      console.log(`[live]   【前置排重拦截成功】检测到超链接作品ID已采集或已访问过，直接跳过点击缩略图: ${notification.workId}`);
      if (r.eventId) {
        const matched = existingWork || { work_id: lookup.workId, work_url: notification.workUrl, work_title: notification.workTitle };
        updateEventWorkInfo(db, r.eventId, matched.work_id || lookup.workId, matched.work_url, matched.work_title, null);
      }
      return r;
    }
  }

  if (notification.thumbnailKey) {
    const existingByThumbnail = findWorkByThumbnailKey(notification.thumbnailKey);
    if (existingByThumbnail || (state.visitedThumbnailKeys && state.visitedThumbnailKeys.has(notification.thumbnailKey))) {
      r.status = 'skipped';
      r.reason = `作品缩略图已采集过 (thumbnailKey)`;
      console.log(`[live]   【前置排重拦截成功】根据缩略图Key检测到已采集过，直接跳过点击: ${notification.thumbnailKey.slice(0, 60)}`);
      if (r.eventId && existingByThumbnail) {
        updateEventWorkInfo(db, r.eventId, existingByThumbnail.work_id, existingByThumbnail.work_url, existingByThumbnail.work_title, null);
      }
      return r;
    }
  }

  r.step = 'click-thumbnail';
  console.log(`[live]   点击通知缩略图 (target: ${notification.username})...`);
  const clickResult = await clickNotificationWorkThumbnail(page, {
    skipItemTexts: state.skippedThumbnailTexts,
    targetActorName: notification.username || '',
    targetContent: notification.content || '',
  });
  if (!clickResult.ok) {
    r.status = 'blocked';
    r.reason = `点击缩略图失败: ${clickResult.message || clickResult.code}`;
    r.code = clickResult.code || 'BLOCKED';
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  await page.waitForTimeout(2000);

  const earlyRemoved = await detectVideoRemoved(page);
  if (earlyRemoved) {
    r.status = 'skipped';
    r.reason = `作品已删除/不可见: ${earlyRemoved}`;
    console.log(`[live]   跳过: ${r.reason}`);
    if (clickResult.itemText) state.skippedThumbnailTexts.push(clickResult.itemText);
    if (r.eventId) recordAction(db, r.eventId, null, '', '', '', 'skip', 'skipped', r.reason, null);
    return r;
  }

  r.step = 'wait-modal';
  console.log(`[live]   等待作品 modal...`);
  const modalResult = await waitForWorkModal(page, { closeAutoPlay: false });
  if (!modalResult.ok) {
    if (modalResult.videoRemoved) {
      r.status = 'skipped';
      r.reason = `作品已删除/不可见: ${modalResult.message}`;
      console.log(`[live]   跳过: ${r.reason}`);
      if (clickResult.itemText) state.skippedThumbnailTexts.push(clickResult.itemText);
      if (r.eventId) recordAction(db, r.eventId, null, '', '', '', 'skip', 'skipped', r.reason, null);
      return r;
    }
    r.status = 'blocked';
    r.reason = `modal 未出现: ${modalResult.message}`;
    r.code = modalResult.code;
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  r.step = 'extract-context';
  const contextResult = await extractWorkModalContext(page);
  if (!contextResult.ok) {
    r.status = 'blocked';
    r.reason = `提取作品信息失败: ${contextResult.message}`;
    r.code = contextResult.code;
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  const workCtx = contextResult.data;
  workCtx.publishedAt = parseDouyinTimeText(workCtx.publishedAtText) || null;
  if (workCtx.publishedAtText) {
    console.log(`[live]   发布时间: "${workCtx.publishedAtText}" -> ${workCtx.publishedAt || '解析失败'}`);
  }
  console.log(`[live]   modalId=${workCtx.modalId} workType=${workCtx.workType} workTitle="${(workCtx.workTitle || '').slice(0, 40)}"`);

  // DB-based dedup: check works table
  const existingWork = findWorkByModalId(workCtx.modalId) || findWorkByWorkId(workCtx.workId);
  if (existingWork) {
    r.status = 'skipped';
    r.reason = `作品已采集过 (works.id=${existingWork.id})，跳过重复打开`;
    console.log(`[live]   跳过已采集作品`);
    return r;
  }
  if (state.visitedModalIds.has(workCtx.modalId)) {
    r.status = 'skipped';
    r.reason = `作品 ${workCtx.modalId} 本轮已访问过，跳过`;
    console.log(`[live]   跳过已访问作品`);
    return r;
  }
  state.visitedModalIds.add(workCtx.modalId);

  // Upsert works to DB
  const workUpsertResult = upsertWorkContext({
    workId: workCtx.workId,
    modalId: workCtx.modalId,
    workUrl: workCtx.workUrl,
    workTitle: workCtx.workTitle,
    workType: workCtx.workType,
    authorName: workCtx.authorName,
    authorProfileUrl: workCtx.authorProfileUrl,
    authorProfileKey: workCtx.authorProfileKey,
    publishedAt: workCtx.publishedAt || null,
    thumbnailKey: notification.thumbnailKey || null,
    thumbnailSrc: workCtx.thumbnailSrc || notification.thumbnailSrc || null,
    rawContextJson: JSON.stringify(workCtx),
  });
  console.log(`[live]   works表: ${workUpsertResult.action} id=${workUpsertResult.id}`);

  if (r.eventId) {
    const rawPayload = { workContextResolved: true, workContextResolveMethod: 'click_notification_thumbnail', workContext: workCtx };
    updateEventWorkInfo(db, r.eventId, workCtx.workId, workCtx.workUrl, workCtx.workTitle, JSON.stringify(rawPayload));
  }

  const selfProfile = getSelfProfile();
  const selfNickname = selfProfile.nickname || workCtx.authorName || '';

  if (workCtx.isOwnWorkByUrl) {
    console.log(`[live]   URL 含 /user/self，确认为 own 作品`);
  } else {
    const ownerResult = checkWorkOwner({
      authorProfileKey: workCtx.authorProfileKey || '',
      authorProfileUrl: workCtx.authorProfileUrl || '',
      authorName: workCtx.authorName || '',
    }, selfProfile);

    if (ownerResult.isOwnWork === false) {
      r.status = 'skipped';
      r.reason = `作品不属于当前账号 (${ownerResult.ownerCheckMethod})`;
      console.log(`[live]   跳过: ${r.reason}`);
      if (r.eventId) recordAction(db, r.eventId, null, workCtx.workTitle || '', workCtx.workUrl || '', '', 'skip', 'skipped', r.reason, null);
      return r;
    }

    if (ownerResult.isOwnWork === null) {
      const actionSuggestsOwn = notification.action?.includes('你的作品') || notification.action?.includes('你的评论');
      if (!actionSuggestsOwn) {
        r.status = 'skipped';
        r.reason = `无法确认作品归属，需要主人确认`;
        console.log(`[live]   跳过: ${r.reason}`);
        if (r.eventId) recordAction(db, r.eventId, null, workCtx.workTitle || '', workCtx.workUrl || '', '', 'skip', 'skipped', r.reason, null);
        return r;
      }
      console.log(`[live]   ⚠ 无法验证作品归属，但通知暗示为自身作品 (${notification.action})，继续执行`);
    }
  }

  r.step = 'scan-unreplied';
  console.log(`[live]   扫描未回复评论...`);
  const dbTrackedKeys = listReplyTrackedCommentKeysForWork({ workId: workCtx.workId, modalId: workCtx.modalId });
  const alreadyRepliedKeys = new Set([...state.repliedCommentKeys, ...dbTrackedKeys]);
  const scanResult = await findUnrepliedCommentsInModal(page, {
    alreadyRepliedKeys,
    selfNickname,
    maxAgeDays: options.days || null,
    oldCommentStopCount: 3,
  });
  if (!scanResult.ok) {
    r.status = 'blocked';
    r.reason = `扫描评论失败: ${scanResult.message}`;
    r.code = scanResult.code;
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  const unreplied = scanResult.data.unreplied;
  console.log(`[live]   总评论 ${scanResult.data.total} 条，未回复 ${unreplied.length} 条`);

  const scannedComments = (scanResult.data.comments || []).map(c => ({
    actorName: c.actorName || '',
    commentText: c.commentText || '',
    eventTimeText: c.eventTimeText || '',
    hasMyReply: !!c.hasMyReply,
    isSelfComment: !!c.isSelfComment,
    alreadyReplied: !!c.alreadyReplied,
  })).filter(c => c.commentText).slice(0, 30);

  if (scannedComments.length > 0) {
    upsertWorkContext({
      ...workCtx,
      publishedAt: workCtx.publishedAt || null,
      thumbnailKey: notification.thumbnailKey || null,
      thumbnailSrc: workCtx.thumbnailSrc || notification.thumbnailSrc || null,
      rawContextJson: JSON.stringify({
        ...workCtx,
        scannedComments,
        scannedCommentCount: scanResult.data.total,
      }),
    });
    console.log(`[live]   works表: 已补充作品评论上下文 ${scannedComments.length}/${scanResult.data.total} 条`);
  }

  // Upsert work_comments to DB
  let commentsUpserted = 0;
  let commentsDeduped = 0;
  for (const comment of unreplied) {
    const commentKey = `${comment.actorName}::${comment.commentText.slice(0, 80)}`;
    const existingComment = findCommentByActorAndText(comment.actorName || '', (comment.commentText || '').slice(0, 60));
    if (existingComment && ['pending', 'prepared', 'succeeded', 'sent_unverified'].includes(existingComment.reply_status)) {
      commentsDeduped++;
      continue;
    }
    const upsertResult = upsertWorkComment({
      workId: workCtx.workId,
      workUrl: workCtx.workUrl,
      modalId: workCtx.modalId,
      actorName: comment.actorName,
      actorProfileUrl: '',
      actorProfileKey: '',
      commentText: comment.commentText,
      eventTimeText: comment.eventTimeText || '',
      commentKey,
      sourceEventId: r.eventId || null,
      sourceNotificationKey: notification.notificationItemKey || null,
      rawCommentJson: JSON.stringify(comment),
    });
    if (upsertResult.action === 'inserted') commentsUpserted++;
    comment.dbId = upsertResult.id;
    comment.commentKey = commentKey;
  }
  console.log(`[live]   work_comments表: 新增 ${commentsUpserted} 条，数据库去重 ${commentsDeduped} 条`);

  if (notification.thumbnailKey && state.visitedThumbnailKeys) {
    state.visitedThumbnailKeys.add(notification.thumbnailKey);
  }

  r.status = 'succeeded';
  r.reason = `采集完成: ${scanResult.data.total} 条评论，${unreplied.length} 条待回复，${commentsUpserted} 条新入库`;
  console.log(`[live]   ✅ ${r.reason}`);
  return r;
}

function shouldSkipPendingComment(comment) {
  const text = (comment.comment_text || '').trim();
  const actor = (comment.actor_name || '').trim();
  if (!text) return 'empty_comment_text';
  if (text === '...' || actor === '...' || text === '作者') return 'invalid_comment_placeholder';
  return null;
}

function clampReplyText(replyText, maxLength) {
  const text = (replyText || '').trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function preparePendingReplies(options = {}) {
  const pendingGroups = listPendingCommentsGroupedByWork({ limit: options.prepareLimit || 100 });
  let totalPending = 0;
  for (const [, comments] of pendingGroups) totalPending += comments.length;

  const replyMode = options.aiReply || options.replyMode === 'ai' ? 'ai' : 'template';
  console.log(`[live] 第二阶段：生成回复内容 (${totalPending} 条 pending, ${pendingGroups.size} 个作品, mode=${replyMode})`);

  if (replyMode === 'ai') {
    console.log('[live]   AI 回复暂未接入本地实现，本轮降级为 template 生成');
  }

  let preparedCount = 0;
  let skippedCount = 0;

  for (const [workKey, comments] of pendingGroups) {
    const work = findWorkByWorkId(workKey) || findWorkByModalId(workKey);
    const workTitle = work?.work_title || '';
    console.log(`[live]   作品 ${workKey}: ${comments.length} 条待生成`);

    for (const comment of comments) {
      const skipReason = shouldSkipPendingComment(comment);
      if (skipReason) {
        markCommentSkipped(comment.id, skipReason);
        skippedCount++;
        continue;
      }

      const generated = generateReplyText(comment.comment_text, { workTitle });
      const replyText = clampReplyText(generated.replyText, options.replyMaxLength || 40);
      const reason = replyText === generated.replyText
        ? generated.reason
        : `${generated.reason};truncated_to_${options.replyMaxLength || 40}`;

      markCommentReplyPrepared(comment.id, replyText, reason);
      preparedCount++;
    }
  }

  console.log(`[live] 第二阶段完成：prepared ${preparedCount} 条，skipped ${skippedCount} 条`);
  return { preparedCount, skippedCount, totalPending };
}

function resolveWorkForComment(comment) {
  return findWorkByWorkId(comment.work_id) || findWorkByModalId(comment.modal_id);
}

function resolveWorkModalUrl(comment, work) {
  if (comment.work_url) return comment.work_url;
  if (work?.work_url) return work.work_url;
  if (work?.modal_id) return `https://www.douyin.com/user/self?modal_id=${work.modal_id}`;
  if (comment.modal_id) return `https://www.douyin.com/user/self?modal_id=${comment.modal_id}`;
  return null;
}

function findTargetScannedComment(unreplied, comment) {
  const actorName = (comment.actor_name || '').trim();
  const commentText = (comment.comment_text || '').trim();
  const prefix = commentText.slice(0, 20);

  if (!actorName || !prefix) return null;

  return unreplied.find(c => {
    if (actorName && c.actorName !== actorName) return false;
    return (c.commentText || '').includes(prefix);
  }) || null;
}

async function executePreparedReplies(page, db, run, options) {
  const preparedComments = listPreparedComments({ limit: options.maxItems || 10, days: options.days || null });
  console.log(`[live] 第三阶段：执行 prepared 回复 (${preparedComments.length} 条, maxItems=${options.maxItems})`);

  if (preparedComments.length === 0) {
    return [];
  }

  if (options.dryRun && !options.preview && !options.execute) {
    console.log('[live]   dry-run 模式：只展示待执行回复，不打开回复框');
    for (const comment of preparedComments.slice(0, 10)) {
      console.log(`[live]   将回复 ${comment.actor_name}: "${comment.comment_text?.slice(0, 30)}" -> "${comment.reply_text?.slice(0, 30)}"`);
    }
    return preparedComments.map(comment => ({
      phase: 'reply',
      commentId: comment.id,
      actorName: comment.actor_name,
      status: 'skipped',
      reason: 'dry-run',
    }));
  }

  const results = [];
  const selfProfile = getSelfProfile();
  const configuredSelfNickname = selfProfile.nickname || '';

  for (let i = 0; i < preparedComments.length; i++) {
    const comment = preparedComments[i];
    const result = {
      phase: 'reply',
      commentId: comment.id,
      eventId: comment.source_event_id || 0,
      actorName: comment.actor_name || '',
      status: 'blocked',
      reason: '',
    };

    console.log(`[live]   回复 ${i + 1}/${preparedComments.length}: ${comment.actor_name} "${comment.comment_text?.slice(0, 30)}"`);

    if (!comment.reply_text || !comment.reply_text.trim()) {
      result.status = 'skipped';
      result.reason = 'reply_text_empty';
      markCommentSkipped(comment.id, result.reason);
      results.push(result);
      continue;
    }

    const work = resolveWorkForComment(comment);
    const modalUrl = resolveWorkModalUrl(comment, work);
    if (!work || !modalUrl) {
      result.reason = 'work_or_modal_url_not_found';
      markCommentBlocked(comment.id, result.reason);
      recordAction(db, result.eventId, null, '', modalUrl || '', comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
      results.push(result);
      run.hadBlocked = true;
      continue;
    }

    try {
      console.log(`[live]     从采集作品地址打开: ${modalUrl}`);
      await page.goto(modalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      const removed = await detectVideoRemoved(page);
      if (removed) {
        result.reason = `video_removed:${removed}`;
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      const modalResult = await waitForWorkModal(page, { closeAutoPlay: true });
      if (!modalResult.ok) {
        result.reason = `modal_not_found:${modalResult.message}`;
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      const selfNickname = configuredSelfNickname || work.author_name || '';
      const scanResult = await findUnrepliedCommentsInModal(page, { selfNickname });
      if (!scanResult.ok) {
        result.reason = `scan_failed:${scanResult.message}`;
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      const targetComment = findTargetScannedComment(scanResult.data.unreplied, comment);
      if (!targetComment) {
        result.reason = 'comment_not_found_in_modal';
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      const openResult = await openReplyBoxByIndex(page, targetComment.commentIndex);
      if (!openResult.ok) {
        result.reason = `open_reply_box_failed:${openResult.message}`;
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      if (options.preview) {
        const fillResult = await fillReplyInWorkModal(page, comment.reply_text);
        if (!fillResult.ok) {
          result.reason = `fill_failed:${fillResult.message}`;
          markCommentBlocked(comment.id, result.reason);
          recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
          results.push(result);
          run.hadBlocked = true;
          continue;
        }
        result.status = 'succeeded';
        result.reason = 'preview_filled_not_sent';
        results.push(result);
        run.succeeded++;
        console.log(`[live]     ✓ [预演] 已填入，未发送`);
        continue;
      }

      const sendResult = await sendReplyInWorkModal(page, comment.reply_text);
      if (!sendResult.ok) {
        result.reason = `send_failed:${sendResult.message}`;
        markCommentBlocked(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      const verifyResult = await verifyReplyInWorkModal(page, { actorName: comment.actor_name, commentText: comment.comment_text }, comment.reply_text);
      if (!verifyResult.ok) {
        result.status = 'sent_unverified';
        result.reason = verifyResult.message;
        markCommentSentUnverified(comment.id, result.reason);
        recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'sent_unverified', result.reason, null);
        results.push(result);
        run.hadBlocked = true;
        continue;
      }

      result.status = 'succeeded';
      result.reason = 'reply_succeeded';
      markCommentReplied(comment.id);
      recordAction(db, result.eventId, null, work.work_title || '', modalUrl, comment.reply_text, 'reply_comment', 'succeeded', result.reason, null);
      results.push(result);
      run.succeeded++;
      console.log(`[live]     ✓ 回复成功`);
    } catch (err) {
      result.status = 'blocked';
      result.reason = err.message;
      markCommentBlocked(comment.id, result.reason);
      recordAction(db, result.eventId, null, '', modalUrl, comment.reply_text, 'reply_comment', 'blocked', result.reason, null);
      results.push(result);
      run.hadBlocked = true;
    }

    await page.waitForTimeout(1500);
  }

  return results;
}

async function processReturnVisitTasks(page, run, options) {
  const config = loadConfig().returnVisit || {};
  const maxItems = options.maxRevisits || options.maxItems || config.executeMaxItems || 1;
  const maxRetryCount = Number(config.maxRetryCount ?? 2);
  const maxWorksToCheck = Number(config.maxWorksToCheck ?? 3);
  const pageLoadRetryCount = Number(config.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(config.maxConsecutiveFailures ?? 3);
  const watchPolicy = config.watchPolicy || 'seconds';
  const watchSeconds = Array.isArray(config.watchSeconds) ? config.watchSeconds : [5, 8];

  const sourceSummary = createOrUpdateReturnVisitTasksFromEvents({
    limit: config.taskEventLimit || 500,
    status: config.eventSourceStatus || 'new',
  });
  console.log(`[live] 回访任务已同步: inserted=${sourceSummary.inserted} enriched=${sourceSummary.enriched} skipped=${sourceSummary.skipped}`);

  const prepareTasks = listReturnVisitPrepareTasks({ limit: maxItems, maxRetryCount });
  const revisitResults = [];
  let consecutiveFailures = 0;

  for (const task of prepareTasks) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      console.log(`[live] 回访准备连续失败 ${consecutiveFailures} 个任务，暂停本轮`);
      break;
    }

    const profileUrl = task.userProfileUrl || (task.userId ? `https://www.douyin.com/user/${task.userId}` : null);
    if (!profileUrl) {
      markReturnVisitFailure(task, { status: RETURN_VISIT_STATUS.FAILED_COLLECT, error: 'no_profile_url' });
      revisitResults.push({ actorName: task.userName, status: 'blocked', reason: 'no_profile_url', phase: 'revisit_prepare' });
      consecutiveFailures++;
      continue;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.COLLECTING_CONTENT,
      userProfileUrl: profileUrl,
      lastError: null,
    });

    const collected = await collectCandidateWorkFromProfile(page, profileUrl, {
      maxWorksToCheck,
      pageLoadRetryCount,
      maxReferenceComments: 5,
      validateWork: (work) => {
        const analysis = analyzeReturnVisitContext({
          workTitle: work.workTitle,
          workText: work.workText,
          contentSummary: work.contentSummary,
          referenceComments: work.referenceComments || [],
        });
        if (!analysis.workTitle && analysis.referenceComments.length === 0) {
          return { ok: false, reason: 'revisit_context_missing_work_and_comments' };
        }
        if (analysis.sceneSignals.length === 0) {
          return { ok: false, reason: 'revisit_context_no_scene_signal' };
        }
        return { ok: true };
      },
    });

    if (!collected.ok) {
      if (String(collected.status || '').startsWith('skipped_')) {
        updateReturnVisitTask(task.taskId, {
          status: collected.status,
          lastError: collected.reason || collected.status,
        });
        revisitResults.push({ actorName: task.userName, status: 'skipped', reason: collected.reason || collected.status, phase: 'revisit_prepare' });
        consecutiveFailures = 0;
      } else {
        markReturnVisitFailure(task, {
          status: RETURN_VISIT_STATUS.FAILED_COLLECT,
          error: collected.reason || 'collect_failed',
        });
        revisitResults.push({ actorName: task.userName, status: 'blocked', reason: collected.reason || 'collect_failed', phase: 'revisit_prepare' });
        consecutiveFailures++;
      }
      continue;
    }

    const selectedWork = collected.selectedWork;
    const generated = generateReturnVisitComment({
      workTitle: selectedWork.workTitle,
      workText: selectedWork.workText,
      contentSummary: selectedWork.contentSummary,
      referenceComments: selectedWork.referenceComments || [],
    });

    if (!generated.ok || !generated.comment) {
      const reason = generated.reason || 'generate_comment_failed';
      if (reason === 'content_too_short') {
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
          lastError: reason,
        });
        revisitResults.push({ actorName: task.userName, status: 'skipped', reason, phase: 'revisit_prepare' });
        consecutiveFailures = 0;
      } else {
        markReturnVisitFailure(task, {
          status: RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
          error: reason,
        });
        revisitResults.push({ actorName: task.userName, status: 'blocked', reason, phase: 'revisit_prepare' });
        consecutiveFailures++;
      }
      continue;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
      targetWork: {
        workId: selectedWork.workId,
        workUrl: selectedWork.workUrl,
        workTitle: selectedWork.workTitle,
        workText: selectedWork.workText,
        contentSummary: selectedWork.contentSummary,
        publishTime: selectedWork.publishTime,
      },
      referenceComments: selectedWork.referenceComments || [],
      likeStatus: selectedWork.likeState === 'already_liked' ? 'already_liked' : 'pending',
      commentStatus: 'generated',
      generatedComment: generated.comment,
      collectedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      lastError: null,
    });
    revisitResults.push({ actorName: task.userName, status: 'prepared', reason: selectedWork.workUrl, phase: 'revisit_prepare' });
    consecutiveFailures = 0;
  }

  const executeTasks = listReturnVisitExecuteTasks({ limit: maxItems, maxRetryCount });
  consecutiveFailures = 0;

  for (let i = 0; i < executeTasks.length; i++) {
    const task = executeTasks[i];
    if (consecutiveFailures >= maxConsecutiveFailures) {
      console.log(`[live] 回访执行连续失败 ${consecutiveFailures} 个任务，暂停本轮`);
      break;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.EXECUTING,
      lastError: null,
    });

    const result = await executeReturnVisitTask(page, task, {
      execute: !options.dryRun,
      pageLoadRetryCount,
      maxWorksToCheck,
      watchPolicy,
      watchSeconds,
    });

    if (result.resolvedWork) {
      updateReturnVisitTask(task.taskId, {
        targetWork: {
          workId: result.resolvedWork.workId,
          workUrl: result.resolvedWork.workUrl,
          workTitle: result.resolvedWork.workTitle,
          workText: result.resolvedWork.workText,
          contentSummary: result.resolvedWork.contentSummary,
          publishTime: result.resolvedWork.publishTime,
        },
        referenceComments: result.resolvedWork.referenceComments || [],
      });
    }

    if (result.ok && result.status === RETURN_VISIT_STATUS.DONE) {
      markReturnVisitDone(task, {
        likeStatus: result.likeStatus,
        commentStatus: result.commentStatus,
      });
      revisitResults.push({ actorName: task.userName, status: 'succeeded', reason: `${result.likeStatus}+${result.commentStatus}`, phase: 'revisit_execute' });
      run.succeeded++;
      consecutiveFailures = 0;
    } else if (result.ok && result.dryRun) {
      updateReturnVisitTask(task.taskId, {
        status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
        likeStatus: result.likeStatus,
        commentStatus: result.commentStatus,
      });
      revisitResults.push({ actorName: task.userName, status: 'skipped', reason: 'dry-run', phase: 'revisit_execute' });
      consecutiveFailures = 0;
    } else if (!result.ok && String(result.status || '').startsWith('skipped_')) {
      updateReturnVisitTask(task.taskId, {
        status: result.status,
        likeStatus: result.likeStatus || task.likeStatus,
        commentStatus: result.commentStatus || task.commentStatus,
        lastError: result.error || result.status,
      });
      revisitResults.push({ actorName: task.userName, status: 'skipped', reason: result.error || result.status, phase: 'revisit_execute' });
      consecutiveFailures = 0;
    } else {
      markReturnVisitFailure(task, {
        status: result.status || RETURN_VISIT_STATUS.FAILED,
        error: result.error || 'execute_failed',
        likeStatus: result.likeStatus || task.likeStatus,
        commentStatus: result.commentStatus || task.commentStatus,
      });
      revisitResults.push({ actorName: task.userName, status: 'blocked', reason: result.error || result.status || 'execute_failed', phase: 'revisit_execute' });
      consecutiveFailures++;
    }
  }

  return revisitResults;
}

async function returnToNotificationPanel(page) {
  await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  const reopened = await openNotificationPanel(page);
  if (!reopened) {
    console.error('[live] 返回通知面板失败');
    return false;
  }

  const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
  if (!stable || empty) {
    console.error('[live] 通知面板未稳定或为空');
    return false;
  }

  await moveMouseIntoPanel(page, panelBox);
  return true;
}

function routeNotification(n) {
  return classifyNotificationAction(n.rawText || `${n.username || ''}\n${n.content || ''}\n${n.action || ''}`);
}

function isTimeTextOlderThanDays(timeText, days) {
  if (!days || !timeText) return false;
  const parsed = parseDouyinTimeText(timeText);
  if (!parsed) return false;
  return new Date(parsed).getTime() < Date.now() - days * 86400000;
}

async function main() {
  console.error('[interactions:live] 主流程：通知扫描入库 -> 生成回复 -> 执行回复 -> 统一回访');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const collectOnly = commonArgs.remaining.includes('--collect-only');
  commonArgs.options.writeEvidenceFiles = commonArgs.remaining.includes('--write-evidence');
  if (commonArgs.options.writeEvidenceFiles) {
    commonArgs.options.writeRunFiles = true;
  }
  const run = createRunContext('interactions-live', commonArgs.options);

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];

  const state = {
    visitedModalIds: new Set(),
    visitedThumbnailKeys: new Set(),
    repliedCommentKeys: new Set(),
    skippedThumbnailTexts: [],
  };

  const revisitCandidates = null; // no longer using in-memory Map

  try {
    console.error('[live] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    console.error('[live] 打开通知页...');
    await ensureNotificationPageReady(page);

    const opened = await openNotificationPanel(page);
    if (!opened) {
      console.error('[live] 无法打开通知面板');
      process.exit(1);
    }

    const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
    if (!stable || empty) {
      console.error('[live] 通知面板未稳定或为空');
      process.exit(1);
    }

    await moveMouseIntoPanel(page, panelBox);
    console.error('[live] 通知面板已就绪');

    const modeLabel = commonArgs.options.preview ? 'preview(预演)' : (commonArgs.options.dryRun ? 'dry-run' : 'execute');
    console.log(`[live] 模式: ${modeLabel}${commonArgs.options.noRevisit ? ' + no-revisit' : ''}`);
    console.log(`[live] 第一阶段：通知页扫描与入库`);

    const seenNotifKeys = new Set();
    const maxScrollRounds = commonArgs.options.maxScrollRounds || 5;
    const maxNotifications = commonArgs.options.maxNotifications || 50;
    const notificationDays = commonArgs.options.days || null;
    let processedNotifications = 0;
    let openedWorkCount = 0;
    let phase1EndedReason = '';

    for (let scrollRound = 0; scrollRound < maxScrollRounds; scrollRound++) {
      const batchResult = await extractVisibleNotifications(page);
      if (!batchResult || !batchResult.ok) {
        console.error(`[live] 第 ${scrollRound + 1} 轮采集通知失败`);
        phase1EndedReason = '采集失败';
        break;
      }

      const notifications = batchResult.data.notifications || [];
      let newNotifs = notifications.filter(n => {
        const key = n.notificationItemKey || `${n.username}|${n.action}|${n.content}`;
        if (seenNotifKeys.has(key)) return false;
        seenNotifKeys.add(key);
        return true;
      });
      const remainingNotifications = Math.max(0, maxNotifications - processedNotifications);
      if (newNotifs.length > remainingNotifications) {
        newNotifs = newNotifs.slice(0, remainingNotifications);
      }
      processedNotifications += newNotifs.length;

      for (const n of newNotifs) {
        const route = routeNotification(n);
        n.route = route;
      }

      const relevantNotifs = newNotifs.filter(n => n.route?.notificationAction === 'comment_on_my_work' || n.route?.notificationAction === 'like_received');
      const oldRelevantNotifs = notificationDays
        ? relevantNotifs.filter(n => isTimeTextOlderThanDays(n.timeText || '', notificationDays))
        : [];
      if (notificationDays) {
        newNotifs = newNotifs.filter(n => {
          const action = n.route?.notificationAction;
          if (action !== 'comment_on_my_work' && action !== 'like_received') return true;
          return !isTimeTextOlderThanDays(n.timeText || '', notificationDays);
        });
      }

      for (const n of newNotifs) {
        const eventResult = upsertNotificationEvent({
          eventType: n.route.eventType === 'unknown' ? (n.eventType || 'comment') : n.route.eventType,
          actorName: n.username || '',
          actorProfileKey: n.actorProfileKey || '',
          actorProfileUrl: n.actorProfileUrl || '',
          relation: n.relation || 'unknown',
          commentText: n.content || '',
          eventTimeText: n.timeText || '',
          fingerprint: n.notificationItemKey || `${n.username}|${n.action}|${n.content}`,
          notificationItemKey: n.notificationItemKey || '',
          action: n.action || '',
          content: n.content || '',
          rawPayloadJson: JSON.stringify({ ...n, route: n.route }),
        });
        n.eventId = eventResult.eventId;
      }

      const commentNotifs = newNotifs.filter(n => n.route?.notificationAction === 'comment_on_my_work');
      const likeNotifs = newNotifs.filter(n => n.route?.notificationAction === 'like_received');
      const replyNotifs = newNotifs.filter(n => n.route?.notificationAction === 'reply_to_my_comment');
      const unknownNotifs = newNotifs.filter(n => n.route?.notificationAction === 'unknown');

      console.log(`[live] 第 ${scrollRound + 1} 轮: 通知 ${notifications.length} 条，新增 ${newNotifs.length} 条 (评论${commentNotifs.length} 点赞${likeNotifs.length} 回复${replyNotifs.length} 未知${unknownNotifs.length})`);
      if (notificationDays && oldRelevantNotifs.length > 0) {
        console.log(`[live]   跳过超过 ${notificationDays} 天的评论/点赞通知 ${oldRelevantNotifs.length} 条`);
      }

      for (const n of likeNotifs) {
        if (commonArgs.options.noRevisit) {
          console.log(`[live] noRevisit=true，点赞通知仅入库，不进入回访链路`);
        } else {
          console.log(`[live] 点赞通知：actor=${n.username} -> 已入 interaction_events，稍后走 return_visit_tasks 链路`);
        }
      }

      for (const n of replyNotifs) {
        console.log(`[live] 回复了我的评论：actor=${n.username} -> 跳过，需要主人确认`);
        recordAction(db, n.eventId, null, '', '', '', 'skip', 'skipped', n.route?.reason || 'reply_to_my_comment_requires_owner_review', null);
        results.push({ actorName: n.username, status: 'skipped', reason: 'reply_to_my_comment: 不回复，不加入回访列表' });
      }

      for (const n of unknownNotifs) {
        console.log(`[live] 未知通知类型：actor=${n.username} action="${n.action}" -> 跳过`);
        recordAction(db, n.eventId, null, '', '', '', 'skip', 'skipped', n.route?.reason || 'unknown_notification_requires_owner_review', null);
        results.push({ actorName: n.username, status: 'skipped', reason: 'unknown: 不处理，不加入回访列表' });
      }

      for (const n of commentNotifs) {
        const commentKey = `${(n.username || '')}::${(n.content || '').slice(0, 60)}`;
        if (state.repliedCommentKeys.has(commentKey)) {
          console.log(`[live]   跳过已回复通知: ${n.username} "${(n.content || '').slice(0, 30)}"`);
          continue;
        }

        const existingComment = findCommentByActorAndText(n.username || '', (n.content || '').slice(0, 60));
        if (existingComment) {
          console.log(`[live]   跳过已采集评论: ${n.username} "${(n.content || '').slice(0, 30)}" (status=${existingComment.reply_status})`);
          continue;
        }

        console.log(`[live] 评论通知：actor=${n.username} -> 进入 modal 回复`);
        const result = await processWorkModal(page, n, db, run, commonArgs.options, state);
        results.push(result);
        if (result.status === 'succeeded' || result.step === 'wait-modal' || result.step === 'extract-context' || result.step === 'scan-unreplied') {
          openedWorkCount++;
        }

        const backOk = await returnToNotificationPanel(page);
        if (!backOk) {
          console.error('[live] 无法返回通知面板，终止第一阶段');
          phase1EndedReason = '通知面板不可用';
          break;
        }

        if (openedWorkCount >= commonArgs.options.maxItems) {
          console.log(`[live] 已打开 ${openedWorkCount} 个作品采集评论，达到 maxItems=${commonArgs.options.maxItems}，停止打开更多通知作品`);
          phase1EndedReason = 'maxItems-opened-works';
          break;
        }
      }

      if (phase1EndedReason) break;

      if (notificationDays && relevantNotifs.length > 0 && relevantNotifs.length === oldRelevantNotifs.length) {
        console.log(`[live] 已遇到超过 ${notificationDays} 天的通知边界，停止继续滚动`);
        phase1EndedReason = 'days-window-ended';
        break;
      }

      if (processedNotifications >= maxNotifications) {
        console.log(`[live] 已达到 maxNotifications ${maxNotifications}`);
        phase1EndedReason = 'maxNotifications';
        break;
      }

      if (batchResult.data.noMoreData) {
        console.log(`[live] 没有更多通知`);
        phase1EndedReason = '没有更多通知';
        break;
      }

      if (scrollRound < maxScrollRounds - 1) {
        console.log(`[live] 滚动加载更多通知...`);
        const scrollResult = await scrollPanelDown(page);
        if (!scrollResult.scrolled || scrollResult.reachedBottom) {
          console.log(`[live] 无法继续滚动`);
          phase1EndedReason = '无法继续滚动';
          break;
        }
        await page.waitForTimeout(1500);
      }
    }

    if (!phase1EndedReason) phase1EndedReason = '滚动轮数上限';
    console.log(`[live] 通知页处理完成 (${phase1EndedReason})`);

    if (collectOnly) {
      console.log('[live] --collect-only：采集阶段完成，只入库，不生成回复、不执行回复、不回访');
      return;
    }

    const prepareSummary = preparePendingReplies(commonArgs.options);
    results.push({
      phase: 'prepare_replies',
      status: 'succeeded',
      reason: `prepared=${prepareSummary.preparedCount}, skipped=${prepareSummary.skippedCount}`,
    });

    const replyResults = await executePreparedReplies(page, db, run, commonArgs.options);
    results.push(...replyResults);

    if (commonArgs.options.noRevisit) {
      console.log(`[live] --no-revisit：跳过统一回访阶段`);
    } else {
      console.log(`[live] 第四阶段：统一回访开始 (return_visit_tasks)`);      
      const revisitResults = await processReturnVisitTasks(page, run, commonArgs.options);
      results.push(...revisitResults.map(r => ({ ...r, phase: r.phase || 'revisit' })));
      console.log(`[live] 统一回访完成`);
    }

  } catch (err) {
    console.error(`[live] 错误: ${err.message}`);
    run.hadError = true;
    process.exitCode = 1;
  } finally {
    const succeeded = results.filter(r => r.status === 'succeeded').length;
    const blocked = results.filter(r => r.status === 'blocked').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const sentUnverified = results.filter(r => r.status === 'sent_unverified').length;

    if (commonArgs.options.writeRunFiles) {
      const plansDir = path.resolve('data', 'plans');
      ensureDir(plansDir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultPath = path.join(plansDir, `live-result-${ts}.json`);
      writeJSON(resultPath, {
        mode: commonArgs.options.preview ? 'preview' : (commonArgs.options.dryRun ? 'dry-run' : 'execute'),
        results,
        summary: {
          total: results.length,
          succeeded,
          blocked,
          skipped,
          sentUnverified,
          maxItems: commonArgs.options.maxItems,
          visitedWorks: state.visitedModalIds.size,
          repliedComments: state.repliedCommentKeys.size,
          revisitCandidates: 'return_visit_tasks',
        },
      });
      console.log(`[live] 结果已保存: ${resultPath}`);
    }
    console.log(`[live] ${succeeded} 成功 / ${sentUnverified} 未确认 / ${blocked} 阻塞 / ${skipped} 跳过`);
    console.log(`[live] 访问作品 ${state.visitedModalIds.size} 个，回复评论 ${state.repliedCommentKeys.size} 条`);

    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) {
      await browser.close();
    } else if (browser) {
      console.log('[live] 浏览器保持打开，供人工检查。');
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
