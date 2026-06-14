import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext, replaceContextPage } from '../browser/browser-context.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK } from '../config/defaults.mjs';
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
    maxWorksToCheck: null,
    limit: null,
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
    else if (arg === '--max-works-to-check' && i + 1 < argv.length) args.maxWorksToCheck = argv[++i];
    else if ((arg === '--limit' || arg === '--max-count') && i + 1 < argv.length) args.limit = Number(argv[++i] || 0) || null;
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

function resolveMaxWorksToCheck(
  cliValue,
  configValue,
  fallbackValue = DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK,
) {
  const candidates = [cliValue, configValue, fallbackValue];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return fallbackValue;
}

export function resolveRestartBrowserEveryTasks(value, fallbackValue = 5) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallbackValue;
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
      'return-visit:execute 不再支持 --items-file；请先执行 interactions:scan --prepare-visits 入库，然后直接运行 visit:run/return-visit:execute --limit M',
      { recoverable: false }
    );
    return;
  }
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const executeMode = args.execute;
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  const maxWorksToCheck = resolveMaxWorksToCheck(
    args.maxWorksToCheck,
    returnVisitConfig.maxWorksToCheck,
    DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK,
  );
  const pageLoadRetryCount = Number(returnVisitConfig.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(returnVisitConfig.maxConsecutiveFailures ?? 3);
  const restartBrowserEveryTasks = resolveRestartBrowserEveryTasks(
    returnVisitConfig.restartBrowserEveryTasks,
    5,
  );
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
    limit: args.limit,
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

  function isFatalPageError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('target page, context or browser has been closed')
      || msg.includes('browser has been closed')
      || msg.includes('page crashed')
      || msg.includes('browser closed')
      || msg.includes('crash')
      || msg.includes('execution context was destroyed');
  }

  async function recreatePage(ctx, currentPage) {
    if (!ctx?.context) return currentPage;
    page = await replaceContextPage(ctx.context, currentPage);
    console.error('[return-visit:execute] 已切换到新页面');
    return page;
  }

  async function closeBrowserSession(currentBrowser) {
    if (!currentBrowser) return;
    await currentBrowser.close().catch(() => {});
  }

  async function openBrowserSession() {
    const nextCtx = await createBrowserContext({
      headless: args.headless,
      enableReuse: args.keepOpen,
    });
    const nextBrowser = nextCtx.browser;
    const nextPage = await replaceContextPage(nextCtx.context, nextCtx.context.pages()[0] || null);
    return { ctx: nextCtx, browser: nextBrowser, page: nextPage };
  }

  async function restartBrowserSession(reason, currentCtx, currentBrowser, currentPage) {
    console.error(`[return-visit:execute] 重启浏览器会话 reason=${reason}`);
    if (currentPage) {
      try {
        if (typeof currentPage.isClosed !== 'function' || !currentPage.isClosed()) {
          await currentPage.close().catch(() => {});
        }
      } catch {}
    }
    await closeBrowserSession(currentBrowser);
    const nextSession = await openBrowserSession();
    return nextSession;
  }

  try {
    let ctx = null;
    try {
      const session = await openBrowserSession();
      ctx = session.ctx;
      browser = session.browser;
      page = session.page;
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
    let processedSinceBrowserRestart = 0;
    let restAfter = randomInRange(restEveryTasksRange[0], restEveryTasksRange[1]);

    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (index > 0) {
        page = await recreatePage(ctx, page);
      }
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

      let result;
      try {
        result = await executeReturnVisitTask(page, task, {
          execute: executeMode,
          pageLoadRetryCount,
          maxWorksToCheck,
          waitBetweenLikeAndCommentMs,
          watchPolicy,
          watchSeconds,
          agentProvider,
          allLikedFallbackEnabled: returnVisitConfig.allLikedFallbackEnabled,
          allLikedFallbackComments: returnVisitConfig.allLikedFallbackComments,
        });
      } catch (err) {
        const message = err?.message || 'execute_return_visit_task_failed';
        log(args.json, `[return-visit:execute] 执行异常 ${task.taskId}: ${message}`);
        result = {
          ok: false,
          status: 'failed_collect',
          error: message,
          likeStatus: task.likeStatus || 'pending',
          commentStatus: task.commentStatus || 'pending',
          checkedWorks: [],
        };
        if (isFatalPageError(err)) {
          try {
            const nextSession = await restartBrowserSession('fatal_page_error', ctx, browser, page);
            ctx = nextSession.ctx;
            browser = nextSession.browser;
            page = nextSession.page;
          } catch (restartErr) {
            console.error(`[return-visit:execute] 致命错误后重启浏览器失败: ${restartErr.message}`);
          }
        }
      }

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
            shareUrl: result.resolvedWork.shareUrl,
            desc: result.resolvedWork.desc,
            itemTitle: result.resolvedWork.itemTitle,
            createTime: result.resolvedWork.createTime,
            isTop: result.resolvedWork.isTop,
            userDigged: result.resolvedWork.userDigged,
            diggCount: result.resolvedWork.diggCount,
            commentCount: result.resolvedWork.commentCount,
            awemeType: result.resolvedWork.awemeType,
            mediaType: result.resolvedWork.mediaType,
            isMultiContent: result.resolvedWork.isMultiContent,
          },
          referenceComments: result.resolvedWork.referenceComments || [],
        });
      }

      if (result.ok && result.status === RETURN_VISIT_STATUS.DONE) {
        markReturnVisitDone(task, {
          likeStatus: result.likeStatus,
          commentStatus: result.commentStatus,
        });
        taskResults.push({
          taskId: task.taskId,
          status: RETURN_VISIT_STATUS.DONE,
          likeStatus: result.likeStatus,
          commentStatus: result.commentStatus,
          selectionMode: result.selectionMode,
          checkedWorks: result.checkedWorks,
        });
        done++;
        consecutiveFailures = 0;
        log(args.json, '[return-visit:execute] task done');
      } else if (result.ok && result.dryRun) {
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
          likeStatus: result.likeStatus,
          commentStatus: result.commentStatus,
        });
        taskResults.push({
          taskId: task.taskId,
          status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
          dryRun: true,
          selectionMode: result.selectionMode,
          checkedWorks: result.checkedWorks,
          plannedAction: result.plannedAction,
        });
        consecutiveFailures = 0;
      } else if (!result.ok && String(result.status || '').startsWith('skipped_')) {
        updateReturnVisitTask(task.taskId, {
          status: result.status,
          likeStatus: result.likeStatus || task.likeStatus,
          commentStatus: result.commentStatus || task.commentStatus,
          lastError: result.error || result.status,
        });
        taskResults.push({
          taskId: task.taskId,
          status: result.status,
          reason: result.error || result.status,
          selectionMode: result.selectionMode,
          checkedWorks: result.checkedWorks,
        });
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
        taskResults.push({
          taskId: task.taskId,
          status: result.status || RETURN_VISIT_STATUS.FAILED,
          reason: result.error || 'execute_failed',
          selectionMode: result.selectionMode,
          checkedWorks: result.checkedWorks,
        });
        failed++;
        consecutiveFailures++;
        log(args.json, `[return-visit:execute] failed: ${result.error || result.status || 'unknown'}`);
      }

      processedSinceRest++;
      processedSinceBrowserRestart++;

      const shouldRestartBrowser = !args.keepOpen
        && executeMode
        && restartBrowserEveryTasks > 0
        && processedSinceBrowserRestart > 0
        && index < tasks.length - 1
        && processedSinceBrowserRestart % restartBrowserEveryTasks === 0;

      if (executeMode && index < tasks.length - 1) {
        const userWaitMs = await waitRandom(page, waitBetweenUsersMs, 3000, 5000);
        log(args.json, `[return-visit:execute] wait between users: ${userWaitMs}ms`);
      }

      if (shouldRestartBrowser) {
        const nextSession = await restartBrowserSession(
          `periodic_after_${processedSinceBrowserRestart}_tasks`,
          ctx,
          browser,
          page,
        );
        ctx = nextSession.ctx;
        browser = nextSession.browser;
        page = nextSession.page;
        processedSinceBrowserRestart = 0;
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
      await closeBrowserSession(browser);
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
