import { runMigrations } from '../db/migrations.mjs';
import { getActionWithEvent, updateActionStatus } from '../db/action-repository.mjs';
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
    printJsonError('actions:reset-blocked', RESULT_CODES.BLOCKED, '缺少参数 --action-id', { recoverable: false });
    return;
  }

  const action = getActionWithEvent(args.actionId);
  if (!action) {
    printJsonError('actions:reset-blocked', RESULT_CODES.BLOCKED, `找不到动作 ID=${args.actionId}`, { recoverable: false });
    return;
  }
  if (action.status !== 'blocked') {
    printJsonError('actions:reset-blocked', RESULT_CODES.BLOCKED, `动作 #${args.actionId} 当前状态为 ${action.status}，只有 blocked 可重置`, { recoverable: false });
    return;
  }

  updateActionStatus(args.actionId, 'prepared', 'reset from blocked for retry');
  updateEventStatus(action.eventId, 'planned');

  printJsonResult('actions:reset-blocked', {
    actionId: args.actionId,
    eventId: action.eventId,
    status: 'prepared',
    next: `npm run comments:execute -- --items-file <待回复JSON> --execute`,
  }, { reset: 1 });
}

main();
