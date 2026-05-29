// 待处理互动报告命令
// 查询本地数据库中状态为 'new' 的互动事件，按评论和点赞分类输出。
// Skill 可调用此命令获取待处理摘要，无需解析计划文件或直接查库。
//
// 用法：
//   node src/cli/report-pending.mjs
//   node src/cli/report-pending.mjs --json
//   node src/cli/report-pending.mjs --type comment --json

import { runMigrations } from '../db/migrations.mjs';
import { getEvents, getEventCounts } from '../db/interaction-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';

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

  try {
    // Query pending events (status = 'new')
    const pendingEvents = getEvents({ status: 'new', limit: 200 });

    const comments = [];
    const likes = [];
    let blocked = 0;

    for (const ev of pendingEvents) {
      const item = {
        eventId: ev.id,
        actorName: ev.actor_name,
        relation: ev.relation,
        myWorkTitle: ev.my_work_title || '',
        commentText: ev.comment_text || '',
        eventTimeText: ev.event_time_text || '',
        status: ev.status,
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

    // Also count blocked events
    const blockedEvents = getEvents({ status: 'blocked', limit: 200 });
    blocked = blockedEvents.length;

    const result = {
      data: {
        comments,
        likes,
      },
      summary: {
        pendingComments: comments.length,
        pendingLikes: likes.length,
        blocked,
      },
    };

    if (args.json) {
      printJsonResult('actions:pending', result.data, result.summary);
    } else {
      // Human-readable output
      console.log('');
      console.log('===== 待处理互动摘要 =====');
      console.log('');
      console.log(`未处理评论: ${comments.length} 条`);
      for (const c of comments) {
        console.log(`  [${c.eventId}] ${c.actorName} 在《${c.myWorkTitle}》评论: ${c.commentText.slice(0, 40)}`);
      }
      console.log('');
      console.log(`未处理点赞: ${likes.length} 条`);
      for (const l of likes) {
        console.log(`  [${l.eventId}] ${l.actorName} [${l.relation}] — 仅预览`);
      }
      if (blocked > 0) {
        console.log('');
        console.log(`阻断项: ${blocked} 条（需人工检查）`);
      }
      console.log('');
    }
  } catch (err) {
    if (args.json) {
      printJsonError('actions:pending', 'UNKNOWN_ERROR', err.message, { recoverable: false });
    } else {
      console.error('[report-pending] 错误:', err.message);
    }
    process.exit(1);
  }
}

main();
