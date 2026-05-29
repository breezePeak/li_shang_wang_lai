// 动作审批命令
// 将一条 prepared 状态的 action 标记为 approved。
// 用户确认回复内容和目标后调用此命令。
//
// 用法：
//   npm run actions:approve -- --action-id <id>
//   npm run actions:approve -- --action-id <id> --json

import { runMigrations } from '../db/migrations.mjs';
import { getAction, approveAction } from '../db/action-repository.mjs';
import { updateEventStatus } from '../db/interaction-repository.mjs';
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
    printJsonError('actions:approve', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id', { recoverable: false });
    process.exit(1);
  }

  const action = getAction(args.actionId);
  if (!action) {
    printJsonError('actions:approve', RESULT_CODES.BLOCKED,
      `找不到动作 ID=${args.actionId}`, { recoverable: false });
    process.exit(1);
  }

  if (action.status !== 'prepared') {
    printJsonError('actions:approve', RESULT_CODES.ACTION_NOT_APPROVED,
      `动作 #${args.actionId} 当前状态为 ${action.status}，只有 prepared 状态才能审批`, { recoverable: false });
    process.exit(1);
  }

  const ok = approveAction(args.actionId);
  if (!ok) {
    printJsonError('actions:approve', RESULT_CODES.BLOCKED,
      `审批失败：动作 #${args.actionId} 可能已被审批或不存在`, { recoverable: false });
    process.exit(1);
  }

  // P0-3: Sync event status to 'approved'
  updateEventStatus(action.event_id, 'approved');

  const result = {
    actionId: args.actionId,
    status: 'approved',
    targetTitle: action.target_title,
    replyText: action.action_text,
  };

  if (args.json) {
    printJsonResult('actions:approve', result, { actionId: args.actionId });
  } else {
    console.log(`[approve] 动作 #${args.actionId} 已审批`);
    console.log(`  回复内容: ${action.action_text}`);
    console.log(`  状态: approved（可执行 dry-run）`);
  }
}

main();
