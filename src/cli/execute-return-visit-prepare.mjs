import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  RETURN_VISIT_STATUS,
  createOrUpdateReturnVisitTasksFromEvents,
  listReturnVisitPrepareTasks,
  listReturnVisitTasksByIds,
  updateReturnVisitTask,
  markReturnVisitFailure,
} from '../services/return-visit-task-service.mjs';
import { collectFirstNonTopAwemeFromProfile } from '../services/return-visit-work-collector.mjs';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { writeJSON } from '../utils/filesystem.mjs';

function parseArgs(argv) {
  const args = {
    json: false,
    keepOpen: false,
    headless: false,
    eventStatus: null,
    itemsFile: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--event-status' && i + 1 < argv.length) args.eventStatus = String(argv[++i] || '').trim() || null;
    else if (arg === '--items-file' && i + 1 < argv.length) args.itemsFile = String(argv[++i] || '').trim();
  }

  return args;
}

function loadVisitItems(itemsFile) {
  const parsed = JSON.parse(readFileSync(resolve(itemsFile), 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.users)) return parsed.users;
  if (Array.isArray(parsed?.items)) return parsed.items;
  throw new Error('--items-file 必须是 interactions:scan 生成的最小待回访数组');
}

function log(useJson, ...args) {
  if (useJson) console.error(...args);
  else console.log(...args);
}

function writePendingVisitCommentJson(items) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = resolve('data', 'pending-visits', `pending-visit-comments-${ts}.json`);
  writeJSON(filePath, items);
  return { filePath, totalItems: items.length };
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const eventStatus = args.eventStatus || returnVisitConfig.eventSourceStatus || 'new';
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  const maxWorksToCheck = Number(returnVisitConfig.maxWorksToCheck ?? 2);
  const pageLoadRetryCount = Number(returnVisitConfig.pageLoadRetryCount ?? 1);
  const maxConsecutiveFailures = Number(returnVisitConfig.maxConsecutiveFailures ?? 3);

  let sourceSummary;
  let tasks;
  try {
    if (args.itemsFile) {
      const items = loadVisitItems(args.itemsFile);
      const ids = items.map(item => item.id || item.task_id || '').filter(Boolean);
      tasks = listReturnVisitTasksByIds(ids);
      sourceSummary = {
        totalItems: items.length,
        inserted: 0,
        enriched: tasks.length,
        skipped: Math.max(0, items.length - tasks.length),
      };
    } else {
      sourceSummary = createOrUpdateReturnVisitTasksFromEvents({
        status: eventStatus,
      });
      tasks = listReturnVisitPrepareTasks({
        maxRetryCount,
      });
    }
  } catch (err) {
    if (args.json) {
      printJsonError('return-visit:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
      return;
    }
    throw err;
  }

  log(args.json, `[return-visit:prepare] sourced ${args.itemsFile ? 'json users' : 'events'}: ${sourceSummary.totalEvents ?? sourceSummary.totalItems}, inserted=${sourceSummary.inserted}, enriched=${sourceSummary.enriched}, skipped=${sourceSummary.skipped}`);
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
  const preparedItems = [];

  for (const task of tasks) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      log(args.json, `[return-visit:prepare] 连续失败 ${consecutiveFailures} 个任务，暂停本轮执行`);
      break;
    }

    const profileUrl = task.userProfileUrl || (task.userId ? `https://www.douyin.com/user/${task.userId}` : null);
    const actorName = task.userName || task.taskId;
    log(args.json, `[return-visit:prepare] opening profile: ${actorName}`);

    if (!profileUrl) {
      log(args.json, `[return-visit:prepare] 跳过 ${actorName}: 缺少主页 URL`);
      updateReturnVisitTask(task.taskId, {
        status: RETURN_VISIT_STATUS.SKIPPED_NO_WORK,
        lastError: 'skip_no_homepage_url',
      });
      taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.SKIPPED_NO_WORK, reason: 'skip_no_homepage_url' });
      skipped++;
      consecutiveFailures = 0;
      continue;
    }

    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.COLLECTING_CONTENT,
      lastError: null,
      userProfileUrl: profileUrl,
    });

    const collected = await collectFirstNonTopAwemeFromProfile(page, profileUrl, {
      pageLoadRetryCount,
    });

    if (!collected.ok) {
      if (collected.status === 'skipped') {
        log(args.json, `[return-visit:prepare] 跳过 ${actorName}: ${collected.reason || '无法采集作品'}`);
        updateReturnVisitTask(task.taskId, {
          status: RETURN_VISIT_STATUS.SKIPPED_NO_WORK,
          lastError: collected.reason || 'skip_post_api_empty',
        });
        taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.SKIPPED_NO_WORK, reason: collected.reason || 'skip_post_api_empty' });
        skipped++;
        consecutiveFailures = 0;
      } else {
        log(args.json, `[return-visit:prepare] 采集失败 ${actorName}: ${collected.reason || 'collect_failed'}`);
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

    const selectedWork = collected.aweme;
    updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.CONTENT_COLLECTED,
      targetWork: {
        workId: selectedWork.awemeId,
        workUrl: selectedWork.workUrl,
        workTitle: selectedWork.itemTitle || selectedWork.desc || null,
        workText: selectedWork.desc || null,
        contentSummary: selectedWork.contentSummary,
        publishTime: selectedWork.publishTime,
        shareUrl: selectedWork.shareUrl,
        desc: selectedWork.desc,
        itemTitle: selectedWork.itemTitle,
        createTime: selectedWork.createTime,
        isTop: selectedWork.isTop,
        userDigged: selectedWork.userDigged,
        canComment: selectedWork.canComment,
        diggCount: selectedWork.diggCount,
        commentCount: selectedWork.commentCount,
        awemeType: selectedWork.awemeType,
        mediaType: selectedWork.mediaType,
        isMultiContent: selectedWork.isMultiContent,
      },
      referenceComments: [],
      likeStatus: Number(selectedWork.userDigged) === 1 ? 'already_liked' : 'pending',
      commentStatus: 'pending',
      collectedAt: new Date().toISOString(),
      lastError: null,
    });

    preparedItems.push({
      id: task.taskId,
      homepage_url: profileUrl,
      aweme_id: selectedWork.awemeId,
      aweme_url: selectedWork.workUrl,
      desc: selectedWork.desc || '',
      item_title: selectedWork.itemTitle || '',
      aweme_type: selectedWork.awemeType,
      media_type: selectedWork.mediaType,
      is_multi_content: selectedWork.isMultiContent,
      can_comment: Boolean(selectedWork.canComment),
      user_digged: Number(selectedWork.userDigged || 0),
      comment: '',
    });

    log(args.json, `[return-visit:prepare] collected work: ${selectedWork.workUrl}, status=content_collected`);
    taskResults.push({ taskId: task.taskId, status: RETURN_VISIT_STATUS.CONTENT_COLLECTED, workUrl: selectedWork.workUrl, awemeId: selectedWork.awemeId });
    prepared++;
    consecutiveFailures = 0;
  }

  const pendingCommentFile = writePendingVisitCommentJson(preparedItems);

  const summary = {
    loaded: tasks.length,
    prepared,
    skipped,
    failed,
    inserted: sourceSummary.inserted,
    enriched: sourceSummary.enriched,
    sourceSkipped: sourceSummary.skipped,
    pendingCommentFile: pendingCommentFile.filePath,
  };

  log(args.json, `[return-visit:prepare] summary prepared=${prepared} skipped=${skipped} failed=${failed}`);
  log(args.json, `[return-visit:prepare] 待填写评论 JSON: ${pendingCommentFile.filePath} (${pendingCommentFile.totalItems} 条)`);
  if (args.json) {
    printJsonResult('return-visit:prepare', { tasks: taskResults, pendingCommentFile }, summary);
  }

  if (browser && !args.keepOpen) {
    await browser.close();
  }

  // 消费后删除中间 JSON
  if (args.itemsFile) {
    try {
      const absPath = resolve(args.itemsFile);
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        log(args.json, `[return-visit:prepare] 已删除中间 JSON: ${args.itemsFile}`);
      }
    } catch {}
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
