import { runMigrations } from '../db/migrations.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  createOrUpdateReturnVisitTasksFromEvents,
  listReturnVisitPrepareTasks,
  listReturnVisitTasksByIds,
} from '../services/return-visit-task-service.mjs';
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

function toMinimalVisitItems(tasks) {
  return tasks.map(task => ({
    interactionId: (task.sourceEventIds || [])[0] || '',
    id: task.taskId,
    task_id: task.taskId,
    targetUserId: task.userId || '',
    profileUrl: task.userProfileUrl || '',
    homepage_url: task.userProfileUrl || '',
    workId: task.targetWork?.workId || '',
    interactionType: task.sourceType || 'like',
  }));
}

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const eventStatus = args.eventStatus || returnVisitConfig.eventSourceStatus || 'new';
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
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

  const minimalItems = toMinimalVisitItems(tasks);
  const pendingCommentFile = writePendingVisitCommentJson(minimalItems);
  const summary = {
    loaded: tasks.length,
    prepared: minimalItems.length,
    skipped: 0,
    failed: 0,
    inserted: sourceSummary.inserted,
    enriched: sourceSummary.enriched,
    sourceSkipped: sourceSummary.skipped,
    pendingCommentFile: pendingCommentFile.filePath,
  };

  log(args.json, `[return-visit:prepare] 已改为最小 JSON，不再打开主页采集作品: ${pendingCommentFile.filePath} (${pendingCommentFile.totalItems} 条)`);
  console.error('[return-visit:prepare] Agent 提示: 不再需要填写 comment 字段；启动 agent-server 后直接执行 visit:run/return-visit:execute');
  if (args.json) {
    printJsonResult('return-visit:prepare', { tasks: minimalItems, pendingCommentFile }, summary);
  }

  if (args.itemsFile) {
    try {
      const absPath = resolve(args.itemsFile);
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        log(args.json, `[return-visit:prepare] 已删除中间 JSON: ${args.itemsFile}`);
      }
    } catch {}
  }

  return;

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
