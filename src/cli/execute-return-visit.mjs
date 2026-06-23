import { runMigrations } from '../db/migrations.mjs';
import { createBrowserSessionManager } from '../browser/session-manager.mjs';
import { detectDouyinSecurityVerification } from '../browser/douyin-auth-state.mjs';
import { createRunContext, saveRunSummary } from '../browser/run-context.mjs';
import { createRunDebugRecorder } from '../browser/run-debug-recorder.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK } from '../config/defaults.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  RETURN_VISIT_STATUS,
  listReturnVisitExecuteTasks,
  listReturnVisitTasksByIds,
  updateReturnVisitTask,
  markReturnVisitFailure,
  markReturnVisitDone,
} from '../services/return-visit-task-service.mjs';
import {
  executeReturnVisitTask,
  waitRandom,
} from '../services/return-visit-executor.mjs';
import { createAgentProvider } from '../agent/agent-provider-factory.mjs';

export function parseArgs(argv) {
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
    taskIds: [],
    unsupportedItemsFile: false,
    debug: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--dry-run') { args.dryRun = true; args.execute = false; }
    else if (arg === '--execute') { args.execute = true; args.dryRun = false; }
    else if (arg === '--debug') args.debug = true;
    else if (arg === '--watch-policy' && i + 1 < argv.length) args.watchPolicy = argv[++i];
    else if (arg === '--watch-seconds' && i + 1 < argv.length) args.watchSeconds = argv[++i];
    else if (arg === '--max-works-to-check' && i + 1 < argv.length) args.maxWorksToCheck = argv[++i];
    else if ((arg === '--limit' || arg === '--max-count') && i + 1 < argv.length) args.limit = Number(argv[++i] || 0) || null;
    else if (arg === '--task-id' && i + 1 < argv.length) args.taskIds.push(String(argv[++i] || '').trim());
    else if (arg === '--task-ids' && i + 1 < argv.length) {
      args.taskIds.push(
        ...String(argv[++i] || '')
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
      );
    }
    else if (arg === '--items-file') {
      args.unsupportedItemsFile = true;
      if (argv[i + 1] && !String(argv[i + 1]).startsWith('--')) i++;
    }
  }

  args.taskIds = Array.from(new Set(args.taskIds.filter(Boolean)));
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

export async function waitForSecurityVerificationResolution(page, options = {}) {
  const {
    detector = detectDouyinSecurityVerification,
    pollMs = 1000,
    timeoutMs = 0,
    logger = console.error,
  } = options;
  const startedAt = Date.now();
  let prompted = false;

  while (true) {
    const verification = await detector(page);
    if (!verification) {
      if (prompted) logger('[return-visit:execute] 已检测到短信/安全认证弹窗消失，本轮继续执行');
      return { ok: true, waitedMs: Date.now() - startedAt };
    }

    if (!prompted) {
      prompted = true;
      logger('[return-visit:execute] 已暂停自动回访，请在当前浏览器窗口完成手机号/短信安全认证。窗口会保持打开。');
    }

    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      logger('[return-visit:execute] 等待短信/安全认证超时，浏览器窗口保持打开，请完成认证后重新运行');
      return { ok: false, waitedMs: Date.now() - startedAt, reason: 'security_verification_wait_timeout' };
    }

    if (typeof page?.waitForTimeout === 'function') {
      await page.waitForTimeout(pollMs);
    } else {
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
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
      'return-visit:execute 不再支持 --items-file；请先执行 interactions:scan --prepare-visits 入库，然后直接运行 visit:run/return-visit:execute，--limit 可选，不传默认处理全部可执行任务',
      { recoverable: false }
    );
    return;
  }
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};
  const run = createRunContext('return-visit:execute', {
    debug: args.debug,
    dryRun: !args.execute,
    execute: args.execute,
    json: args.json,
    keepOpen: Boolean(args.keepOpen) && !args.json,
    keepOpenOnError: !args.json,
    pauseOnError: false,
    writeRunFiles: args.debug,
    headless: args.headless,
    maxItems: args.limit || 0,
  });
  const recorder = createRunDebugRecorder(run, { command: 'return-visit:execute' });
  recorder.startConsoleCapture();

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
  const securityVerificationWaitMs = Number(returnVisitConfig.securityVerificationWaitMs ?? 0) || 0;

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

  const allTasks = args.taskIds.length > 0
    ? listReturnVisitTasksByIds(args.taskIds)
    : listReturnVisitExecuteTasks({
        maxRetryCount,
        limit: args.limit,
      });

  const tasks = [];

  for (const task of allTasks) {
    const issue = getReturnVisitTaskExecutionIssue(task);
    if (issue) {
      if (issue === 'no_work_target') {
        log(args.json, `[return-visit:execute] task ${task.taskId} skipped due to empty work target`);
        markReturnVisitFailure(task, {
          status: RETURN_VISIT_STATUS.FAILED_COLLECT,
          error: 'no_work_target',
          likeStatus: task.likeStatus,
          commentStatus: task.commentStatus,
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
    run.scanned = allTasks.length;
    if (args.json) {
      printJsonResult('return-visit:execute', { tasks: taskResults }, { loaded: allTasks.length, done, skipped, failed });
    }
    saveRunSummary(run);
    recorder.stopConsoleCapture();
    return;
  }

  let browser = null;
  let page = null;
  const agentProvider = createAgentProvider();
  const browserSession = createBrowserSessionManager({
    headless: args.headless,
    enableReuse: args.keepOpen,
    logger: (message) => console.error(message),
  });

  function isFatalPageError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('target page, context or browser has been closed')
      || msg.includes('browser has been closed')
      || msg.includes('page crashed')
      || msg.includes('browser closed')
      || msg.includes('crash')
      || msg.includes('execution context was destroyed');
  }

  async function recreatePage() {
    page = await browserSession.replacePage();
    recorder.instrumentPage(page, { label: 'return.visit.page' });
    console.error('[return-visit:execute] 已切换到新页面');
    return page;
  }

  async function openBrowserSession() {
    const session = await browserSession.open();
    return {
      ctx: session.ctx,
      browser: session.browser,
      page: session.page,
    };
  }

  async function restartBrowserSession(reason) {
    console.error(`[return-visit:execute] 重启浏览器会话 reason=${reason}`);
    const session = await browserSession.restart(reason);
    recorder.instrumentPage(session.page, { label: 'return.visit.page' });
    return session;
  }

  try {
    let ctx = null;
    try {
      const session = await openBrowserSession();
      ctx = session.ctx;
      browser = session.browser;
      page = session.page;
      recorder.instrumentPage(page, { label: 'return.visit.page' });
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
      await recorder.capture(page, 'return_visit.task.start', {
        index,
        taskId: task.taskId,
        taskStatus: task.status,
        workId: task?.targetWork?.workId || '',
      });
      if (index > 0) {
        page = await recreatePage();
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
            const nextSession = await restartBrowserSession('fatal_page_error');
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
        if (result.code === RESULT_CODES.IDENTITY_NOT_VERIFIED || result.error === 'security_verification_required') {
          log(args.json, '[return-visit:execute] 检测到手机号/短信安全认证，暂停自动操作并等待人工验证');
          if (args.json) break;
          const verificationWait = await waitForSecurityVerificationResolution(page, {
            timeoutMs: securityVerificationWaitMs,
            logger: (message) => log(args.json, message),
          });
          if (!verificationWait.ok) break;
          consecutiveFailures = 0;
        }
      }
      await recorder.capture(page, 'return_visit.task.finish', {
        index,
        taskId: task.taskId,
        resultStatus: result.status || 'unknown',
        ok: result.ok,
      });

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
    run.scanned = tasks.length;
    run.planned = tasks.length;
    run.processed = done + skipped + failed;
    run.succeeded = done;
    run.skipped = skipped;
    run.failed = failed;
    log(args.json, `[return-visit:execute] summary done=${done} skipped=${skipped} failed=${failed}`);

    if (browser && !args.keepOpen) {
      await browserSession.close();
    }
    if (args.json) {
      printJsonResult('return-visit:execute', { tasks: taskResults }, summary);
    }
  } finally {
    saveRunSummary(run);
    recorder.stopConsoleCapture();
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
