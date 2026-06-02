import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  openReplyBox,
  sendReply,
  selectWorkByTitle,
} from '../adapters/comment-page.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { getAction, getActionWithEvent, updateActionStatus, hasSucceededAction } from '../db/action-repository.mjs';
import { getEvent, updateEventStatus } from '../db/interaction-repository.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function validateAction(action, { execute }) {
  if (action.status !== 'prepared') {
    return { ok: false, code: RESULT_CODES.ACTION_NOT_READY, message: `执行要求动作状态为 prepared，当前: ${action.status}` };
  }
  if (!action.commentText || action.commentText.trim().length === 0) {
    return { ok: false, code: RESULT_CODES.BLOCKED, message: `无法获取原始评论内容（eventId=${action.eventId}），无法定位目标评论` };
  }
  if (!action.actionText || action.actionText.trim().length === 0) {
    return { ok: false, code: RESULT_CODES.EMPTY_REPLY_TEXT, message: '回复内容为空' };
  }
  if (hasSucceededAction(action.eventId, 'reply_comment')) {
    return { ok: false, code: RESULT_CODES.DUPLICATE_ACTION, message: '该评论已有成功回复记录' };
  }

  const event = getEvent(action.eventId);
  if (event && event.status === 'unstable') {
    return { ok: false, code: RESULT_CODES.BLOCKED, message: `事件 #${action.eventId} 仍处于 unstable 状态，无法执行。` };
  }

  try {
    const fullAction = getAction(action.actionId);
    const evidence = fullAction?.evidence_json ? JSON.parse(fullAction.evidence_json) : {};
    if (evidence.autoExecuteAllowed === true && execute) {
      return { ok: false, code: RESULT_CODES.BLOCKED, message: 'autoExecuteAllowed 当前必须为 false，不允许自动真实发送。' };
    }
    if (execute) {
      if (evidence.decision && evidence.decision !== 'reply') {
        return { ok: false, code: RESULT_CODES.BLOCKED, message: `决策为 "${evidence.decision}"，不允许真实发送。` };
      }
      if (evidence.riskLevel && evidence.riskLevel !== 'low') {
        return { ok: false, code: RESULT_CODES.BLOCKED, message: `风险等级为 "${evidence.riskLevel}"，不允许真实发送。` };
      }
      if (evidence.relevance === 'irrelevant') {
        return { ok: false, code: RESULT_CODES.BLOCKED, message: '相关性为 irrelevant，不允许真实发送。' };
      }
      if (evidence.replyMode === 'ignore') {
        return { ok: false, code: RESULT_CODES.BLOCKED, message: 'replyMode=ignore 的评论不允许发送。' };
      }
    }
  } catch (err) {
    return { ok: false, code: RESULT_CODES.BLOCKED, message: `门禁检查异常: ${err.message}` };
  }

  return { ok: true };
}

export async function executePreparedReply(actionId, { execute = false, keepOpen = false, json = false } = {}) {
  const action = getActionWithEvent(actionId);
  if (!action) {
    return { ok: false, code: RESULT_CODES.BLOCKED, message: `找不到动作 ID=${actionId}`, actionId };
  }

  const validation = validateAction(action, { execute });
  if (!validation.ok) {
    return { ...validation, actionId: action.actionId };
  }

  if (!execute) {
    return {
      ok: true,
      actionId: action.actionId,
      mode: 'validate-only',
      status: 'prepared',
      actorName: action.actorName,
      commentText: action.commentText,
      replyText: action.actionText,
      browserOpened: false,
    };
  }

  const run = createRunContext('comment-execute', {
    debug: true,
    dryRun: false,
    execute: true,
    json,
    keepOpen,
    keepOpenOnError: !json,
    pauseOnError: !json,
    writeRunFiles: false,
    maxItems: 1,
  });
  let browser = null;
  let page = null;

  try {
    const ctx = await createBrowserContext({ headless: false, enableReuse: keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    const navResult = await ensureCommentPageReady(page);
    if (!navResult.ok) {
      run.hadBlocked = true;
      await updateActionStatus(action.actionId, 'blocked', navResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      return { ok: false, actionId: action.actionId, code: navResult.code, message: navResult.message, recoverable: true };
    }

    if (action.workTitle) {
      const selectResult = await selectWorkByTitle(page, action.workTitle);
      if (!selectResult.ok) {
        run.hadBlocked = true;
        await updateActionStatus(action.actionId, 'blocked', selectResult.message);
        await updateEventStatus(action.eventId, 'blocked');
        return { ok: false, actionId: action.actionId, code: selectResult.code, message: selectResult.message, recoverable: true };
      }
    }

    const areaResult = await waitForCommentsArea(page);
    if (!areaResult.ok) {
      run.hadBlocked = true;
      await updateActionStatus(action.actionId, 'blocked', areaResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      return { ok: false, actionId: action.actionId, code: areaResult.code, message: areaResult.message, recoverable: true };
    }

    const openResult = await openReplyBox(page, {
      commentText: action.commentText,
      actorName: action.actorName,
      eventTimeText: action.eventTimeText,
    });
    if (!openResult.ok) {
      run.hadBlocked = true;
      await updateActionStatus(action.actionId, 'blocked', openResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      return { ok: false, actionId: action.actionId, code: openResult.code, message: openResult.message, recoverable: true };
    }

    const sendResult = await sendReply(page, action.actionText);
    if (!sendResult.ok) {
      run.hadBlocked = true;
      await updateActionStatus(action.actionId, 'blocked', sendResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      return { ok: false, actionId: action.actionId, code: sendResult.code, message: sendResult.message, recoverable: true };
    }

    await updateActionStatus(action.actionId, 'succeeded', null, JSON.stringify({ executedBy: 'comments:execute' }));
    await updateEventStatus(action.eventId, 'succeeded');
    return {
      ok: true,
      actionId: action.actionId,
      mode: 'execute',
      status: 'succeeded',
      actorName: action.actorName,
      replyText: action.actionText.slice(0, 80),
    };
  } catch (err) {
    run.hadError = true;
    run.hadBlocked = true;
    await updateActionStatus(action.actionId, 'blocked', err.message);
    await updateEventStatus(action.eventId, 'blocked');
    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir,
          step: 'execute-error',
          code: RESULT_CODES.UNKNOWN_ERROR,
          message: err.message,
          recoverable: false,
        });
        run.evidenceDirectories.push(evidenceDir);
      } catch { /* secondary failure */ }
    }
    return { ok: false, actionId: action.actionId, code: RESULT_CODES.UNKNOWN_ERROR, message: err.message, recoverable: false };
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) {
      await browser.close();
    }
  }
}
