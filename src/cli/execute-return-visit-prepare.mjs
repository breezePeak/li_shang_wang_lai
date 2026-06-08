import { runMigrations } from '../db/migrations.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  createOrUpdateReturnVisitTasksFromEvents,
  listReturnVisitPrepareTasks,
} from '../services/return-visit-task-service.mjs';

function parseArgs(argv) {
  const args = {
    json: false,
    keepOpen: false,
    headless: false,
    eventStatus: null,
    unsupportedItemsFile: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--event-status' && i + 1 < argv.length) args.eventStatus = String(argv[++i] || '').trim() || null;
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

async function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  if (args.unsupportedItemsFile) {
    printJsonError(
      'return-visit:prepare',
      RESULT_CODES.INVALID_ARGUMENTS,
      'return-visit:prepare 不再支持 --items-file；回访任务只从数据库创建/查询，不再读写 JSON 文件',
      { recoverable: false }
    );
    return;
  }
  const config = loadConfig();
  const returnVisitConfig = config.returnVisit || {};

  const eventStatus = args.eventStatus || returnVisitConfig.eventSourceStatus || 'new';
  const maxRetryCount = Number(returnVisitConfig.maxRetryCount ?? 2);
  let sourceSummary;
  let tasks;
  try {
    sourceSummary = createOrUpdateReturnVisitTasksFromEvents({
      status: eventStatus,
    });
    tasks = listReturnVisitPrepareTasks({
      maxRetryCount,
    });
  } catch (err) {
    if (args.json) {
      printJsonError('return-visit:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
      return;
    }
    throw err;
  }

  log(args.json, `[return-visit:prepare] sourced events: ${sourceSummary.totalEvents}, inserted=${sourceSummary.inserted}, enriched=${sourceSummary.enriched}, skipped=${sourceSummary.skipped}`);
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

  const summary = {
    loaded: tasks.length,
    prepared: tasks.length,
    skipped: 0,
    failed: 0,
    inserted: sourceSummary.inserted,
    enriched: sourceSummary.enriched,
    sourceSkipped: sourceSummary.skipped,
  };

  log(args.json, `[return-visit:prepare] 已准备 DB 回访任务: ${tasks.length} 条，不生成 JSON 文件`);
  console.error('[return-visit:prepare] Agent 提示: 直接执行 visit:run/return-visit:execute，执行阶段会调用 Hermes/OpenClaw 生成评论');
  if (args.json) {
    printJsonResult('return-visit:prepare', { tasks }, summary);
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
