import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  RETURN_VISIT_STATUS,
  listReturnVisitExecuteTasks,
  updateReturnVisitTask,
  markReturnVisitFailure,
  markReturnVisitDone,
} from '../services/return-visit-task-service.mjs';
import {
  executeReturnVisitTask,
  waitRandom,
} from '../services/return-visit-executor.mjs';

function parseArgs(argv) {
  const args = {
    json: false,
    keepOpen: false,
    headless: false,
    dryRun: false,
    maxItems: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--max-items' && i + 1 < argv.length) args.maxItems = Math.max(1, parseInt(argv[++i], 10) || 1);
  }

  return args;
}

function log(useJson, ...args) {
  if (useJson) console.error(...args);
  else console.log(...args);
}

function getRange(range, fallbackMin, fallbackMax) {
  if (Array.isArray(range) && range.length >= 2) {
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!isNaN(min) && !isNaN(max) && min >= 0 && max >= min) {
      return [min, max];
    }
  }
  return [fallbackMin, fallbackMax];
}

function randomInRange(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const executeMode = !args.dryRun;
  const maxItems = args.maxItems || returnVisitConfig.executeMaxItems || 20;
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  const maxWorksToCheck = Number(returnVisitConfig.maxWorksToCheck ?? 3);
  const pageLoadRetryCount = Number(returnVisitConfig.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(returnVisitConfig.maxConsecutiveFailures ?? 3);
  const waitBetweenUsersMs = returnVisitConfig.waitBetweenUsersMs || [8000, 20000];
  const waitBetweenLikeAndCommentMs = returnVisitConfig.waitBetweenLikeAndCommentMs || [2000, 6000];
  const restEveryTasksRange = getRange(returnVisitConfig.restEveryTasksRange, 8, 12);
  const restDurationMs = returnVisitConfig.restDurationMs || [60000, 180000];

  const allTasks = listReturnVisitExecuteTasks({
    limit: maxItems,
    maxRetryCount,
  });

  const tasks = [];
  const taskResults = [];
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of allTasks) {
    const hasComment = task.generatedComment && String(task.generatedComment).trim();
    const hasWorkUrl = task.targetWork?.workUrl && String(task.targetWork.workUrl).trim();

    const isTargetStatus = [
      RETURN_VISIT_STATUS.PENDING_EXECUTE,
      RETURN_VISIT_STATUS.EXECUTING,
      RETURN_VISIT_STATUS.FAILED_LIKE,
      RETURN_VISIT_STATUS.FAILED_COMMENT
    ].includes(task.status);

    if (!isTargetStatus || !hasComment || !hasWorkUrl || task.commentStatus === 'posted') {
      if (!hasComment) {
        log(args.json, `[return-visit:execute] task ${task.taskId} skipped due to empty generatedComment`);
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
          lastError: 'no_generated_comment'
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT, reason: 'no_generated_comment' });
        failed++;
      } else if (!hasWorkUrl) {
        log(args.json, `[return-visit:execute] task ${task.taskId} skipped due to empty workUrl`);
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.FAILED_COLLECT,
          lastError: 'no_work_url'
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_COLLECT, reason: 'no_work_url' });
        failed++;
      } else {
        log(args.json, `[return-visit:execute] task ${task.taskId} filtered out (status: ${task.status}, commentStatus: ${task.commentStatus})`);
      }
      continue;
    }

    tasks.push(task);
  }

  log(args.json, `[return-visit:execute] loaded executable tasks: ${tasks.length}`);
  if (tasks.length === 0) {
    if (args.json) {
      printJsonResult('return-visit:execute', { tasks: taskResults }, { loaded: allTasks.length, done, skipped, failed });
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
      printJsonError('return-visit:execute', RESULT_CODES.UNKNOWN_ERROR, msg, { recoverable: false });
      return;
    }
    throw err;
  }

  let consecutiveFailures = 0;
  let processedSinceRest = 0;
  let restAfter = randomInRange(restEveryTasksRange[0], restEveryTasksRange[1]);

  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    if (consecutiveFailures >= maxConsecutiveFailures) {
      log(args.json, `[return-visit:execute] 连续失败 ${consecutiveFailures} 个任务，暂停本轮执行`);
      break;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.EXECUTING,
      lastError: null,
    });

    log(args.json, `[return-visit:execute] executing task: ${task.taskId}`);
    if (task.targetWork?.workUrl) {
      log(args.json, `[return-visit:execute] opening workUrl: ${task.targetWork.workUrl}`);
    }

    const result = await executeReturnVisitTask(page, task, {
      execute: executeMode,
      pageLoadRetryCount,
      maxWorksToCheck,
      waitBetweenLikeAndCommentMs,
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
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.DONE, likeStatus: result.likeStatus, commentStatus: result.commentStatus });
      done++;
      consecutiveFailures = 0;
      log(args.json, '[return-visit:execute] task done');
    } else if (result.ok && result.dryRun) {
      updateReturnVisitTask(task.taskId, {
        status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
        likeStatus: result.likeStatus,
        commentStatus: result.commentStatus,
      });
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.PENDING_EXECUTE, dryRun: true });
      consecutiveFailures = 0;
    } else if (!result.ok && String(result.status || '').startsWith('skipped_')) {
      updateReturnVisitTask(task.taskId, {
        status: result.status,
        likeStatus: result.likeStatus || task.likeStatus,
        commentStatus: result.commentStatus || task.commentStatus,
        lastError: result.error || result.status,
      });
      taskResults.push({ taskId: task.taskId, status: result.status, reason: result.error || result.status });
      skipped++;
      consecutiveFailures = 0;
    } else {
      markReturnVisitFailure(task, {
        status: result.status || RETURN_VISIT_STATUS.FAILED,
        error: result.error || 'execute_failed',
        likeStatus: result.likeStatus || task.likeStatus,
        commentStatus: result.commentStatus || task.commentStatus,
      });
      taskResults.push({ taskId: task.taskId, status: result.status || RETURN_VISIT_STATUS.FAILED, reason: result.error || 'execute_failed' });
      failed++;
      consecutiveFailures++;
      log(args.json, `[return-visit:execute] failed: ${result.error || result.status || 'unknown'}`);
    }

    processedSinceRest++;

    if (executeMode && index < tasks.length - 1) {
      const userWaitMs = await waitRandom(page, waitBetweenUsersMs, 8000, 20000);
      log(args.json, `[return-visit:execute] wait between users: ${userWaitMs}ms`);
    }

    if (executeMode && processedSinceRest >= restAfter) {
      const restMs = await waitRandom(page, restDurationMs, 60000, 180000);
      log(args.json, `[return-visit:execute] rest: ${restMs}ms`);
      processedSinceRest = 0;
      restAfter = randomInRange(restEveryTasksRange[0], restEveryTasksRange[1]);
    }
  }

  const summary = {
    loaded: tasks.length,
    done,
    skipped,
    failed,
    mode: executeMode ? 'execute' : 'dry-run',
  };
  log(args.json, `[return-visit:execute] summary done=${done} skipped=${skipped} failed=${failed}`);

  if (args.json) {
    printJsonResult('return-visit:execute', { tasks: taskResults }, summary);
  }

  if (browser && !args.keepOpen) {
    await browser.close();
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/execute-return-visit.mjs') ||
  process.argv[1].endsWith('\\execute-return-visit.mjs')
);

if (isMain) {
  main().catch((err) => {
    console.error('[return-visit:execute] error:', err.message);
    printJsonError('return-visit:execute', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    process.exit(1);
  });
}
