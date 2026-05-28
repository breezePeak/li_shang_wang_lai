/**
 * comments:plan — 从 DB 读取新评论，生成回复计划 JSON
 */
import { getEvents } from '../db/interaction-repository.mjs';
import { createPlan } from '../db/plan-repository.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import path from 'path';

function parseArgs(argv) {
  const args = { mode: 'manual', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) { args.mode = argv[++i]; }
    if (argv[i] === '--out' && argv[i + 1]) { args.out = argv[++i]; }
  }
  return args;
}

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  console.log('[plan] 读取未回复评论...');
  const comments = getEvents({ eventType: 'comment', status: 'new', limit: 50 });

  if (comments.length === 0) {
    console.log('[plan] 没有待回复的评论。先运行 npm run interactions:scan -- --type comment');
    process.exit(0);
  }

  console.log(`[plan] 找到 ${comments.length} 条待回复评论`);

  const items = comments.map(c => ({
    eventId: c.id,
    actorName: c.actor_name,
    workTitle: c.my_work_title || '',
    commentText: c.comment_text || '',
    commentTime: c.event_time_text || '',
    replyText: '',
    approved: false,
  }));

  const plan = {
    mode: args.mode,
    planType: 'comment_reply',
    createdAt: new Date().toISOString(),
    items,
  };

  const planDir = path.resolve('data', 'plans');
  ensureDir(planDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = args.out || path.join(planDir, `comments-plan-${timestamp}.json`);
  writeJSON(outPath, plan);
  console.log(`[plan] 计划已保存: ${outPath}`);

  const planId = createPlan({ planType: 'comment_reply', mode: args.mode, payload: plan });
  console.log(`[plan] DB 计划 ID: ${planId}`);

  console.log('');
  console.log('===== 预览 =====');
  for (const item of items) {
    console.log(`  [${item.eventId}] ${item.actorName}`);
    console.log(`    作品: ${item.workTitle.slice(0, 50)}`);
    console.log(`    评论: ${item.commentText}`);
    console.log('');
  }

  console.log('===== 下一步 =====');
  console.log(`1. 编辑 ${outPath.replace(/\\/g, '/')}，填写每条 replyText`);
  console.log('2. 将需要回复的评论 approved 设为 true');
  console.log(`3. 运行 npm run comments:reply -- --plan ${outPath.replace(/\\/g, '/')}`);
}

main().catch(err => {
  console.error('[plan] 错误:', err.message);
  process.exit(1);
});
