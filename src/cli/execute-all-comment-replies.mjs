import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../db/migrations.mjs';
import {
  getAction,
  getActionWithEvent,
  getActionsByStatus,
  hasSucceededAction,
  updateActionStatus,
} from '../db/action-repository.mjs';
import { updateEventStatus, getEvent } from '../db/interaction-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTE_SCRIPT = resolve(__dirname, 'execute-comment-reply.mjs');

function parseArgs(argv) {
  const args = {
    actionId: null,
    actionIds: [],
    allPrepared: false,
    execute: false,
    maxItems: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
    if (argv[i] === '--action-ids' && argv[i + 1]) args.actionIds = argv[++i].split(',').map(v => parseInt(v.trim())).filter(Boolean);
    if (argv[i] === '--all-prepared') args.allPrepared = true;
    if (argv[i] === '--execute') args.execute = true;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--max-items' && argv[i + 1]) {
      const n = parseInt(argv[++i]);
      args.maxItems = Number.isFinite(n) && n > 0 ? n : 20;
    }
  }

  return args;
}

function collectActionIds(args) {
  if (args.allPrepared) {
    return getActionsByStatus('prepared', args.maxItems).map(action => action.id);
  }
  if (args.actionIds.length > 0) return args.actionIds.slice(0, args.maxItems);
  if (args.actionId) return [args.actionId];
  return [];
}

function validateDataGate(action) {
  if (!action.commentText || action.commentText.trim().length === 0) {
    return `无法获取原始评论内容（eventId=${action.eventId}），无法定位目标评论`;
  }
  if (!action.actionText || action.actionText.trim().length === 0) {
    return '回复内容为空';
  }
  if (hasSucceededAction(action.eventId, 'reply_comment')) {
    return '该评论已有成功回复记录';
  }

  const event = getEvent(action.eventId);
  if (event && event.status === 'unstable') {
    return `事件 #${action.eventId} 仍处于 unstable 状态，无法执行`;
  }

  let evidence = {};
  try {
    const fullAction = getAction(action.actionId);
    evidence = fullAction?.evidence_json ? JSON.parse(fullAction.evidence_json) : {};
  } catch (err) {
    return `动作审计数据无法解析：${err.message}`;
  }
  if (evidence.autoExecuteAllowed === true) return 'autoExecuteAllowed 当前必须为 false，不允许自动真实发送';
  if (evidence.decision && evidence.decision !== 'reply') return `决策为 "${evidence.decision}"，不允许真实发送`;
  if (evidence.riskLevel && evidence.riskLevel !== 'low') return `风险等级为 "${evidence.riskLevel}"，不允许真实发送`;
  if (evidence.relevance === 'irrelevant') return '相关性为 irrelevant，不允许真实发送';
  if (evidence.replyMode === 'ignore') return 'replyMode=ignore 的评论不允许发送';

  return null;
}

function validatePreparedAction(actionId) {
  const action = getActionWithEvent(actionId);
  if (!action) return { actionId, ok: false, error: `找不到动作 ID=${actionId}` };

  if (action.status !== 'prepared') {
    return { actionId, ok: false, status: action.status, error: `状态 ${action.status} 不可由 execute-all 处理` };
  }

  const gateError = validateDataGate(action);
  if (gateError) return { actionId, ok: false, status: action.status, error: gateError };

  return {
    actionId,
    ok: true,
    status: 'prepared',
    actorName: action.actorName,
    replyText: action.actionText,
  };
}

function executeOne(actionId) {
  const result = spawnSync(process.execPath, [EXECUTE_SCRIPT, '--action-id', String(actionId), '--execute', '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: process.env,
  });
  const stdout = (result.stdout || '').trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { /* keep null */ }

  if (result.status !== 0 && !parsed) {
    return { actionId, ok: false, status: 'execute_failed', error: result.stderr || result.error?.message || '执行失败' };
  }
  if (parsed && parsed.ok === false) {
    return { actionId, ok: false, status: 'execute_failed', error: parsed.message || parsed.code, detail: parsed };
  }
  return { actionId, ok: true, status: 'succeeded', detail: parsed };
}

function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));
  const actionIds = collectActionIds(args);

  if (actionIds.length === 0) {
    printJsonError('comments:execute-all', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id、--action-ids 或 --all-prepared', { recoverable: false });
    return;
  }

  const results = [];
  for (const actionId of actionIds) {
    const validated = validatePreparedAction(actionId);
    if (!validated.ok) {
      results.push(validated);
      continue;
    }
    if (!args.execute) {
      results.push({ ...validated, mode: 'validate-only', next: `npm run comments:execute-all -- --action-id ${actionId} --execute` });
      continue;
    }
    results.push(executeOne(actionId));
  }

  const succeeded = results.filter(item => item.ok).length;
  const failed = results.length - succeeded;
  if (args.json) {
    printJsonResult('comments:execute-all', { results }, { succeeded, failed, execute: args.execute });
  } else {
    console.log(`[comments:execute-all] 成功 ${succeeded} 条，失败 ${failed} 条，真实执行=${args.execute}`);
    for (const item of results) {
      console.log(`  [${item.actionId}] ${item.ok ? item.status : `failed ${item.error}`}`);
    }
  }
}

main();
