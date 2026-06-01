import { runMigrations } from '../db/migrations.mjs';
import { getEvents } from '../db/interaction-repository.mjs';
import { printJsonResult } from '../utils/cli-output.mjs';

function parseArgs(argv) {
  const args = { json: false, limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--limit' && argv[i + 1]) {
      const n = parseInt(argv[++i]);
      args.limit = Number.isFinite(n) && n > 0 ? n : 200;
    }
  }
  return args;
}

function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));
  const events = getEvents({ limit: args.limit }).filter(ev => ev.event_type === 'like');
  const candidates = events.map(ev => ({
    eventId: ev.id,
    actorName: ev.actor_name,
    relation: ev.relation,
    myWorkTitle: ev.my_work_title || '',
    eventTimeText: ev.event_time_text || '',
    status: 'preview',
    previewOnly: true,
    executeAllowed: false,
  }));

  if (args.json) {
    printJsonResult('likes:plan', { candidates }, { candidates: candidates.length, previewOnly: true });
    return;
  }

  console.log(`[likes:plan] 预览候选 ${candidates.length} 条；真实点赞当前禁用。`);
  for (const item of candidates) {
    console.log(`  [${item.eventId}] ${item.actorName} ${item.eventTimeText}`);
  }
}

main();
