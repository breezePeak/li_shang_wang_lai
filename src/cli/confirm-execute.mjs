// 二次确认发送命令（dry-run 成功后，用户明确说"发送"）
// 将 action 状态从 dry_run_ok 变为 execute_confirmed，
// 之后 comments:execute --execute 才能真实发送。
//
// 用法：
//   npm run actions:confirm-execute -- --action-id <id> --json

import { runMigrations } from '../db/migrations.mjs';
import { getActionWithEvent, confirmExecuteAction, getActionsByStatus } from '../db/action-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { actionId: null, actionIds: [], allDryRunOk: false, json: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
    if (argv[i] === '--action-ids' && argv[i + 1]) args.actionIds = argv[++i].split(',').map(v => parseInt(v.trim())).filter(Boolean);
    if (argv[i] === '--all-dry-run-ok') args.allDryRunOk = true;
    if (argv[i] === '--json') args.json = true;
  }

  return args;
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));

  let actionIds = [];
  if (args.allDryRunOk) {
    actionIds = getActionsByStatus('dry_run_ok', 200).map(action => action.id);
  } else {
    actionIds = args.actionIds.length > 0 ? args.actionIds : (args.actionId ? [args.actionId] : []);
  }

  if (actionIds.length === 0) {
    printJsonError('actions:confirm-execute', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id、--action-ids 或 --all-dry-run-ok', { recoverable: false }); return;
  }

  const results = [];
  for (const actionId of actionIds) {
    const action = getActionWithEvent(actionId);
    if (!action) {
      results.push({ actionId, ok: false, error: `找不到动作 ID=${actionId}` });
      continue;
    }
    if (action.status !== 'dry_run_ok') {
      results.push({ actionId, ok: false, status: action.status, error: `确认发送要求动作状态为 dry_run_ok` });
      continue;
    }
    const ok = confirmExecuteAction(actionId);
    results.push(ok
      ? { actionId, ok: true, status: 'execute_confirmed', actorName: action.actorName, commentText: action.commentText, replyText: action.actionText }
      : { actionId, ok: false, error: `确认失败：动作状态可能已变更` });
  }

  const confirmed = results.filter(r => r.ok).length;
  const failed = results.length - confirmed;
  if (results.length === 1 && failed === 1) {
    printJsonError('actions:confirm-execute', RESULT_CODES.BLOCKED, results[0].error, {
      recoverable: false,
      data: results[0],
    });
    return;
  }

  if (args.json) {
    printJsonResult('actions:confirm-execute', { results }, { confirmed, failed });
  } else {
    console.error(`[confirm] 已确认 ${confirmed} 条，失败 ${failed} 条`);
    for (const item of results) {
      if (item.ok) console.error(`  [${item.actionId}] execute_confirmed ${item.replyText.slice(0, 40)}`);
      else console.error(`  [${item.actionId}] failed ${item.error}`);
    }
  }
}

main();
