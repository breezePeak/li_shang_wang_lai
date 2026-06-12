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
import { createAgentProvider } from '../agent/agent-provider-factory.mjs';

function parseArgs(argv) {
  const args = {
    json: false,
    keepOpen: false,
    headless: undefined,
    dryRun: false,
    execute: true,
    watchPolicy: null,
    watchSeconds: null,
    unsupportedItemsFile: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--dry-run') { args.dryRun = true; args.execute = false; }
    else if (arg === '--execute') { args.execute = true; args.dryRun = false; }
    else if (arg === '--watch-policy' && i + 1 < argv.length) args.watchPolicy = argv[++i];
    else if (arg === '--watch-seconds' && i + 1 < argv.length) args.watchSeconds = argv[++i];
    else if (arg === '--items-file') {
      args.unsupportedItemsFile = true;
      if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) i++;
    }
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

export function getReturnVisitTaskExecutionIssue(task) {
  const hasWorkUrl = task?.targetWork?.workUrl && String(task.targetWork.workUrl).trim();
  const hasWorkId = task?.targetWork?.workId && String(task.targetWork.workId).trim();
  const hasProfileUrl = task?.userProfileUrl && String(task.userProfileUrl).trim();

  const isTargetStatus = [
    RETURN_VISIT_STATUS.PENDING_EXECUTE,
    RETURN_VISIT_STATUS.PENDING_VISIT,
    RETURN_VISIT_STATUS.EXECUTING,
    RETURN_VISIT_STATUS.FAILED_COLLECT,
    RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
    RETURN_VISIT_STATUS.FAILED_LIKE,
    RETURN_VISIT_STATUS.FAILED_COMMENT,
  ].includes(task?.status);

  if (!isTargetStatus) {
    return 'non_executable_status';
  }
  if (!hasWorkUrl && !hasWorkId && !hasProfileUrl) {
    return 'no_work_target';
  }
  if (task?.commentStatus === 'posted') {
    return 'comment_already_posted';
  }
  return null;
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  if (args.unsupportedItemsFile) {
    printJsonError(
      'return-visit:execute',
      RESULT_CODES.INVALID_ARGUMENTS,
      'return-visit:execute 不再支持 --items-file；请先执行 interactions:scan --days N --prepare-visits 入库，然后直接运行 visit:run/return-visit:execute',
      { recoverable: false }
    );
    return;
  }
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const executeMode = args.execute;
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  const maxWorksToCheck = Number(returnVisitConfig.maxWorksToCheck ?? 3);
  const pageLoadRetryCount = Number(returnVisitConfig.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(returnVisitConfig.maxConsecutiveFailures ?? 3);
  const waitBetweenUsersMs = returnVisitConfig.waitBetweenUsersMs || [3000, 5000];
  const waitBetweenLikeAndCommentMs = returnVisitConfig.waitBetweenLikeAndCommentMs || [2000, 3000];
  const restEveryTasksRange = getRange(returnVisitConfig.restEveryTasksRange, 1, 1);
  const restDurationMs = returnVisitConfig.restDurationMs || [5000, 5000];

  // 映射视频观看策略与秒数默认值
  const watchPolicy = args.watchPolicy || returnVisitConfig.watchPolicy || 'seconds';
  const watchSecondsRaw = args.watchSeconds || returnVisitConfig.watchSeconds || '3';
  const taskResults = [];
  let done = 0;
  let skipped = 0;
  let failed = 0;

  let watchSeconds = [3, 3];
  if (typeof watchSecondsRaw === 'string') {
    const parts = watchSecondsRaw.split('-');
    if (parts.length === 2) {
      watchSeconds = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    } else {
      const single = parseInt(watchSecondsRaw, 10);
      if (!isNaN(single)) watchSeconds = [single, single];
    }
  } else if (Array.isArray(watchSecondsRaw)) {
    watchSeconds = watchSecondsRaw;
  } else if (typeof watchSecondsRaw === 'number') {
    watchSeconds = [watchSecondsRaw, watchSecondsRaw];
  }

  const allTasks = listReturnVisitExecuteTasks({
    maxRetryCount,
  });

  const tasks = [];

  for (const task of allTasks) {
    const issue = getReturnVisitTaskExecutionIssue(task);
    if (issue) {
      if (issue === 'no_work_target') {
        log(args.json, `[return-visit:execute] task ${task.taskId} skipped due to empty work target`);
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.FAILED_COLLECT,
          lastError: 'no_work_target'
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.FAILED_COLLECT, reason: 'no_work_target' });
        failed++;
      } else {
        log(args.json, `[return-visit:execute] task ${task.taskId} filtered out (${issue}) (status: ${task.status}, commentStatus: ${task.commentStatus})`);
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
  const agentProvider = createAgentProvider();
  try {
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
        watchPolicy,
        watchSeconds,
        agentProvider,
      });

      if (result.resolvedWork) {
        updateReturnVisitTask(task.taskId, {
          generatedComment: result.generatedComment || task.generatedComment || null,
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
        log(args.json, `[return-visit:execute] 失败 ${task.taskId}: ${result.status || 'unknown'} reason=${result.error || 'unknown'}`);
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
        const userWaitMs = await waitRandom(page, waitBetweenUsersMs, 3000, 5000);
        log(args.json, `[return-visit:execute] wait between users: ${userWaitMs}ms`);
      }

      if (executeMode && processedSinceRest >= restAfter) {
        const restMs = await waitRandom(page, restDurationMs, 5000, 5000);
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

    if (browser && !args.keepOpen) {
      await browser.close();
    }
    if (args.json) {
      printJsonResult('return-visit:execute', { tasks: taskResults }, summary);
    }
  } finally {
    await agentProvider.close?.();
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
