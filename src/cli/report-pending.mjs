// 待处理互动报告命令
// 查询本地数据库中未完成的互动事件（非 succeeded/blocked），按评论和点赞分类输出。
// 同时关联 actions 表返回最近的动作状态。
// Skill 可调用此命令获取待处理摘要，无需解析计划文件或直接查库。
//
// 用法：
//   node src/cli/report-pending.mjs
//   node src/cli/report-pending.mjs --json
//   node src/cli/report-pending.mjs --type comment --json

import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { json: false, type: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--type' && argv[i + 1]) args.type = argv[++i];
  }

  return args;
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const filterType = args.type;

  // Validate --type
  if (filterType && !['comment', 'like'].includes(filterType)) {
    if (args.json) {
      printJsonError('actions:pending', RESULT_CODES.INVALID_ARGUMENTS,
        `--type 仅允许 comment 或 like，收到: ${filterType}`, { recoverable: false }); return;
    } else {
      console.error(`--type 仅允许 comment 或 like，收到: ${filterType}`);
    }
    process.exit(1);
  }

  const db = getDb();

  try {
    // Query events that are NOT succeeded or blocked (i.e., still pending)
    const pendingEvents = db.prepare(`
      SELECT * FROM interaction_events
      WHERE status NOT IN ('succeeded', 'blocked')
      ORDER BY created_at DESC
      LIMIT 200
    `).all();

    // Query blocked events with reasons — use parameterized SQL
    let blockedQuery = `
      SELECT e.*, a.reason as blockReason, a.status as actionStatus,
             a.evidence_json, a.screenshot_path
      FROM interaction_events e
      LEFT JOIN actions a ON a.event_id = e.id AND a.id IN (
        SELECT MAX(id) FROM actions GROUP BY event_id
      )
      WHERE e.status = 'blocked'
    `;
    const blockedParams = [];
    if (filterType) {
      blockedQuery += ' AND e.event_type = ?';
      blockedParams.push(filterType);
    }
    blockedQuery += ' ORDER BY e.updated_at DESC LIMIT 50';

    const blockedEvents = db.prepare(blockedQuery).all(...blockedParams);

    const blockedItems = blockedEvents.map(ev => ({
      eventId: ev.id,
      actorName: ev.actor_name,
      eventType: ev.event_type,
      blockReason: ev.blockReason || '未知原因',
      actionStatus: ev.actionStatus || 'blocked',
      eventTimeText: ev.event_time_text,
      myWorkTitle: ev.my_work_title || '',
      commentText: ev.comment_text || '',
      evidenceJson: ev.evidence_json || null,
      screenshotPath: ev.screenshot_path || null,
      retryTarget: ev.id,
    }));

    // Query latest action status for each event
    const latestActions = db.prepare(`
      SELECT a.event_id, a.status as actionStatus, a.action_text as actionText
      FROM actions a
      WHERE a.id IN (
        SELECT MAX(id) FROM actions GROUP BY event_id
      )
    `).all();
    const actionMap = {};
    for (const act of latestActions) {
      actionMap[act.event_id] = { actionStatus: act.actionStatus, actionText: act.actionText };
    }

    const comments = [];
    const likes = [];

    for (const ev of pendingEvents) {
      const latestAction = actionMap[ev.id] || null;

      const item = {
        eventId: ev.id,
        actorName: ev.actor_name,
        relation: ev.relation,
        myWorkTitle: ev.my_work_title || '',
        commentText: ev.comment_text || '',
        eventTimeText: ev.event_time_text || '',
        eventStatus: ev.status,
        ...(latestAction ? { latestActionStatus: latestAction.actionStatus } : {}),
      };

      if (ev.event_type === 'comment') {
        if (!filterType || filterType === 'comment') {
          comments.push(item);
        }
      } else if (ev.event_type === 'like') {
        if (!filterType || filterType === 'like') {
          likes.push({
            ...item,
            previewOnly: true,
            executeAllowed: false,
          });
        }
      }
    }

    if (args.json) {
      printJsonResult('actions:pending', {
        comments,
        likes,
        blocked: blockedItems,
      }, {
        pendingComments: comments.length,
        pendingLikes: likes.length,
        blocked: blockedItems.length,
      });
    } else {
      // Human-readable output
      console.error('');
      console.error('===== 待处理互动摘要 =====');
      console.error('');
      console.error(`未处理评论: ${comments.length} 条`);
      for (const c of comments) {
        const actionTag = c.latestActionStatus ? ` [${c.latestActionStatus}]` : '';
        console.error(`  [${c.eventId}]${actionTag} ${c.actorName} 在《${c.myWorkTitle}》评论: ${c.commentText.slice(0, 40)}`);
      }
      console.error('');
      console.error(`未处理点赞: ${likes.length} 条`);
      for (const l of likes) {
        console.error(`  [${l.eventId}] ${l.actorName} [${l.relation}] — 仅预览`);
      }
      if (blockedItems.length > 0) {
        console.error('');
        console.error(`阻断项: ${blockedItems.length} 条（需人工检查）`);
        for (const b of blockedItems) {
          console.error(`  [${b.eventId}] ${b.actorName} — ${b.blockReason}`);
        }
      }
      console.error('');
    }
  } catch (err) {
    if (args.json) {
      printJsonError('actions:pending', 'UNKNOWN_ERROR', err.message, { recoverable: false }); return;
    } else {
      console.error('[report-pending] 错误:', err.message);
    }
    process.exit(1);
  }
}

main();

