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
import { groupApprovedItemsByWork, buildItemEvidenceData } from './execute-comment-replies.mjs';

const SAFE_RESUME_STEPS = new Set([
  'navigate',
  'select-work',
  'dry-run-locate',
  'open-reply-box',
  'execute-reply',
]);

export function isSafeResumeResult(r) {
  if (!r || r.status !== 'blocked') return false;
  if (!SAFE_RESUME_STEPS.has(r.step)) return false;
  return true;
}

export function loadResumeItemsFromResult(resultJson) {
  const results = resultJson.results || [];
  return results.filter(isSafeResumeResult);
}

export function mergeResumeResultsWithPlanItems(resumeResults, planItems) {
  const planByEventId = new Map();
  for (const item of (planItems || [])) {
    if (item.eventId) planByEventId.set(item.eventId, item);
  }

  return resumeResults.map(r => {
    const planItem = planByEventId.get(r.eventId);
    if (!planItem) {
      return {
        ...r,
        _merged: false,
        _skipReason: 'plan item not found by eventId',
      };
    }
    return {
      eventId: r.eventId,
      actorName: planItem.actorName || r.actorName || '',
      workTitle: planItem.workTitle || '',
      workId: planItem.workId || '',
      workUrl: planItem.workUrl || '',
      commentText: planItem.commentText || '',
      replyText: planItem.replyText || '',
      eventTimeText: planItem.eventTimeText || '',
      actorProfileUrl: planItem.actorProfileUrl || '',
      _merged: true,
      _resumeFrom: {
        status: r.status,
        step: r.step,
        reason: r.reason || '',
        code: r.code || '',
        evidenceDir: r.evidenceDir || null,
        screenshotPath: r.screenshotPath || null,
      },
    };
  });
}

export function buildResumeDryRunResults(items, skippedItems) {
  const results = [];
  for (const item of items) {
    results.push({
      eventId: item.eventId,
      actorName: item.actorName,
      workTitle: item.workTitle || '',
      status: 'skipped',
      reason: 'dry-run 模式，仅列出可恢复项',
      step: 'resume-preview',
      code: RESULT_CODES.DRY_RUN_REQUIRED,
      resumeFrom: item._resumeFrom || null,
    });
  }
  for (const si of skippedItems) {
    results.push({
      eventId: si.eventId,
      actorName: si.actorName || '',
      workTitle: si.workTitle || '',
      status: 'skipped',
      reason: si._skipReason || 'plan item not found',
      step: 'resume-preview',
      code: '',
    });
  }
  return results;
}

function parseArgs(argv) {
  const args = { result: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--result' && argv[i + 1]) { args.result = argv[++i]; }
  }
  return args;
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

function hasSucceededAction(db, eventId) {
  const row = db.prepare(
    "SELECT id FROM actions WHERE event_id = ? AND action_type = 'reply_comment' AND status = 'succeeded'"
  ).get(eventId);
  return !!row;
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
    return { evidenceDir: null, screenshotPath: null, evidenceJson: null };
  }
}

async function selectWorkForGroup(page, group) {
  if (!group.workTitle) {
    return blocking(RESULT_CODES.BLOCKED, '作品缺少 workTitle，无法确认当前作品是否正确', { recoverable: false });
  }

  try {
    const currentTitle = await getSelectedWorkTitle(page);
    if (currentTitle.ok && currentTitle.data?.title === group.workTitle) {
      console.log(`[resume]   作品已选中: "${group.workTitle}"，跳过切换`);
      return success();
    }
  } catch {
    // fall through to select
  }

  console.log(`[resume]   切换作品: "${group.workTitle}"`);
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

async function executeOneItem(page, item, db, run, planId) {
  const r = {
    eventId: item.eventId,
    actorName: item.actorName,
    workTitle: item.workTitle || '',
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
    resumeFrom: item._resumeFrom || null,
  };

  if (!item._merged) {
    r.status = 'skipped';
    r.reason = item._skipReason || 'plan item not found';
    return r;
  }

  if (!item.replyText || !item.replyText.trim()) {
    r.status = 'skipped';
    r.reason = 'replyText 为空';
    r.code = RESULT_CODES.EMPTY_REPLY_TEXT;
    return r;
  }

  if (hasSucceededAction(db, item.eventId)) {
    r.status = 'skipped';
    r.reason = '已成功回复过，跳过';
    r.code = RESULT_CODES.DUPLICATE_ACTION;
    return r;
  }

  if (run.processed >= run.options.maxItems) {
    r.status = 'skipped';
    r.reason = `已达到本轮最大执行数量 ${run.options.maxItems}`;
    r.code = RESULT_CODES.MAX_ITEMS_REACHED;
    return r;
  }
  run.processed++;

  console.log(`[resume]   处理: ${item.actorName} "${item.commentText.slice(0, 40)}"`);

  r.step = 'open-reply-box';
  const openResult = await openReplyBoxForComment(page, item);
  if (!openResult.ok) {
    r.status = 'blocked';
    r.reason = `打开回复框失败: ${openResult.message}`;
    r.code = openResult.code;
    console.log(`[resume]     ✗ [${openResult.code}] ${openResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'open-reply-box', openResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', r.reason, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }
  console.log(`[resume]     ✓ 回复框已打开`);

  r.step = 'execute-reply';
  const replyResult = await sendReply(page, item.replyText);
  if (!replyResult.ok) {
    r.status = 'blocked';
    r.reason = replyResult.message;
    r.code = replyResult.code;
    console.log(`[resume]     ✗ [${replyResult.code}] ${replyResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'execute-reply', replyResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'blocked', replyResult.message, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }

  r.step = 'verify-reply';
  const verifyResult = await verifyReplyVisible(page, item, item.replyText);
  if (!verifyResult.ok) {
    r.status = 'sent_unverified';
    r.reason = verifyResult.message;
    r.code = verifyResult.code;
    console.log(`[resume]     ⚠ 发送后未确认: ${verifyResult.message}`);
    const itemEvidence = await captureItemEvidence(page, run, item, 'verify-reply', verifyResult);
    r.evidenceDir = itemEvidence.evidenceDir;
    r.screenshotPath = itemEvidence.screenshotPath;
    recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText, 'sent_unverified', verifyResult.message, itemEvidence.evidenceJson, itemEvidence.screenshotPath);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  r.reason = '恢复执行成功';
  console.log(`[resume]     ✓ 回复成功`);

  try {
    const titleResult = await getSelectedWorkTitle(page);
    const workTitle = titleResult.ok ? (titleResult.data?.title || '') : item.workTitle || '';
    recordAction(db, item.eventId, planId, workTitle, item.replyText, 'succeeded', r.reason, null, null);
    updateEventStatus(db, item.eventId, 'succeeded');
    run.succeeded++;
  } catch (err) {
    console.log(`[resume]     动作记录写入失败: ${err.message}`);
  }

  return r;
}

async function executeWorkGroup(page, group, db, run, planId) {
  const results = [];

  console.log(`[resume] 作品组: ${group.workTitle || group.key}，${group.items.length} 条评论`);

  const selectResult = await selectWorkForGroup(page, group);
  if (!selectResult.ok) {
    console.log(`[resume]   ✗ 作品选择失败: [${selectResult.code}] ${selectResult.message}`);
    const groupEvidence = await captureItemEvidence(page, run, group.items[0], 'select-work', selectResult);
    for (const item of group.items) {
      const r = {
        eventId: item.eventId,
        actorName: item.actorName,
        workTitle: item.workTitle || '',
        status: 'blocked',
        reason: `作品选择失败: ${selectResult.message}`,
        step: 'select-work',
        code: selectResult.code,
        evidenceDir: groupEvidence.evidenceDir,
        screenshotPath: groupEvidence.screenshotPath,
        resumeFrom: item._resumeFrom || null,
      };
      results.push(r);
      try {
        recordAction(db, item.eventId, planId, item.workTitle || '', item.replyText || '', 'blocked', r.reason, groupEvidence.evidenceJson, groupEvidence.screenshotPath);
      } catch {}
      run.hadBlocked = true;
    }
    return results;
  }

  for (let i = 0; i < group.items.length; i++) {
    const result = await executeOneItem(page, group.items[i], db, run, planId);
    results.push(result);

    if (run.processed >= run.options.maxItems) {
      break;
    }

    if (i < group.items.length - 1) await page.waitForTimeout(1000);
  }

  return results;
}

async function main() {
  console.error('[comments:resume] 当前链路：评论回复恢复执行');
  console.error('[comments:resume] 行为：从结果文件中恢复安全可重试的失败项，重新执行评论回复');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  if (!cmdArgs.result) {
    console.error('用法: npm run comments:resume -- --result <result-json> [--dry-run|--execute] [--max-items N] [--keep-open]');
    process.exit(1);
  }

  if (!existsSync(cmdArgs.result)) {
    console.error(`结果文件不存在: ${cmdArgs.result}`);
    process.exit(1);
  }

  const run = createRunContext('comments-resume', commonArgs.options);

  const resultJson = JSON.parse(readFileSync(cmdArgs.result, 'utf8'));
  const resumeItems = loadResumeItemsFromResult(resultJson);

  if (resumeItems.length === 0) {
    console.log('[resume] 结果文件中没有安全可恢复的评论。');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const resultPath = path.join(plansDir, `resume-result-${ts}.json`);
    writeJSON(resultPath, {
      sourceResult: cmdArgs.result,
      sourcePlan: resultJson.sourcePlan || resultJson.plan || null,
      mode: commonArgs.options.dryRun ? 'dry-run' : 'execute',
      results: [],
      summary: { total: 0, resumeCandidates: 0, workGroups: 0, processed: 0, succeeded: 0, sentUnverified: 0, blocked: 0, skipped: 0, evidenceCount: 0, maxItems: commonArgs.options.maxItems },
    });
    console.log(`[resume] 结果已保存: ${resultPath}`);
    return;
  }

  let planItems = [];
  let sourcePlanId = null;
  const planPath = resultJson.sourcePlan || resultJson.plan;
  if (planPath && existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      planItems = plan.items || [];
      sourcePlanId = plan.planId || null;
    } catch {
      console.error(`[resume] 原计划文件读取失败: ${planPath}`);
    }
  }

  const mergedItems = mergeResumeResultsWithPlanItems(resumeItems, planItems);
  const validItems = mergedItems.filter(item => item._merged);
  const skippedItems = mergedItems.filter(item => !item._merged);

  const isDryRun = commonArgs.options.dryRun;
  const mode = isDryRun ? 'dry-run' : 'execute';
  const groups = groupApprovedItemsByWork(validItems);

  console.log(`[resume] 模式: ${mode}`);
  console.log(`[resume] 来源结果: ${cmdArgs.result}`);
  console.log(`[resume] 可恢复: ${resumeItems.length} 条 / ${groups.length} 个作品`);

  if (isDryRun) {
    for (const item of validItems) {
      console.log(`[resume]   (dry-run) ${item.actorName} "${item.commentText.slice(0, 40)}" → 作品: ${item.workTitle || '(未知)'}，原失败步骤: ${item._resumeFrom?.step || '?'}`);
    }
    const dryResults = buildResumeDryRunResults(validItems, skippedItems);
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `resume-result-${ts}.json`);
    writeJSON(resultPath, {
      sourceResult: cmdArgs.result,
      sourcePlan: resultJson.sourcePlan || resultJson.plan || null,
      mode,
      results: dryResults,
      summary: {
        total: resumeItems.length,
        resumeCandidates: resumeItems.length,
        workGroups: groups.length,
        processed: 0,
        succeeded: 0,
        sentUnverified: 0,
        blocked: 0,
        skipped: dryResults.length,
        evidenceCount: 0,
        maxItems: commonArgs.options.maxItems,
      },
    });
    console.log(`[resume] 结果已保存: ${resultPath}`);
    return;
  }

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];
  let successCount = 0;
  let sentUnverifiedCount = 0;
  let blockedCount = 0;
  let skipCount = skippedItems.length;

  for (const si of skippedItems) {
    results.push({
      eventId: si.eventId,
      actorName: si.actorName || '',
      workTitle: si.workTitle || '',
      status: 'skipped',
      reason: si._skipReason || 'plan item not found',
      step: 'resume-preview',
      code: '',
      resumeFrom: null,
    });
  }

  try {
    console.log('[resume] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    console.log('[resume] 导航到评论管理页...');
    let pageReady = true;
    let pageReadyError = null;
    const navResult = await ensureCommentPageReady(page);
    if (!navResult.ok) {
      console.log(`[resume] 导航失败: [${navResult.code}] ${navResult.message}`);
      pageReady = false;
      pageReadyError = navResult;
      run.hadBlocked = true;
    } else {
      const areaResult = await waitForCommentsArea(page);
      if (!areaResult.ok) {
        console.log(`[resume] 评论区域检测: [${areaResult.code}] ${areaResult.message}`);
        pageReady = false;
        pageReadyError = areaResult;
        run.hadBlocked = true;
      }
    }

    if (!pageReady) {
      const pageErrorReason = pageReadyError?.message || '页面未就绪';
      const pageErrorCode = pageReadyError?.code || RESULT_CODES.NAVIGATION_TIMEOUT;
      for (const item of validItems) {
        results.push({
          eventId: item.eventId,
          actorName: item.actorName,
          workTitle: item.workTitle || '',
          status: 'blocked',
          reason: `页面未就绪: ${pageErrorReason}`,
          step: 'navigate',
          code: pageErrorCode,
          resumeFrom: item._resumeFrom || null,
        });
        blockedCount++;
        try {
          recordAction(db, item.eventId, sourcePlanId, item.workTitle || '', item.replyText || '', 'blocked', `页面未就绪: ${pageErrorReason}`, null, null);
        } catch {}
      }
    } else {
      for (const group of groups) {
        const groupResults = await executeWorkGroup(page, group, db, run, sourcePlanId);
        results.push(...groupResults);

        for (const r of groupResults) {
          if (r.status === 'succeeded') successCount++;
          else if (r.status === 'sent_unverified') sentUnverifiedCount++;
          else if (r.status === 'skipped') skipCount++;
          else if (r.status === 'blocked') blockedCount++;
        }

        if (run.processed >= commonArgs.options.maxItems) {
          console.log(`[resume] 已达到本轮最大执行数量 ${commonArgs.options.maxItems}, 停止。`);
          break;
        }
      }
    }

  } catch (err) {
    console.error('[resume] 错误:', err.message);
    run.hadError = true;

    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir,
          step: 'resume-error',
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
    const resultPath = path.join(plansDir, `resume-result-${ts}.json`);
    writeJSON(resultPath, {
      sourceResult: cmdArgs.result,
      sourcePlan: resultJson.sourcePlan || resultJson.plan || null,
      mode,
      results,
      summary: {
        total: resumeItems.length,
        resumeCandidates: resumeItems.length,
        workGroups: groups.length,
        processed: run.processed || 0,
        succeeded: successCount,
        sentUnverified: sentUnverifiedCount,
        blocked: blockedCount,
        skipped: skipCount,
        evidenceCount: run.evidenceDirectories.length,
        maxItems: commonArgs.options.maxItems,
      },
    });
    console.log(`[resume] 结果已保存: ${resultPath}`);
    console.log(`[resume] ${successCount} 成功 / ${sentUnverifiedCount} 未确认 / ${blockedCount} 阻塞 / ${skipCount} 跳过 / ${resumeItems.length} 总计`);

    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);

    if (browser && shouldClose) {
      console.log('[resume] 关闭浏览器...');
      await browser.close();
    } else if (browser) {
      console.log('[resume] 浏览器保持打开，供人工检查。手动关闭窗口或 Ctrl+C 退出。');
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}