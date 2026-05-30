import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPlanItemFromEvent } from '../domain/reply-template.mjs';

function parseArgs(argv) {
  const args = {
    maxItems: 20,
    status: 'new',
    output: null,
    includeMissingWorkTitle: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-items' && argv[i + 1]) {
      const n = parseInt(argv[++i]);
      if (!isNaN(n) && n > 0) args.maxItems = n;
    } else if (argv[i] === '--status' && argv[i + 1]) {
      args.status = argv[++i];
    } else if (argv[i] === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (argv[i] === '--include-missing-work-title') {
      args.includeMissingWorkTitle = true;
    }
  }

  return args;
}

function getPlanTimestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${h}-${min}-${s}`;
}

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const now = new Date().toISOString();

  // Fetch comment events with given status
  const events = db.prepare(`
    SELECT * FROM interaction_events
    WHERE event_type = 'comment' AND status = ?
    ORDER BY created_at DESC
  `).all(args.status);

  if (events.length === 0) {
    console.log(`[comments:plan] 没有状态为 "${args.status}" 的评论事件`);
    const plan = buildEmptyPlan(now, args);
    writePlanFile(plan, args);
    return;
  }

  console.log(`[comments:plan] 候选评论: ${events.length}`);

  // Prepare dedup query: find succeeded reply_comment actions
  const succeededActionIds = new Set();
  const succeededRows = db.prepare(`
    SELECT event_id FROM actions
    WHERE action_type = 'reply_comment' AND status = 'succeeded'
  `).all();
  for (const row of succeededRows) {
    succeededActionIds.add(row.event_id);
  }

  let planned = 0;
  let skipped = 0;
  const items = [];

  for (const event of events) {
    if (items.length >= args.maxItems) {
      skipped += events.length - planned - skipped;
      break;
    }

    // Skip events without comment text
    if (!event.comment_text || !event.comment_text.trim()) {
      skipped++;
      continue;
    }

    // Skip events that already have a succeeded reply
    if (succeededActionIds.has(event.id)) {
      skipped++;
      continue;
    }

    // Skip events without workTitle unless flag is set
    if (!event.my_work_title || !event.my_work_title.trim()) {
      if (!args.includeMissingWorkTitle) {
        skipped++;
        continue;
      }
    }

    const item = buildPlanItemFromEvent(event);

    if (args.includeMissingWorkTitle && (!event.my_work_title || !event.my_work_title.trim())) {
      item.warnings = ['missing workTitle, comments:reply may block at select-work'];
    }

    items.push(item);
    planned++;
  }

  const planId = `comment-reply-plan-${getPlanTimestamp()}`;
  const plan = {
    planId,
    type: 'comment_reply',
    createdAt: now,
    source: 'interaction_events',
    items,
    summary: {
      totalCandidates: events.length,
      planned,
      skipped,
      maxItems: args.maxItems,
    },
  };

  writePlanFile(plan, args);

  console.log(`[comments:plan] 已生成计划: ${planned}`);
  console.log(`[comments:plan] 已跳过: ${skipped}`);
  console.log(`[comments:plan] 输出文件: ${plan._outputPath}`);
}

function buildEmptyPlan(now, args) {
  const planId = `comment-reply-plan-${getPlanTimestamp()}`;
  return {
    planId,
    type: 'comment_reply',
    createdAt: now,
    source: 'interaction_events',
    items: [],
    summary: {
      totalCandidates: 0,
      planned: 0,
      skipped: 0,
      maxItems: args.maxItems,
    },
    _outputPath: args.output || path.resolve('data', 'plans', `${planId}.json`),
  };
}

function writePlanFile(plan, args) {
  const planId = plan.planId;
  const plansDir = path.resolve('data', 'plans');
  ensureDir(plansDir);
  const outPath = args.output || path.join(plansDir, `${planId}.json`);
  plan._outputPath = outPath;
  writeJSON(outPath, plan);
  delete plan._outputPath;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[comments:plan] 错误:', err.message);
    process.exit(1);
  });
}
