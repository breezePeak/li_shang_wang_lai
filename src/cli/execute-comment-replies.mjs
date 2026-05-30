import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  openReplyBoxForComment,
  sendReply,
  verifyReplyVisible,
  getSelectedWorkTitle,
  selectWorkByTitle,
} from '../adapters/comment-page.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
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

export function buildItemEvidenceData(item, step, resultOrError) {
  return {
    eventId: item.eventId,
    actorName: item.actorName,
    workTitle: item.workTitle ? String(item.workTitle).slice(0, 60) : '',
    workId: item.workId ? String(item.workId) : '',
    workUrl: item.workUrl ? String(item.workUrl).slice(0, 120) : '',
    commentText: item.commentText ? String(item.commentText).slice(0, 80) : '',
    replyText: item.replyText ? String(item.replyText).slice(0, 80) : '',
    step,
    code: resultOrError.code || '',
    message: (resultOrError.message || resultOrError.reason || '').slice(0, 200),
  };
}

async function captureItemEvidence(page, run, item, step, resultOrError) {
  try {
    const extra = buildItemEvidenceData(item, step, resultOrError);
    const code = resultOrError.code || RESULT_CODES.UNKNOWN_ERROR;
    const message = resultOrError.message || resultOrError.reason || '';

    const result = await captureEvidence(page, {
      outputDir: run.outputDir,
      step,
      code,
      message,
      recoverable: resultOrError.recoverable !== false,
      extra,
    });

    run.evidenceDirectories.push(result.evidenceDir);

    return {
      evidenceDir: result.evidenceDir,
      screenshotPath: result.screenshotPath,
      evidenceJson: result.evidenceInfo ? JSON.stringify(result.evidenceInfo) : null,
    };
  } catch (err) {
    console.warn(`[reply]     ⚠ 证据采集失败: ${err.message}`);
    return { evidenceDir: null, screenshotPath: null, evidenceJson: null };
  }
}

export function getWorkGroupKey(item) {
  const workId = (item.workId != null ? String(item.workId).trim() : '');
  const workUrl = (item.workUrl != null ? String(item.workUrl).trim() : '');
  const workTitle = (item.workTitle != null ? String(item.workTitle).trim() : '');
  if (workId) return `workId:${workId}`;
  if (workUrl) return `workUrl:${workUrl}`;
  if (workTitle) return `workTitle:${workTitle}`;
  return '__unknown_work__';
}

export function groupApprovedItemsByWork(items) {
  const groupMap = new Map();
  const groupOrder = [];

  for (const item of items) {
    const key = getWorkGroupKey(item);
    if (!groupMap.has(key)) {
      const group = {
        key,
        workTitle: (item.workTitle != null ? String(item.workTitle).trim() : '') || null,
        workId: (item.workId != null ? String(item.workId).trim() : '') || null,
        workUrl: (item.workUrl != null ? String(item.workUrl).trim() : '') || null,
        items: [],
      };
      groupMap.set(key, group);
      groupOrder.push(key);
    }
    const group = groupMap.get(key);
    group.items.push(item);
    if (!group.workTitle && item.workTitle) {
      group.workTitle = String(item.workTitle).trim();
    }
  }

  return groupOrder.map(key => groupMap.get(key));
}

async function selectWorkForGroup(page, group) {
  if (!group.workTitle) {
    return blocking(RESULT_CODES.BLOCKED, '作品缺少 workTitle，无法确认当前作品是否正确', { recoverable: false });
  }

  try {
    const currentTitle = await getSelectedWorkTitle(page);
    if (currentTitle.ok && currentTitle.data?.title === group.workTitle) {
      console.log(`[reply]   作品已选中: "${group.workTitle}"，跳过切换`);
      return success();
    }
  } catch {
    // fall through to select
  }

  console.log(`[reply]   切换作品: "${group.workTitle}"`);
  const selectResult = await selectWorkByTitle(page, group.workTitle);
  if (!selectResult.ok) return selectResult;

  try {
    const verifyTitle = await getSelectedWorkTitle(page);
    if (!verifyTitle.ok || verifyTitle.data?.title !== group.workTitle) {
      return blocking(RESULT_CODES.BLOCKED, `作品选择后校验失败: 选中标题 "${verifyTitle.data?.title || ''}" 不匹配 "${group.workTitle}"`, { recoverable: false });
    }
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `作品选择后校验异常: ${err.message}`, { recoverable: false });
  }

  return success();
}

async function executeOneItemInCurrentWork(page, item, db, run, planId) {
  const r = {
    eventId: item.eventId,
    actorName: item.actorName,
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
  };

  const validResult = validateItem(item);
  if (!validResult.ok) {
    r.status = validResult.code === RESULT_CODES.ACTION_NOT_APPROVED ? 'skipped' : 'blocked';
    r.reason = validResult.message;
    r.code = validResult.code;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText || '', r.status, r.reason, null, null);
    return r;
  }

  if (hasSucceededAction(db, item.eventId)) {
    r.status = 'skipped';
    r.reason = '已成功回复过，跳过';
    r.code = RESULT_CODES.DUPLICATE_ACTION;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'skipped', r.reason, null, null);
    return r;
  }

  if (run.processed >= run.options.maxItems) {
    r.status = 'skipped';
    r.reason = `已达到本轮最大执行数量 ${run.options.maxItems}`;
    r.code = RESULT_CODES.MAX_ITEMS_REACHED;
    return r;
  }
  run.processed++;

  console.log(`[reply]   处理: ${item.actorName} "${item.commentText.slice(0, 40)}"`);

  if (run.options.dryRun) {
    console.log(`[reply]   dry-run mode — 只定位不发送`);
    r.step = 'dry-run-locate';
    const locateResult = await openReplyBoxForComment(page, item);
    if (locateResult.ok) {
      r.status = 'dry_run_ok';
      r.reason = 'dry-run 定位成功，未实际发送';
      console.log(`[reply]     ✓ dry-run 定位成功`);
      recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'dry_run_ok', r.reason, null, null);
    } else {
      r.status = 'blocked';
      r.reason = locateResult.message;
      r.code = locateResult.code;
      console.log(`[reply]     ✗ [${locateResult.code}] ${locateResult.message}`);
      const itemEvidence = await captureItemEvidence(page, run, item, 'dry-run-locate', locateResult);
      r.evidenceDir = itemEvidence.evidenceDir;
      r.screenshotPath = itemEvidence.screenshotPath;
      recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', r.reason, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    }
    return r;
  }

  console.log(`[reply]   execute mode confirmed`);
  console.log(`[reply]   will send replyText: "${item.replyText.slice(0, 60)}"`);

  r.step = 'open-reply-box';
  console.log(`[reply]   before openReplyBoxForComment`);
  const openResult = await openReplyBoxForComment(page, item);
  if (!openResult.ok) {
    r.status = 'blocked';
    r.reason = `打开回复框失败: ${openResult.message}`;
    r.code = openResult.code;
    console.log(`[reply]     ✗ [${openResult.code}] ${openResult.message}`);
    console.log(`[reply] ❌ 未完成真实回复`);
    console.log(`[reply]   failedStep: open-reply-box`);
    console.log(`[reply]   reason: ${openResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'open-reply-box', openResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', r.reason, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }
  console.log(`[reply]     ✓ 回复框已打开`);

  r.step = 'execute-reply';
  console.log(`[reply]   before sendReply`);
  const replyResult = await sendReply(page, item.replyText);
  console.log(`[reply]   after sendReply ok=${replyResult.ok}`);
  if (!replyResult.ok) {
    r.status = 'blocked';
    r.reason = replyResult.message;
    r.code = replyResult.code;
    console.log(`[reply]     ✗ [${replyResult.code}] ${replyResult.message}`);
    console.log(`[reply] ❌ 未完成真实回复`);
    console.log(`[reply]   failedStep: execute-reply`);
    console.log(`[reply]   reason: ${replyResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'execute-reply', replyResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', replyResult.message, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }

  r.step = 'verify-reply';
  console.log(`[reply]   before verifyReplyVisible`);
  const verifyResult = await verifyReplyVisible(page, item, item.replyText);
  console.log(`[reply]   after verifyReplyVisible ok=${verifyResult.ok}`);
  if (!verifyResult.ok) {
    r.status = 'sent_unverified';
    r.reason = verifyResult.message;
    r.code = verifyResult.code;
    console.log(`[reply]     ⚠ 发送后未确认: ${verifyResult.message}`);
    console.log(`[reply] ❌ 未完成真实回复`);
    console.log(`[reply]   failedStep: verify-reply`);
    console.log(`[reply]   reason: ${verifyResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'verify-reply', verifyResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'sent_unverified', verifyResult.message, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  console.log(`[reply]     ✓ 回复成功`);

  try {
    const titleResult = await getSelectedWorkTitle(page);
    const workTitle = titleResult.ok ? (titleResult.data?.title || '') : item.workTitle || '';
    recordAction(db, item.eventId, planId, workTitle, item.replyText, 'succeeded', null, null, null);
    updateEventStatus(db, item.eventId, 'succeeded');
    run.executed++;
    run.succeeded++;
    console.log(`[reply] ✅ 已真实发送 1 条评论回复`);
    console.log(`[reply]   actorName: ${item.actorName}`);
    console.log(`[reply]   workTitle: ${item.workTitle || workTitle}`);
    console.log(`[reply]   replyText: ${item.replyText}`);
    console.log(`[reply]   database: succeeded`);
  } catch (err) {
    console.log(`[reply]     动作记录写入失败: ${err.message}`);
  }

  return r;
}

async function executeWorkGroup(page, group, db, run, planId) {
  const results = [];

  console.log(`[reply] 作品组: ${group.workTitle || group.key}，${group.items.length} 条评论`);

  const selectResult = await selectWorkForGroup(page, group);
  if (!selectResult.ok) {
    console.log(`[reply]   ✗ 作品选择失败: [${selectResult.code}] ${selectResult.message}`);
    const groupEvidence = await captureItemEvidence(page, run, group.items[0], 'select-work', selectResult);
    for (const item of group.items) {
      const r = {
        eventId: item.eventId,
        actorName: item.actorName,
        status: 'blocked',
        reason: `作品选择失败: ${selectResult.message}`,
        step: 'select-work',
        code: selectResult.code,
        evidenceDir: groupEvidence.evidenceDir,
        screenshotPath: groupEvidence.screenshotPath,
      };
      recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText || '', 'blocked', r.reason, groupEvidence.evidenceJson, groupEvidence.screenshotPath);
      results.push(r);
      run.hadBlocked = true;
    }
    return results;
  }

  for (let i = 0; i < group.items.length; i++) {
    const result = await executeOneItemInCurrentWork(page, group.items[i], db, run, planId);
    results.push(result);

    if (run.processed >= run.options.maxItems) {
      break;
    }

    if (i < group.items.length - 1) await page.waitForTimeout(1000);
  }

  return results;
}

async function main() {
  console.error('[comments:reply] 当前链路：评论回复');
  console.error('[comments:reply] 行为：打开评论管理页 → 选择我的作品 → 定位评论 → 回复评论');
  console.error('[comments:reply] 不会打开好友主页，不会打开好友视频');

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

  const actionMode = commonArgs.options.execute ? 'execute' : 'dry-run';
  const groups = groupApprovedItemsByWork(approvedItems);
  console.log(`[reply] 模式: ${actionMode}`);
  console.log(`[reply] dryRun=${commonArgs.options.dryRun} execute=${commonArgs.options.execute}`);
  console.log(`[reply] ~ ${approvedItems.length} 条待处理 / ${groups.length} 个作品, 最大执行 ${commonArgs.options.maxItems} 条`);

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];
  let successCount = 0;
  let skipCount = 0;
  let blockedCount = 0;
  let sentUnverifiedCount = 0;

  try {
    console.log('[reply] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
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

    for (const group of groups) {
      const groupResults = await executeWorkGroup(page, group, db, run, planId);
      results.push(...groupResults);

      for (const r of groupResults) {
        if (r.status === 'succeeded') successCount++;
        else if (r.status === 'sent_unverified') sentUnverifiedCount++;
        else if (r.status === 'skipped') skipCount++;
        else if (r.status === 'blocked') blockedCount++;
      }

      if (run.processed >= commonArgs.options.maxItems) {
        console.log(`[reply] 已达到本轮最大执行数量 ${commonArgs.options.maxItems}, 停止。`);
        break;
      }
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
        workGroups: groups.length,
        processed: run.processed || 0,
        succeeded: successCount,
        sentUnverified: sentUnverifiedCount,
        skipped: skipCount,
        blocked: blockedCount,
        evidenceCount: run.evidenceDirectories.length,
        maxItems: commonArgs.options.maxItems,
      },
    });
    console.log(`[reply] 结果已保存: ${resultPath}`);
    console.log(`[reply] ${successCount} 成功 / ${sentUnverifiedCount} 未确认 / ${blockedCount} 阻塞 / ${skipCount} 跳过 / ${approvedItems.length} 总计`);

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

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
