// 二次确认发送命令（dry-run 成功后，用户明确说"发送"）
// 将 action 状态从 dry_run_ok 变为 execute_confirmed，
// 之后 comments:execute --execute 才能真实发送。
//
// 用法：
//   npm run actions:confirm-execute -- --action-id <id> --json

import { runMigrations } from '../db/migrations.mjs';
import { getActionWithEvent, confirmExecuteAction } from '../db/action-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { actionId: null, json: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
    if (argv[i] === '--json') args.json = true;
  }

  return args;
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));

  if (!args.actionId) {
    printJsonError('actions:confirm-execute', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id', { recoverable: false }); return;
  }

  const action = getActionWithEvent(args.actionId);
  if (!action) {
    printJsonError('actions:confirm-execute', RESULT_CODES.BLOCKED,
      `找不到动作 ID=${args.actionId}`, { recoverable: false }); return;
  }

  if (action.status !== 'dry_run_ok') {
    printJsonError('actions:confirm-execute', RESULT_CODES.ACTION_NOT_APPROVED,
      `确认发送要求动作状态为 dry_run_ok，当前: ${action.status}`, { recoverable: false }); return;
  }

  const ok = confirmExecuteAction(args.actionId);
  if (!ok) {
    printJsonError('actions:confirm-execute', RESULT_CODES.BLOCKED,
      `确认失败：动作 #${args.actionId} 状态可能已变更`, { recoverable: false }); return;
  }

  const result = {
    actionId: args.actionId,
    status: 'execute_confirmed',
    actorName: action.actorName,
    commentText: action.commentText,
    replyText: action.actionText,
  };

  if (args.json) {
    printJsonResult('actions:confirm-execute', result, { actionId: args.actionId });
  } else {
    console.error(`[confirm] 动作 #${args.actionId} 已确认发送`);
    console.error(`  目标: ${action.actorName}`);
    console.error(`  回复: ${action.actionText.slice(0, 40)}`);
    console.error(`  状态: execute_confirmed（可执行真实发送）`);
  }
}

main();
