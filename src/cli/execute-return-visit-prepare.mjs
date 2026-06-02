import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  RETURN_VISIT_STATUS,
  createOrUpdateReturnVisitTasksFromEvents,
  createOrUpdateReturnVisitTasksFromItems,
  listReturnVisitPrepareTasks,
  updateReturnVisitTask,
  markReturnVisitFailure,
} from '../services/return-visit-task-service.mjs';
import { collectCandidateWorkFromProfile } from '../services/return-visit-work-collector.mjs';
import { analyzeReturnVisitContext, generateReturnVisitComment } from '../services/return-visit-comment-generator.mjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function parseArgs(argv) {
  const args = {
    json: false,
    keepOpen: false,
    headless: false,
    maxItems: null,
    eventLimit: null,
    eventStatus: null,
    days: null,
    itemsFile: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--max-items' && i + 1 < argv.length) args.maxItems = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (arg === '--event-limit' && i + 1 < argv.length) args.eventLimit = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (arg === '--event-status' && i + 1 < argv.length) args.eventStatus = String(argv[++i] || '').trim() || null;
    else if (arg === '--items-file' && i + 1 < argv.length) args.itemsFile = String(argv[++i] || '').trim();
    else if (arg === '--days' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      args.days = Number.isFinite(n) && n > 0 ? n : null;
    }
  }

  return args;
}

function loadVisitItems(itemsFile) {
  const parsed = JSON.parse(readFileSync(resolve(itemsFile), 'utf8'));
  if (Array.isArray(parsed?.users)) return parsed.users;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed)) return parsed;
  throw new Error('--items-file 必须是 interactions:scan 生成的 users 数组、items 数组或用户数组');
}

function log(useJson, ...args) {
  if (useJson) console.error(...args);
  else console.log(...args);
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const maxItems = args.maxItems || returnVisitConfig.prepareMaxItems || 20;
  const eventLimit = args.eventLimit || returnVisitConfig.taskEventLimit || 500;
  const eventStatus = args.eventStatus || returnVisitConfig.eventSourceStatus || 'new';
  const sourceDays = args.days || Number(returnVisitConfig.sourceDays) || 7;
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  const maxWorksToCheck = Number(returnVisitConfig.maxWorksToCheck ?? 3);
  const pageLoadRetryCount = Number(returnVisitConfig.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(returnVisitConfig.maxConsecutiveFailures ?? 3);

  let sourceSummary;
  try {
    if (args.itemsFile) {
      const items = loadVisitItems(args.itemsFile);
      sourceSummary = createOrUpdateReturnVisitTasksFromItems(items);
    } else {
      sourceSummary = createOrUpdateReturnVisitTasksFromEvents({
        limit: eventLimit,
        status: eventStatus,
        days: sourceDays,
      });
    }
  } catch (err) {
    if (args.json) {
      printJsonError('return-visit:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
      return;
    }
    throw err;
  }

  const tasks = listReturnVisitPrepareTasks({
    limit: maxItems,
    maxRetryCount,
    days: sourceDays,
  });

  log(args.json, `[return-visit:prepare] sourced ${args.itemsFile ? 'json users' : 'events'}: ${sourceSummary.totalEvents ?? sourceSummary.totalItems}, inserted=${sourceSummary.inserted}, enriched=${sourceSummary.enriched}, skipped=${sourceSummary.skipped}${sourceDays ? `, days=${sourceDays}` : ''}`);
  log(args.json, `[return-visit:prepare] loaded pending tasks: ${tasks.length}`);

  if (tasks.length === 0) {
    if (args.json) {
      printJsonResult('return-visit:prepare', { tasks: [] }, {
        loaded: 0,
        inserted: sourceSummary.inserted,
        enriched: sourceSummary.enriched,
        skipped: sourceSummary.skipped,
      });
    }
    return;
  }

  let browser = null;
  let page = null;
  try {
    const ctx = await createBrowserContext({
      headless: args.headless,
      enableReuse: args.keepOpen,
    });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  } catch (err) {
    const msg = `浏览器启动失败: ${err.message}`;
    if (args.json) {
      printJsonError('return-visit:prepare', RESULT_CODES.UNKNOWN_ERROR, msg, { recoverable: false });
      return;
    }
    throw err;
  }

  let prepared = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const taskResults = [];

  for (const task of tasks) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      log(args.json, `[return-visit:prepare] 连续失败 ${consecutiveFailures} 个任务，暂停本轮执行`);
      break;
    }

    const profileUrl = task.userProfileUrl || (task.userId ? `https://www.douyin.com/user/${task.userId}` : null);
    const actorName = task.userName || task.taskId;
    log(args.json, `[return-visit:prepare] opening profile: ${actorName}`);

    if (!profileUrl) {
      markReturnVisitFailure(task, {
        status: RETURN_VISIT_STATUS.FAILED_COLLECT,
        error: 'no_profile_url',
      });
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_COLLECT, reason: 'no_profile_url' });
      failed++;
      consecutiveFailures++;
      continue;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.COLLECTING_CONTENT,
      lastError: null,
      userProfileUrl: profileUrl,
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
      if (collected.status && collected.status.startsWith('skipped_')) {
        updateReturnVisitTask(task.taskId, {
          status: collected.status,
          lastError: collected.reason || collected.status,
        });
        taskResults.push({ taskId: task.taskId, status: collected.status, reason: collected.reason || collected.status });
        skipped++;
        consecutiveFailures = 0;
      } else {
        markReturnVisitFailure(task, {
          status: RETURN_VISIT_STATUS.FAILED_COLLECT,
          error: collected.reason || 'collect_failed',
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_COLLECT, reason: collected.reason || 'collect_failed' });
        failed++;
        consecutiveFailures++;
      }
      continue;
    }

    const selectedWork = collected.selectedWork;
    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.CONTENT_COLLECTED,
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
      commentStatus: 'pending',
      collectedAt: new Date().toISOString(),
      lastError: null,
    });

    log(args.json, `[return-visit:prepare] collected work: ${selectedWork.workUrl}`);

    const analysis = analyzeReturnVisitContext({
      workTitle: selectedWork.workTitle,
      workText: selectedWork.workText,
      contentSummary: selectedWork.contentSummary,
      referenceComments: selectedWork.referenceComments || [],
    });

    if (!analysis.workTitle && analysis.referenceComments.length === 0) {
      updateReturnVisitTask(task.taskId, {
        status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
        lastError: 'revisit_context_missing_work_and_comments',
      });
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK, reason: 'revisit_context_missing_work_and_comments' });
      skipped++;
      consecutiveFailures = 0;
      continue;
    }

    if (analysis.sceneSignals.length === 0) {
      updateReturnVisitTask(task.taskId, {
        status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
        lastError: 'revisit_context_no_scene_signal',
      });
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK, reason: 'revisit_context_no_scene_signal' });
      skipped++;
      consecutiveFailures = 0;
      continue;
    }

    const commentResult = generateReturnVisitComment({
      workTitle: selectedWork.workTitle,
      workText: selectedWork.workText,
      contentSummary: selectedWork.contentSummary,
      referenceComments: selectedWork.referenceComments || [],
    });

    if (!commentResult.ok) {
      if (commentResult.reason === 'content_too_short') {
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
          lastError: 'content_too_short',
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK, reason: 'content_too_short' });
        skipped++;
        consecutiveFailures = 0;
      } else {
        markReturnVisitFailure(task, {
          status: RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
          error: commentResult.reason || 'generate_comment_failed',
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT, reason: commentResult.reason || 'generate_comment_failed' });
        failed++;
        consecutiveFailures++;
      }
      continue;
    }

    const generatedComment = commentResult.comment;
    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
      generatedComment,
      commentStatus: 'generated',
      generatedAt: new Date().toISOString(),
      lastError: null,
    });

    log(args.json, `[return-visit:prepare] generated comment: ${generatedComment}`);
    log(args.json, `[return-visit:prepare] task updated to pending_execute`);
    taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.PENDING_EXECUTE, generatedComment });
    prepared++;
    consecutiveFailures = 0;
  }

  const summary = {
    loaded: tasks.length,
    prepared,
    skipped,
    failed,
    inserted: sourceSummary.inserted,
    enriched: sourceSummary.enriched,
    sourceSkipped: sourceSummary.skipped,
  };

  log(args.json, `[return-visit:prepare] summary prepared=${prepared} skipped=${skipped} failed=${failed}`);
  if (args.json) {
    printJsonResult('return-visit:prepare', { tasks: taskResults }, summary);
  }

  if (browser && !args.keepOpen) {
    await browser.close();
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/execute-return-visit-prepare.mjs') ||
  process.argv[1].endsWith('\\execute-return-visit-prepare.mjs')
);

if (isMain) {
  main().catch((err) => {
    console.error('[return-visit:prepare] error:', err.message);
    printJsonError('return-visit:prepare', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    process.exit(1);
  });
}
