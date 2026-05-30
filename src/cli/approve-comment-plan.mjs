import { readFileSync, writeFileSync, existsSync } from 'fs';
import { approveCommentPlan } from '../domain/comment-plan-approval.mjs';

function parseArgs(argv) {
  const args = { plan: null, reason: null, output: null, dryRun: false, eventIds: [], indices: [] };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' && argv[i + 1]) { args.plan = argv[++i]; }
    else if (argv[i] === '--all') { args.all = true; }
    else if (argv[i] === '--none') { args.none = true; }
    else if (argv[i] === '--event-id' && argv[i + 1]) { args.eventIds.push(argv[++i]); }
    else if (argv[i] === '--index' && argv[i + 1]) { args.indices.push(Number(argv[++i])); }
    else if (argv[i] === '--reason' && argv[i + 1]) { args.reason = argv[++i]; }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
    else if (argv[i] === '--output' && argv[i + 1]) { args.output = argv[++i]; }
  }
  return args;
}

function resolveMode(args) {
  const flags = [];
  if (args.all) flags.push('--all');
  if (args.none) flags.push('--none');
  if (args.eventIds.length > 0) flags.push('--event-id');
  if (args.indices.length > 0) flags.push('--index');

  if (flags.length === 0) {
    return { ok: false, error: '请提供 --all / --none / --event-id / --index 至少一个参数' };
  }

  if (flags.length > 1) {
    return { ok: false, error: `参数冲突：${flags.join(' 和 ')} 不能同时使用` };
  }

  if (args.all) return { ok: true, mode: 'all' };
  if (args.none) return { ok: true, mode: 'none' };
  return { ok: true, mode: 'selected' };
}

function main() {
  console.error('[comments:approve-plan] 当前链路：评论回复计划审批');
  console.error('[comments:approve-plan] 行为：修改 plan.json 中 items[].approved');
  console.error('[comments:approve-plan] 不会打开浏览器，不会执行回复');

  const args = parseArgs(process.argv.slice(2));

  if (!args.plan) {
    console.error('[comments:approve-plan] 必须指定 --plan <path>');
    process.exit(1);
  }

  if (!existsSync(args.plan)) {
    console.error(`[comments:approve-plan] 文件不存在: ${args.plan}`);
    process.exit(1);
  }

  const modeResult = resolveMode(args);
  if (!modeResult.ok) {
    console.error(`[comments:approve-plan] ${modeResult.error}`);
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));

  const result = approveCommentPlan(plan, {
    mode: modeResult.mode,
    eventIds: args.eventIds,
    indices: args.indices,
    reason: args.reason,
  });

  if (!result.ok) {
    console.error(`[comments:approve-plan] ${result.error}`);
    process.exit(1);
  }

  const actionLabel = args.all ? 'approve all' : args.none ? 'reject all' : 'approve selected';

  console.log(`[comments:approve-plan] plan: ${args.plan}`);
  console.log(`[comments:approve-plan] mode: ${actionLabel}`);
  console.log(`[comments:approve-plan] changed: ${result.changed}`);
  console.log(`[comments:approve-plan] approved: ${result.approved}`);
  console.log(`[comments:approve-plan] pendingApproval: ${result.pendingApproval}`);

  if (args.dryRun) {
    console.log('[comments:approve-plan] dry-run，不写文件');
    return;
  }

  const outPath = args.output || args.plan;
  writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
  console.log(`[comments:approve-plan] output: ${outPath}`);
}

main();
