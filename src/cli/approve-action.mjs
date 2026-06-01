// 动作审批命令
// 将一条 prepared 状态的 action 标记为 approved。
// 用户确认回复内容和目标后调用此命令。
//
// 用法：
//   npm run actions:approve -- --action-id <id>
//   npm run actions:approve -- --action-id <id> --json

import { runMigrations } from '../db/migrations.mjs';
import { getAction, approveAction, getActionsByStatus } from '../db/action-repository.mjs';
import { updateEventStatus } from '../db/interaction-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { actionId: null, actionIds: [], allPrepared: false, json: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
    if (argv[i] === '--action-ids' && argv[i + 1]) args.actionIds = argv[++i].split(',').map(v => parseInt(v.trim())).filter(Boolean);
    if (argv[i] === '--all-prepared') args.allPrepared = true;
    if (argv[i] === '--json') args.json = true;
  }

  return args;
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));

  let actionIds = [];
  if (args.allPrepared) {
    actionIds = getActionsByStatus('prepared', 200).map(action => action.id);
  } else {
    actionIds = args.actionIds.length > 0 ? args.actionIds : (args.actionId ? [args.actionId] : []);
  }

  if (actionIds.length === 0) {
    printJsonError('actions:approve', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id、--action-ids 或 --all-prepared', { recoverable: false }); return;
  }

  const results = [];
  for (const actionId of actionIds) {
    const action = getAction(actionId);
    if (!action) {
      results.push({ actionId, ok: false, error: `找不到动作 ID=${actionId}` });
      continue;
    }
    if (action.status !== 'prepared') {
      results.push({ actionId, ok: false, status: action.status, error: `只有 prepared 状态才能审批` });
      continue;
    }
    const ok = approveAction(actionId);
    if (ok) {
      updateEventStatus(action.event_id, 'approved');
      results.push({ actionId, ok: true, status: 'approved', targetTitle: action.target_title, replyText: action.action_text });
    } else {
      results.push({ actionId, ok: false, error: `审批失败：动作可能已被审批或不存在` });
    }
  }

  const approved = results.filter(r => r.ok).length;
  const failed = results.length - approved;
  if (results.length === 1 && failed === 1) {
    printJsonError('actions:approve', RESULT_CODES.BLOCKED, results[0].error, {
      recoverable: false,
      data: results[0],
    });
    return;
  }

  if (args.json) {
    printJsonResult('actions:approve', { results }, { approved, failed });
  } else {
    console.log(`[approve] 已审批 ${approved} 条，失败 ${failed} 条`);
    for (const item of results) {
      if (item.ok) console.log(`  [${item.actionId}] approved ${item.replyText}`);
      else console.log(`  [${item.actionId}] failed ${item.error}`);
    }
  }
}

main();
