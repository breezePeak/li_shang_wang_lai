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
  sendReplyInWorkModal,
  verifyReplyInWorkModal,
} from '../adapters/work-modal-page.mjs';
import { clickNotificationWorkThumbnail } from '../adapters/work-context-page.mjs';
import { checkWorkOwner, getSelfProfile } from '../adapters/work-context-page.mjs';
import { generateReplyText } from '../domain/reply-template.mjs';
import { upsertNotificationEvent } from '../db/interaction-repository.mjs';
import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

function recordAction(db, eventId, planId, targetTitle, targetUrl, actionText, status, reason, evidenceJson) {
  db.prepare(`
    INSERT INTO actions (event_id, plan_id, action_type, target_title, target_url, action_text, status, reason, evidence_json, executed_at)
    VALUES (?, ?, 'reply_comment', ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, planId, targetTitle, targetUrl, actionText, status, reason || null, evidenceJson || null, new Date().toISOString());
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

function updateEventStatus(db, eventId, status) {
  db.prepare("UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), eventId);
}

async function replyToOneComment(page, comment, workCtx, db, run, options) {
  const r = {
    actorName: comment.actorName,
    commentText: comment.commentText,
    commentKey: comment.commentKey,
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

  if (options.dryRun) {
    r.status = 'skipped';
    r.reason = 'dry-run 模式';
    r.code = RESULT_CODES.DRY_RUN_REQUIRED;
    console.log(`[live]     (dry-run) 将回复此评论`);
    return r;
  }

  const { replyText, reason: templateReason } = generateReplyText(comment.commentText);
  console.log(`[live]     生成回复: "${replyText}" (${templateReason})`);

  r.step = 'open-reply-box';
  const openResult = await openReplyBoxByIndex(page, comment.commentIndex);
  if (!openResult.ok) {
    r.status = 'blocked';
    r.reason = `打开回复框失败: ${openResult.message}`;
    r.code = openResult.code;
    console.log(`[live]     ✗ ${r.reason}`);
    recordAction(db, 0, null, workCtx.workTitle || '', workCtx.workUrl || '', replyText, 'blocked', r.reason, null);
    run.hadBlocked = true;
    return r;
  }

  r.step = 'send-reply';
  const sendResult = await sendReplyInWorkModal(page, replyText);
  if (!sendResult.ok) {
    r.status = 'blocked';
    r.reason = `发送失败: ${sendResult.message}`;
    r.code = sendResult.code;
    console.log(`[live]     ✗ ${r.reason}`);
    recordAction(db, 0, null, workCtx.workTitle || '', workCtx.workUrl || '', replyText, 'blocked', r.reason, null);
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
    recordAction(db, 0, null, workCtx.workTitle || '', workCtx.workUrl || '', replyText, 'sent_unverified', verifyResult.message, null);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  r.reason = '回复成功';
  console.log(`[live]     ✓ 回复成功: "${replyText.slice(0, 30)}"`);

  recordAction(db, 0, null, workCtx.workTitle || '', workCtx.workUrl || '', replyText, 'succeeded', null, null);
  run.succeeded++;

  return r;
}

async function processWorkModal(page, notification, db, run, options, state) {
  const r = {
    eventId: notification.eventId || 0,
    actorName: notification.actorName || notification.username || '',
    commentText: notification.commentText || notification.content || '',
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

  r.step = 'click-thumbnail';
  console.log(`[live]   点击通知缩略图...`);
  const clickResult = await clickNotificationWorkThumbnail(page);
  if (!clickResult.ok) {
    r.status = 'blocked';
    r.reason = `点击缩略图失败: ${clickResult.message || clickResult.code}`;
    r.code = clickResult.code || 'BLOCKED';
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  r.step = 'wait-modal';
  console.log(`[live]   等待作品 modal...`);
  const modalResult = await waitForWorkModal(page);
  if (!modalResult.ok) {
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
  console.log(`[live]   modalId=${workCtx.modalId} workType=${workCtx.workType} workTitle="${(workCtx.workTitle || '').slice(0, 40)}"`);

  if (state.visitedModalIds.has(workCtx.modalId)) {
    r.status = 'skipped';
    r.reason = `作品 ${workCtx.modalId} 已访问过，跳过`;
    console.log(`[live]   跳过已访问作品`);
    return r;
  }
  state.visitedModalIds.add(workCtx.modalId);

  if (r.eventId) {
    const rawPayload = { workContextResolved: true, workContextResolveMethod: 'click_notification_thumbnail', workContext: workCtx };
    updateEventWorkInfo(db, r.eventId, workCtx.workId, workCtx.workUrl, workCtx.workTitle, JSON.stringify(rawPayload));
  }

  const selfProfile = getSelfProfile();
  const ownerResult = checkWorkOwner({
    authorProfileKey: workCtx.authorProfileKey || '',
    authorProfileUrl: workCtx.authorProfileUrl || '',
    authorName: workCtx.authorName || '',
  }, selfProfile);

  if (ownerResult.isOwnWork === false) {
    r.status = 'skipped';
    r.reason = `作品不属于当前账号 (${ownerResult.ownerCheckMethod})`;
    console.log(`[live]   跳过: ${r.reason}`);
    if (r.eventId) recordAction(db, r.eventId, null, workCtx.workTitle || '', workCtx.workUrl || '', '', 'skipped', r.reason, null);
    return r;
  }

  if (ownerResult.isOwnWork === null) {
    const actionSuggestsOwn = notification.action?.includes('你的作品') || notification.action?.includes('你的评论');
    if (!actionSuggestsOwn) {
      r.status = 'skipped';
      r.reason = `无法确认作品归属，需要主人确认`;
      console.log(`[live]   跳过: ${r.reason}`);
      if (r.eventId) recordAction(db, r.eventId, null, workCtx.workTitle || '', workCtx.workUrl || '', '', 'skipped', r.reason, null);
      return r;
    }
    console.log(`[live]   ⚠ 无法验证作品归属，但通知暗示为自身作品 (${notification.action})，继续执行`);
  }

  r.step = 'scan-unreplied';
  console.log(`[live]   扫描未回复评论...`);
  const scanResult = await findUnrepliedCommentsInModal(page, { alreadyRepliedKeys: state.repliedCommentKeys });
  if (!scanResult.ok) {
    r.status = 'blocked';
    r.reason = `扫描评论失败: ${scanResult.message}`;
    r.code = scanResult.code;
    console.log(`[live]   ✗ ${r.reason}`);
    return r;
  }

  const unreplied = scanResult.data.unreplied;
  console.log(`[live]   总评论 ${scanResult.data.total} 条，未回复 ${unreplied.length} 条`);

  if (unreplied.length === 0) {
    r.status = 'skipped';
    r.reason = '没有未回复的评论';
    console.log(`[live]   无需回复`);
    return r;
  }

  if (options.dryRun) {
    r.status = 'skipped';
    r.reason = `dry-run 模式，将回复 ${unreplied.length} 条评论`;
    r.code = RESULT_CODES.DRY_RUN_REQUIRED;
    console.log(`[live]   (dry-run) 将回复 ${unreplied.length} 条评论`);
    return r;
  }

  for (const comment of unreplied) {
    if (run.processed >= run.options.maxItems) {
      console.log(`[live]   已达到 maxItems ${run.options.maxItems}`);
      break;
    }

    const replyResult = await replyToOneComment(page, comment, workCtx, db, run, options);
    r.modalReplies.push(replyResult);

    if (replyResult.status === 'succeeded' || replyResult.status === 'sent_unverified') {
      state.repliedCommentKeys.add(comment.commentKey);
    }

    await page.waitForTimeout(1500);
  }

  const succeededInModal = r.modalReplies.filter(x => x.status === 'succeeded').length;
  const blockedInModal = r.modalReplies.filter(x => x.status === 'blocked').length;
  const unverifiedInModal = r.modalReplies.filter(x => x.status === 'sent_unverified').length;

  if (succeededInModal > 0) {
    r.status = 'succeeded';
    r.reason = `作品内回复 ${succeededInModal} 条成功`;
    console.log(`[live]   ✅ 作品内回复完成: ${succeededInModal} 成功 / ${unverifiedInModal} 未确认 / ${blockedInModal} 阻塞`);
  } else if (unverifiedInModal > 0) {
    r.status = 'sent_unverified';
    r.reason = `${unverifiedInModal} 条未确认`;
  } else if (blockedInModal > 0) {
    r.status = 'blocked';
    r.reason = `${blockedInModal} 条阻塞`;
    run.hadBlocked = true;
  } else {
    r.status = 'skipped';
    r.reason = '无有效回复';
  }

  return r;
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

async function main() {
  console.error('[interactions:live] 当前链路：实时评论回复（通知 → modal → 批量回复未回复评论）');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const run = createRunContext('interactions-live', commonArgs.options);

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];

  const state = {
    visitedModalIds: new Set(),
    repliedCommentKeys: new Set(),
  };

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

    console.log(`[live] 模式: ${commonArgs.options.dryRun ? 'dry-run' : 'execute'}`);

    const seenNotifKeys = new Set();
    const maxScrollRounds = 5;

    for (let scrollRound = 0; scrollRound < maxScrollRounds; scrollRound++) {
      const batchResult = await extractVisibleNotifications(page);
      if (!batchResult || !batchResult.ok) {
        console.error(`[live] 第 ${scrollRound + 1} 轮采集通知失败`);
        break;
      }

      const notifications = batchResult.data.notifications || [];
      const newNotifs = notifications.filter(n => {
        const key = n.notificationItemKey || `${n.username}|${n.action}|${n.content}`;
        if (seenNotifKeys.has(key)) return false;
        seenNotifKeys.add(key);
        return true;
      });

      const commentNotifs = newNotifs.filter(n => n.eventType === 'comment');
      console.log(`[live] 第 ${scrollRound + 1} 轮: 通知 ${notifications.length} 条，新增 ${newNotifs.length} 条，评论 ${commentNotifs.length} 条`);

      for (const n of commentNotifs) {
        const commentKey = `${(n.username || '')}::${(n.content || '').slice(0, 60)}`;
        if (state.repliedCommentKeys.has(commentKey)) {
          console.log(`[live]   跳过已回复通知: ${n.username} "${(n.content || '').slice(0, 30)}"`);
          continue;
        }

        const result = await processWorkModal(page, n, db, run, commonArgs.options, state);
        results.push(result);

        if (run.processed >= commonArgs.options.maxItems) {
          console.log(`[live] 已达到 maxItems ${commonArgs.options.maxItems}`);
          break;
        }

        const backOk = await returnToNotificationPanel(page);
        if (!backOk) {
          console.error('[live] 无法返回通知面板，终止');
          break;
        }
      }

      if (run.processed >= commonArgs.options.maxItems) break;

      if (batchResult.data.noMoreData) {
        console.log(`[live] 没有更多通知`);
        break;
      }

      if (scrollRound < maxScrollRounds - 1) {
        console.log(`[live] 滚动加载更多通知...`);
        const scrollResult = await scrollPanelDown(page);
        if (!scrollResult.scrolled || scrollResult.reachedBottom) {
          console.log(`[live] 无法继续滚动`);
          break;
        }
        await page.waitForTimeout(1500);
      }
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
      mode: commonArgs.options.dryRun ? 'dry-run' : 'execute',
      results,
      summary: { total: results.length, succeeded, blocked, skipped, sentUnverified, maxItems: commonArgs.options.maxItems, visitedWorks: state.visitedModalIds.size, repliedComments: state.repliedCommentKeys.size },
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
