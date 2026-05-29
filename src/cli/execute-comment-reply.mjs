// 评论回复执行命令（按 actionId 单条执行）
// 替代旧的手工传入 JSON 计划文件方式，直接通过 actionId 驱动执行。
// 强制校验审批状态链：approved → dry_run_ok → executed
//
// 用法：
//   npm run comments:execute -- --action-id <id> --dry-run --json
//   npm run comments:execute -- --action-id <id> --execute --max-items 1 --json

import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  openReplyBox,
  sendReply,
  selectWorkByTitle,
} from '../adapters/comment-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getActionWithEvent, updateActionStatus, hasSucceededAction } from '../db/action-repository.mjs';
import { updateEventStatus } from '../db/interaction-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { actionId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
  }
  return args;
}

function log(msg) {
  // All debug logs go to stderr so stdout stays clean for JSON
  console.error(msg);
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  // Validate action-id
  if (!cmdArgs.actionId) {
    printJsonError('comments:execute', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id', { recoverable: false });
    process.exit(1);
  }

  // Load action WITH associated event data (commentText, workTitle, actorName)
  const action = getActionWithEvent(cmdArgs.actionId);
  if (!action) {
    printJsonError('comments:execute', RESULT_CODES.BLOCKED,
      `找不到动作 ID=${cmdArgs.actionId}`, { recoverable: false });
    process.exit(1);
  }

  // --dry-run and --execute conflict
  if (commonArgs.options.dryRun && commonArgs.options.execute) {
    printJsonError('comments:execute', RESULT_CODES.BLOCKED,
      '--dry-run 与 --execute 不可同时使用', { recoverable: false });
    process.exit(1);
  }

  const isDryRun = commonArgs.options.dryRun && !commonArgs.options.execute;
  const isExecute = commonArgs.options.execute;

  // State machine enforcement
  if (isDryRun) {
    if (action.status !== 'approved') {
      printJsonError('comments:execute', RESULT_CODES.ACTION_NOT_APPROVED,
        `dry-run 要求动作状态为 approved，当前: ${action.status}`, { recoverable: false });
      process.exit(1);
    }
  }

  if (isExecute) {
    if (action.status !== 'dry_run_ok') {
      printJsonError('comments:execute', RESULT_CODES.BLOCKED,
        `真实发送要求先完成 dry-run（当前状态: ${action.status}）`, { recoverable: false });
      process.exit(1);
    }
  }

  // Validate comment text and reply text are available
  if (!action.commentText || action.commentText.trim().length === 0) {
    printJsonError('comments:execute', RESULT_CODES.BLOCKED,
      `无法获取原始评论内容（eventId=${action.eventId}），无法定位目标评论`, { recoverable: false });
    process.exit(1);
  }

  if (!action.actionText || action.actionText.trim().length === 0) {
    printJsonError('comments:execute', RESULT_CODES.EMPTY_REPLY_TEXT,
      '回复内容为空', { recoverable: false });
    process.exit(1);
  }

  // Check duplicate — never re-reply to same comment
  if (hasSucceededAction(action.eventId, 'reply_comment')) {
    printJsonError('comments:execute', RESULT_CODES.DUPLICATE_ACTION,
      '该评论已有成功回复记录', { recoverable: false });
    process.exit(1);
  }

  const run = createRunContext('comment-execute', commonArgs.options);
  let browser = null;
  let page = null;

  try {
    const ctx = await createBrowserContext({ headless: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // Navigate to comment management page
    const navResult = await ensureCommentPageReady(page);
    if (!navResult.ok) {
      await updateActionStatus(action.actionId, 'blocked', navResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      printJsonError('comments:execute', navResult.code, navResult.message, { recoverable: true });
      run.hadBlocked = true;
      return;
    }

    // P0-2: Select the work — check result, block on failure
    if (action.workTitle) {
      log(`[execute] 选择作品: ${action.workTitle}`);
      const selectResult = await selectWorkByTitle(page, action.workTitle);

      if (!selectResult.ok) {
        await updateActionStatus(action.actionId, 'blocked', selectResult.message);
        await updateEventStatus(action.eventId, 'blocked');
        printJsonError('comments:execute', selectResult.code, selectResult.message, { recoverable: true });
        run.hadBlocked = true;
        return;
      }
    }

    // Wait for comments area
    const areaResult = await waitForCommentsArea(page);
    if (!areaResult.ok) {
      await updateActionStatus(action.actionId, 'blocked', areaResult.message);
      await updateEventStatus(action.eventId, 'blocked');
      printJsonError('comments:execute', areaResult.code, areaResult.message, { recoverable: true });
      run.hadBlocked = true;
      return;
    }

    // P0-1 FIX: openReplyBox uses ORIGINAL comment text to locate the reply button
    log(`[execute] 定位原评论: "${action.commentText.slice(0, 40)}"`);
    const openResult = await openReplyBox(page, action.commentText);

    if (!openResult.ok) {
      await updateActionStatus(action.actionId, 'blocked', openResult.message);
      printJsonError('comments:execute', openResult.code, openResult.message, { recoverable: true });
      run.hadBlocked = true;
      return;
    }

    if (isDryRun) {
      // Dry-run: located the comment, opened the reply box — no send
      await updateActionStatus(action.actionId, 'dry_run_ok');
      printJsonResult('comments:execute', {
        actionId: action.actionId,
        mode: 'dry-run',
        status: 'dry_run_ok',
        actorName: action.actorName,
        commentText: action.commentText,
        replyText: action.actionText,
      }, { actionId: action.actionId });
      log('[execute] dry-run 成功：已定位到目标评论，未发送。');
    } else if (isExecute) {
      // P0-1 FIX: openReplyBox already called above.
      // Now sendReply fills the already-open input box and clicks send.
      log(`[execute] 发送回复: "${action.actionText.slice(0, 40)}"`);
      const sendResult = await sendReply(page, action.actionText);

      if (sendResult.ok) {
        await updateActionStatus(action.actionId, 'succeeded', null,
          JSON.stringify({ dryRunConfirmed: true, confirmedAt: new Date().toISOString() }));
        // P0-3: Sync event status so actions:pending no longer shows this
        await updateEventStatus(action.eventId, 'succeeded');
        printJsonResult('comments:execute', {
          actionId: action.actionId,
          mode: 'execute',
          status: 'succeeded',
          actorName: action.actorName,
          replyText: action.actionText.slice(0, 80),
        }, { executed: 1 });
        log('[execute] 已发送 1 条评论回复。');
      } else {
        await updateActionStatus(action.actionId, 'blocked', sendResult.message);
        await updateEventStatus(action.eventId, 'blocked');
        printJsonError('comments:execute', sendResult.code, sendResult.message, { recoverable: true });
        run.hadBlocked = true;
      }
    }
  } catch (err) {
    run.hadError = true;
    await updateActionStatus(action.actionId, 'blocked', err.message);
    await updateEventStatus(action.eventId, 'blocked');

    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir, step: 'execute-error',
          code: RESULT_CODES.UNKNOWN_ERROR, message: err.message, recoverable: false,
        });
        run.evidenceDirectories.push(evidenceDir);
      } catch { /* secondary failure */ }
    }

    printJsonError('comments:execute', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    process.exitCode = 1;
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) {
      await browser.close();
    } else if (browser) {
      log('[execute] 浏览器保持打开，供人工检查。');
    }
  }
}

main().catch((err) => {
  console.error('[execute] 未捕获错误:', err.message);
  process.exit(1);
});
