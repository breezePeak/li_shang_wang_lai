import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  openReplyBox,
  sendReply,
  getSelectedWorkTitle,
  selectWorkByTitle,
} from '../adapters/comment-page.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' && argv[i + 1]) { args.plan = argv[++i]; }
  }
  return args;
}

function validateItem(item) {
  if (item.approved !== true) {
    return blocking(RESULT_CODES.ACTION_NOT_APPROVED, '任务未审批', { recoverable: false });
  }
  if (!item.eventId) {
    return blocking(RESULT_CODES.BLOCKED, '任务缺少 eventId', { recoverable: false });
  }
  if (typeof item.replyText !== 'string' || item.replyText.trim().length === 0) {
    return blocking(RESULT_CODES.EMPTY_REPLY_TEXT, '回复内容为空，请在计划文件中填写 replyText', { recoverable: false, data: { actorName: item.actorName } });
  }
  return success();
}

function hasSucceededAction(db, eventId) {
  const row = db.prepare(
    "SELECT id FROM actions WHERE event_id = ? AND action_type = 'reply_comment' AND status = 'succeeded'"
  ).get(eventId);
  return !!row;
}

function recordAction(db, eventId, planId, targetTitle, actionText, status, reason, evidenceJson, screenshotPath) {
  db.prepare(`
    INSERT INTO actions (event_id, plan_id, action_type, target_title, action_text, status, reason, evidence_json, screenshot_path, executed_at)
    VALUES (?, ?, 'reply_comment', ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, planId, targetTitle, actionText, status, reason || null, evidenceJson || null, screenshotPath || null, new Date().toISOString());
}

function updateEventStatus(db, eventId, status) {
  db.prepare("UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), eventId);
}

async function executeOneItem(page, item, db, run, planId) {
  const r = {
    eventId: item.eventId,
    actorName: item.actorName,
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
  };

  // Validate
  const validResult = validateItem(item);
  if (!validResult.ok) {
    r.status = validResult.code === RESULT_CODES.ACTION_NOT_APPROVED ? 'skipped' : 'blocked';
    r.reason = validResult.message;
    r.code = validResult.code;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText || '', r.status, r.reason, null, null);
    return r;
  }

  // Check for duplicate
  if (hasSucceededAction(db, item.eventId)) {
    r.status = 'skipped';
    r.reason = '已成功回复过，跳过';
    r.code = RESULT_CODES.DUPLICATE_ACTION;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'skipped', r.reason, null, null);
    return r;
  }

  // Check maxItems
  if (run.executed >= run.options.maxItems) {
    r.status = 'skipped';
    r.reason = `已达到本轮最大执行数量 ${run.options.maxItems}`;
    r.code = RESULT_CODES.MAX_ITEMS_REACHED;
    return r;
  }

  console.log(`\n[reply] 处理: ${item.actorName} "${item.commentText.slice(0, 40)}"`);

  // Select the correct work first
  if (item.workTitle) {
    const selectResult = await selectWorkByTitle(page, item.workTitle);
    if (!selectResult.ok) {
      r.status = 'blocked';
      r.reason = `作品选择失败: ${selectResult.message}`;
      r.code = selectResult.code;
      r.step = 'select-work';
      console.log(`[reply]   ✗ [${selectResult.code}] ${selectResult.message}`);
      return r;
    }
  }

  console.log(`[reply]   DEBUG: dryRun=${run.options.dryRun} execute=${run.options.execute} replyText="${(item.replyText || '').slice(0, 20)}"`);

  // Dry-run: locate only
  if (run.options.dryRun) {
    r.step = 'dry-run-locate';
    const locateResult = await openReplyBox(page, item.commentText);
    if (locateResult.ok) {
      r.status = 'dry-run-ok';
      r.reason = 'dry-run 定位成功，未实际发送';
      console.log(`[reply]   ✓ dry-run 定位成功`);
    } else {
      r.status = 'blocked';
      r.reason = locateResult.message;
      r.code = locateResult.code;
      console.log(`[reply]   ✗ [${locateResult.code}] ${locateResult.message}`);
    }
    return r;
  }

  // Step 1: Open the reply box for this comment
  r.step = 'open-reply-box';
  const openResult = await openReplyBox(page, item.commentText);
  if (!openResult.ok) {
    r.status = 'blocked';
    r.reason = `打开回复框失败: ${openResult.message}`;
    r.code = openResult.code;
    console.log(`[reply]   ✗ [${openResult.code}] ${openResult.message}`);
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', r.reason, null, null);
    run.hadBlocked = true;
    return r;
  }
  console.log(`[reply]   ✓ 回复框已打开`);

  // Step 2: send reply (adapter handles fill + click + confirm)
  r.step = 'execute-reply';
  const replyResult = await sendReply(page, item.replyText);
  if (!replyResult.ok) {
    r.status = 'blocked';
    r.reason = replyResult.message;
    r.code = replyResult.code;
    console.log(`[reply]   ✗ [${replyResult.code}] ${replyResult.message}`);
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', replyResult.message, null, null);
    run.hadBlocked = true;
    return r;
  }

  // Success
  r.status = 'succeeded';
  console.log(`[reply]   ✓ 回复成功`);

  // Record action in DB
  try {
    const titleResult = await getSelectedWorkTitle(page);
    const workTitle = titleResult.ok ? (titleResult.data?.title || '') : item.workTitle || '';
    recordAction(db, item.eventId, planId, workTitle, item.replyText, 'succeeded', null, null, null);
    updateEventStatus(db, item.eventId, 'succeeded');
    run.executed++;
    run.succeeded++;
  } catch (err) {
    console.log(`[reply]   动作记录写入失败: ${err.message}`);
  }

  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  console.log(`[reply] argv: ${process.argv.slice(2).join(' ')}`);
  console.log(`[reply] parsed: dryRun=${commonArgs.options.dryRun} execute=${commonArgs.options.execute}`);

  if (!cmdArgs.plan) {
    console.error('用法: npm run comments:reply -- --plan <计划文件路径> [--dry-run|--execute] [--max-items N] [--keep-open/--keep-open-on-error/--pause-on-error]');
    process.exit(1);
  }

  if (!existsSync(cmdArgs.plan)) {
    console.error(`计划文件不存在: ${cmdArgs.plan}`);
    process.exit(1);
  }

  const run = createRunContext('comments-reply', commonArgs.options);

  const plan = JSON.parse(readFileSync(cmdArgs.plan, 'utf8'));
  const planId = plan.planId || null;
  const approvedItems = (plan.items || []).filter(i => i.approved === true);

  if (approvedItems.length === 0) {
    console.log('[reply] 计划中没有 approved: true 的评论，无需执行。');
    process.exit(0);
  }

  // Always keep browser open so user can verify results
  commonArgs.options.keepOpen = true;

  const actionMode = commonArgs.options.execute ? 'execute' : 'dry-run';
  console.log(`[reply] 模式: ${actionMode}`);
  console.log(`[reply] ~ ${approvedItems.length} 条待处理, 最大执行 ${commonArgs.options.maxItems} 条`);

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];
  let successCount = 0;
  let skipCount = 0;
  let blockedCount = 0;

  try {
    console.log('[reply] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    console.log('[reply] 导航到评论管理页...');
    const navResult = await ensureCommentPageReady(page);
    if (!navResult.ok) {
      console.log(`[reply] 导航失败: [${navResult.code}] ${navResult.message}`);
      run.hadBlocked = true;
    } else {
      const areaResult = await waitForCommentsArea(page);
      if (!areaResult.ok) {
        console.log(`[reply] 评论区域检测: [${areaResult.code}] ${areaResult.message}`);
        run.hadBlocked = true;
      }
    }

    for (let i = 0; i < approvedItems.length; i++) {
      const result = await executeOneItem(page, approvedItems[i], db, run, planId);
      results.push(result);

      if (result.status === 'succeeded') successCount++;
      else if (result.status === 'skipped') skipCount++;
      else if (result.status === 'blocked') {
        blockedCount++;
        run.hadBlocked = true;
      }

      // Stop if we hit max items
      if (commonArgs.options.execute && run.executed >= commonArgs.options.maxItems) {
        console.log(`[reply] 已达到本轮最大执行数量 ${commonArgs.options.maxItems}, 停止。`);
        break;
      }

      if (i < approvedItems.length - 1) await page.waitForTimeout(1000);
    }

  } catch (err) {
    console.error('[reply] 错误:', err.message);
    run.hadError = true;

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
      } catch {
        // non-fatal
      }
    }

    process.exitCode = 1;
  } finally {
    // Write results BEFORE deciding browser lifecycle
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `reply-result-${ts}.json`);
    writeJSON(resultPath, {
      plan: cmdArgs.plan,
      mode: actionMode,
      results,
      summary: {
        total: approvedItems.length,
        succeeded: successCount,
        skipped: skipCount,
        blocked: blockedCount,
        maxItems: commonArgs.options.maxItems,
      },
    });
    console.log(`[reply] 结果已保存: ${resultPath}`);
    console.log(`[reply] ${successCount} 成功 / ${blockedCount} 阻塞 / ${skipCount} 跳过 / ${approvedItems.length} 总计`);

    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);

    if (browser && shouldClose) {
      console.log('[reply] 关闭浏览器...');
      await browser.close();
    } else if (browser) {
      console.log('[reply] 浏览器保持打开，供人工检查。手动关闭窗口或 Ctrl+C 退出。');
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
