import { runMigrations } from '../db/migrations.mjs';
import { loadConfig } from '../config/user-config.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import {
  RETURN_VISIT_STATUS,
  getReturnVisitTask,
  updateReturnVisitTask,
} from '../services/return-visit-task-service.mjs';
import { validateXiaoyuanComment } from '../services/return-visit-comment-generator.mjs';

function parseArgs(argv) {
  const args = { json: false, taskId: '', comment: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--task-id' && i + 1 < argv.length) args.taskId = String(argv[++i]).trim();
    else if (arg === '--comment' && i + 1 < argv.length) args.comment = String(argv[++i]).trim();
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
  loadConfig();

  if (!args.taskId) {
    if (args.json) {
      printJsonError('return-visit:comment', RESULT_CODES.INVALID_ARGUMENTS, '--task-id 是必填参数', { recoverable: false });
      return;
    }
    console.error('[return-visit:comment] error: --task-id 是必填参数');
    process.exit(1);
  }

  if (!args.comment) {
    if (args.json) {
      printJsonError('return-visit:comment', RESULT_CODES.INVALID_ARGUMENTS, '--comment 是必填参数', { recoverable: false });
      return;
    }
    console.error('[return-visit:comment] error: --comment 是必填参数');
    process.exit(1);
  }

  const task = getReturnVisitTask(args.taskId);
  if (!task) {
    if (args.json) {
      printJsonError('return-visit:comment', RESULT_CODES.UNKNOWN_ERROR, `任务不存在: ${args.taskId}`, { recoverable: false });
      return;
    }
    console.error(`[return-visit:comment] error: 任务不存在: ${args.taskId}`);
    process.exit(1);
  }

  if (task.status !== RETURN_VISIT_STATUS.CONTENT_COLLECTED) {
    if (args.json) {
      printJsonError('return-visit:comment', RESULT_CODES.INVALID_ARGUMENTS,
        `任务状态必须是 ${RETURN_VISIT_STATUS.CONTENT_COLLECTED}，当前: ${task.status}`, { recoverable: false });
      return;
    }
    console.error(`[return-visit:comment] error: 任务状态必须是 ${RETURN_VISIT_STATUS.CONTENT_COLLECTED}，当前: ${task.status}`);
    process.exit(1);
  }

  const refComments = Array.isArray(task.referenceComments) ? task.referenceComments : [];
  const workTitle = (task.targetWork && task.targetWork.workTitle) || '';
  if (!validateXiaoyuanComment(args.comment, refComments, workTitle)) {
    if (args.json) {
      printJsonError('return-visit:comment', RESULT_CODES.BLOCKED,
        '评论未通过小猿人格校验', { recoverable: true });
      return;
    }
    console.error('[return-visit:comment] error: 评论未通过小猿人格校验');
    process.exit(1);
  }

  updateReturnVisitTask(task.taskId, {
    status: RETURN_VISIT_STATUS.PENDING_EXECUTE,
    generatedComment: args.comment,
    commentStatus: 'generated',
    generatedAt: new Date().toISOString(),
    lastError: null,
  });

  log(args.json, `[return-visit:comment] comment written to task ${args.taskId}, status=pending_execute`);
  if (args.json) {
    printJsonResult('return-visit:comment', { taskId: args.taskId, comment: args.comment });
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/set-return-visit-comment.mjs') ||
  process.argv[1].endsWith('\\set-return-visit-comment.mjs')
);

if (isMain) {
  main().catch((err) => {
    console.error('[return-visit:comment] error:', err.message);
    if (process.argv.includes('--json')) {
      printJsonError('return-visit:comment', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    }
    process.exit(1);
  });
}
