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
import { clickLike, postVideoComment } from '../adapters/video-page.mjs';
import { generateReplyText } from '../domain/reply-template.mjs';
import { classifyNotificationAction } from '../domain/notification-action-router.mjs';
import { generateReturnVisitComment } from '../services/return-visit-comment-generator.mjs';
import { upsertNotificationEvent } from '../db/interaction-repository.mjs';
import { upsertWorkContext, findWorkByModalId, findWorkByWorkId, findWorkByThumbnailKey } from '../db/work-repository.mjs';
import { upsertWorkComment, listPendingCommentsGroupedByWork, listPreparedComments, markCommentReplyPrepared, markCommentReplied, markCommentSentUnverified, markCommentBlocked, markCommentSkipped, findCommentByActorAndText } from '../db/work-comment-repository.mjs';
import { upsertRevisitCandidate, listPendingRevisitCandidates, markRevisitDone, markRevisitSkipped, markRevisitBlocked } from '../db/revisit-repository.mjs';
import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
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

function addRevisitCandidateDB(notification, reason) {
  const relation = notification.relation || 'unknown';
  if (relation !== 'friend' && relation !== 'mutual') {
    console.log(`[live]   跳过回访候选: ${notification.username || ''} relation=${relation}`);
    return { action: 'skipped', reason: 'non_friend_relation' };
  }

  const result = upsertRevisitCandidate({
    actorName: notification.username || '',
    actorProfileUrl: notification.actorProfileUrl || '',
    actorProfileKey: notification.actorProfileKey || '',
    eventId: notification.eventId || null,
    reason,
    rawText: notification.content || '',
  });
  return result;
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
  const scanResult = await findUnrepliedCommentsInModal(page, { alreadyRepliedKeys: state.repliedCommentKeys, selfNickname });
  if (!scanResult.ok) {
    r.status = 'blocked';
    r.reason = `扫描评论失败: ${scanResult.message}`;
    r.code = scanResult.code;
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  const unreplied = scanResult.data.unreplied;
  console.log(`[live]   总评论 ${scanResult.data.total} 条，未回复 ${unreplied.length} 条`);

  // Upsert work_comments to DB
  let commentsUpserted = 0;
  for (const comment of unreplied) {
    const commentKey = `${comment.actorName}::${comment.commentText.slice(0, 80)}`;
    const upsertResult = upsertWorkComment({
      workId: workCtx.workId,
      workUrl: workCtx.workUrl,
      modalId: workCtx.modalId,
      actorName: comment.actorName,
      actorProfileUrl: '',
      actorProfileKey: '',
      commentText: comment.commentText,
      eventTimeText: '',
      commentKey,
      sourceEventId: r.eventId || null,
      sourceNotificationKey: notification.notificationItemKey || null,
      rawCommentJson: JSON.stringify(comment),
    });
    if (upsertResult.action === 'inserted') commentsUpserted++;
    comment.dbId = upsertResult.id;
    comment.commentKey = commentKey;
  }
  console.log(`[live]   work_comments表: 新增 ${commentsUpserted} 条`);

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

async function processRevisitCandidates(page, revisitList, db, run, options) {
  const revisitResults = [];
  const profileSettleMs = Math.max(options.profileSettleMs || 0, 12000);
  const betweenRevisitMs = Math.max(options.revisitIntervalMs || 0, 8000);

  async function findFirstProfileWork() {
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const firstWork = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]');
        const candidates = [];
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const rect = link.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50 && rect.bottom > 0 && rect.top < window.innerHeight) {
            candidates.push({
              href: href.startsWith('http') ? href : `https://www.douyin.com${href}`,
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
            });
          }
        }
        candidates.sort((a, b) => a.top - b.top || a.left - b.left);
        return candidates[0] || null;
      });

      if (firstWork) return firstWork;

      console.log(`[live]   作品未出现，等待主页内容加载 (${attempt}/${attempts})...`);
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1200));
      await page.evaluate(() => window.scrollBy(0, Math.floor(260 + Math.random() * 180))).catch(() => {});
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    }
    return null;
  }

  async function extractRevisitWorkContext() {
    return await page.evaluate(() => {
      const workTitle =
        document.querySelector('[data-e2e="video-desc"]')?.innerText ||
        document.querySelector('[class*="title"]')?.innerText ||
        document.querySelector('h1')?.innerText ||
        document.title ||
        '';
      const workText = (document.body?.innerText || '').slice(0, 1200);
      const referenceComments = [];
      const commentItems = document.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"], [class*="commentItem"]');
      for (const item of commentItems) {
        const text = (item.innerText || '').trim();
        if (text && text.length < 120) referenceComments.push(text);
        if (referenceComments.length >= 8) break;
      }
      return {
        workTitle: workTitle.trim().slice(0, 160),
        workText,
        referenceComments,
      };
    });
  }

  for (let i = 0; i < revisitList.length; i++) {
    const candidate = revisitList[i];
    console.log(`[live] 回访 ${i + 1}/${revisitList.length} actor=${candidate.actor_name} key=${candidate.revisit_key}`);

    if (options.dryRun) {
      console.log(`[live]   (dry-run) 将回访 ${candidate.actor_name}`);
      revisitResults.push({ actorName: candidate.actor_name, status: 'skipped', reason: 'dry-run' });
      continue;
    }

    try {
      const profileUrl = candidate.actor_profile_url || (candidate.actor_profile_key ? `https://www.douyin.com/user/${candidate.actor_profile_key}` : null);
      if (!profileUrl) {
        console.log(`[live]   跳过：无主页 URL`);
        markRevisitSkipped(candidate.id, 'no_profile_url');
        revisitResults.push({ actorName: candidate.actor_name, status: 'skipped', reason: 'no_profile_url' });
        continue;
      }

      console.log(`[live]   打开主页: ${profileUrl}`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      console.log(`[live]   等待主页作品加载 ${Math.round(profileSettleMs / 1000)}s...`);
      await page.waitForTimeout(profileSettleMs);

      const firstWork = await findFirstProfileWork();

      if (!firstWork) {
        console.log(`[live]   未找到作品，跳过`);
        markRevisitSkipped(candidate.id, 'no_work_found');
        revisitResults.push({ actorName: candidate.actor_name, status: 'skipped', reason: 'no_work_found' });
        continue;
      }

      console.log(`[live]   打开最近作品...`);
      await page.mouse.click(firstWork.x, firstWork.y);
      await page.waitForTimeout(Math.min(Math.max(options.videoSettleMs || 0, 3000), 5000));
      const modalResult = await waitForWorkModal(page, { timeoutMs: 15000, closeAutoPlay: true });
      if (!modalResult.ok) {
        console.log(`[live]   作品评论区未就绪: ${modalResult.message}`);
        markRevisitBlocked(candidate.id, modalResult.message || 'work_modal_not_ready');
        revisitResults.push({ actorName: candidate.actor_name, status: 'blocked', reason: modalResult.message || 'work_modal_not_ready' });
        continue;
      }

      const likeResult = await clickLike(page, { execute: true });
      const likeOk = likeResult.ok || likeResult.code === RESULT_CODES.ALREADY_LIKED;
      const likeMethod = likeResult.ok ? 'click_like' : 'already_liked';
      if (!likeOk) {
        console.log(`[live]   点赞失败: ${likeResult.message}`);
        markRevisitBlocked(candidate.id, likeResult.message || 'like_failed');
        revisitResults.push({ actorName: candidate.actor_name, status: 'blocked', reason: likeResult.message || 'like_failed' });
        continue;
      }

      console.log(`[live]   点赞完成 (${likeMethod})`);
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));

      const workContext = await extractRevisitWorkContext();
      const generated = generateReturnVisitComment(workContext);
      if (!generated.ok || !generated.comment) {
        const reason = generated.reason || 'generate_comment_failed';
        console.log(`[live]   生成回访评论失败: ${reason}`);
        markRevisitBlocked(candidate.id, reason);
        revisitResults.push({ actorName: candidate.actor_name, status: 'blocked', reason });
        continue;
      }

      console.log(`[live]   发送回访评论: "${generated.comment}"`);
      const commentResult = await postVideoComment(page, generated.comment, { execute: true });
      if (!commentResult.ok) {
        console.log(`[live]   回访评论失败: ${commentResult.message}`);
        markRevisitBlocked(candidate.id, commentResult.message || 'comment_failed');
        revisitResults.push({ actorName: candidate.actor_name, status: 'blocked', reason: commentResult.message || 'comment_failed' });
        continue;
      }

      const commentReason = commentResult.data?.unconfirmed ? 'comment_sent_unconfirmed' : 'comment_posted';
      console.log(`[live]   回访完成: ${likeMethod} + ${commentReason}`);
      markRevisitDone(candidate.id);
      revisitResults.push({ actorName: candidate.actor_name, status: 'succeeded', reason: `${likeMethod}+${commentReason}` });
      run.succeeded++;

      await page.waitForTimeout(2000);
    } catch (err) {
      console.log(`[live]   回访异常: ${err.message}`);
      markRevisitBlocked(candidate.id, err.message);
      revisitResults.push({ actorName: candidate.actor_name, status: 'blocked', reason: err.message });
    } finally {
      if (i < revisitList.length - 1) {
        const delay = betweenRevisitMs + Math.floor(Math.random() * 4000);
        console.log(`[live]   回访间隔等待 ${Math.round(delay / 1000)}s，避免连续切换过快`);
        await page.waitForTimeout(delay);
      }
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

async function main() {
  console.error('[interactions:live] 主流程：通知扫描入库 -> 生成回复 -> 执行回复 -> 统一回访');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
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
        const eventResult = upsertNotificationEvent({
          eventType: route.eventType === 'unknown' ? (n.eventType || 'comment') : route.eventType,
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
          rawPayloadJson: JSON.stringify({ ...n, route }),
        });
        n.eventId = eventResult.eventId;
      }

      const commentNotifs = newNotifs.filter(n => n.route?.notificationAction === 'comment_on_my_work');
      const likeNotifs = newNotifs.filter(n => n.route?.notificationAction === 'like_received');
      const replyNotifs = newNotifs.filter(n => n.route?.notificationAction === 'reply_to_my_comment');
      const unknownNotifs = newNotifs.filter(n => n.route?.notificationAction === 'unknown');

      console.log(`[live] 第 ${scrollRound + 1} 轮: 通知 ${notifications.length} 条，新增 ${newNotifs.length} 条 (评论${commentNotifs.length} 点赞${likeNotifs.length} 回复${replyNotifs.length} 未知${unknownNotifs.length})`);

      for (const n of likeNotifs) {
        if (!commonArgs.options.noRevisit) {
          const revisitResult = addRevisitCandidateDB(n, 'like_received');
          if (revisitResult.action === 'skipped') {
            console.log(`[live] 点赞通知：actor=${n.username} -> 不加入回访候选 (${revisitResult.reason})`);
          } else {
            console.log(`[live] 点赞通知：actor=${n.username} -> 加入回访候选，稍后统一回访`);
          }
        } else {
          console.log(`[live] noRevisit=true，本轮不收集回访候选`);
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
        if (!commonArgs.options.noRevisit) {
          const revisitResult = addRevisitCandidateDB(n, 'comment_on_my_work');
          if (revisitResult.action === 'skipped') {
            console.log(`[live] 评论人不加入回访候选: actor=${n.username} (${revisitResult.reason})`);
          } else {
            console.log(`[live] 评论人加入回访候选: actor=${n.username}`);
          }
        }

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

    const prepareSummary = preparePendingReplies(commonArgs.options);
    results.push({
      phase: 'prepare_replies',
      status: 'succeeded',
      reason: `prepared=${prepareSummary.preparedCount}, skipped=${prepareSummary.skippedCount}`,
    });

    const replyResults = await executePreparedReplies(page, db, run, commonArgs.options);
    results.push(...replyResults);

    const revisitLimit = commonArgs.options.maxRevisits || commonArgs.options.maxItems || 1;
    const pendingRevisits = commonArgs.options.noRevisit ? [] : listPendingRevisitCandidates({ limit: revisitLimit });
    if (pendingRevisits.length > 0) {
      console.log(`[live] 第四阶段：统一回访开始 (${pendingRevisits.length} 人)`);
      const revisitResults = await processRevisitCandidates(page, pendingRevisits, db, run, commonArgs.options);
      results.push(...revisitResults.map(r => ({ ...r, phase: 'revisit' })));
      console.log(`[live] 统一回访完成`);
    } else if (commonArgs.options.noRevisit) {
      console.log(`[live] --no-revisit：跳过统一回访阶段`);
    } else {
      console.log(`[live] 无回访候选，跳过第四阶段`);
    }

  } catch (err) {
    console.error(`[live] 错误: ${err.message}`);
    run.hadError = true;
    process.exitCode = 1;
  } finally {
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `live-result-${ts}.json`);

    const succeeded = results.filter(r => r.status === 'succeeded').length;
    const blocked = results.filter(r => r.status === 'blocked').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const sentUnverified = results.filter(r => r.status === 'sent_unverified').length;

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
        revisitCandidates: listPendingRevisitCandidates({ limit: 1 }).length >= 0 ? 'see_db' : 0,
      },
    });

    console.log(`[live] 结果已保存: ${resultPath}`);
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
