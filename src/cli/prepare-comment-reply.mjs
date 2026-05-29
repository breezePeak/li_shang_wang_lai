// 评论回复准备命令
// 根据 eventId 和 replyText 创建一条待审批的回复动作。
// 替代旧的手工编辑 JSON 计划文件中 replyText 和 approved 字段的方式。
//
// 用法：
//   npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>"
//   npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" --json

import { runMigrations } from '../db/migrations.mjs';
import { createAction, hasSucceededAction, hasActiveAction } from '../db/action-repository.mjs';
import { getEvents, updateEventStatus } from '../db/interaction-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { eventId: null, replyText: null, json: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event-id' && argv[i + 1]) args.eventId = parseInt(argv[++i]);
    if (argv[i] === '--reply-text' && argv[i + 1]) args.replyText = argv[++i];
    if (argv[i] === '--json') args.json = true;
  }

  return args;
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));

  // Validation
  if (!args.eventId) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      '缺少参数 --event-id', { recoverable: false }); return;
  }
  if (!args.replyText || args.replyText.trim().length === 0) {
    printJsonError('comments:prepare', RESULT_CODES.EMPTY_REPLY_TEXT,
      '回复内容不能为空，请提供 --reply-text', { recoverable: false }); return;
  }

  // Check the event exists and is a comment
  const events = getEvents({ limit: 500 });
  const ev = events.find(e => e.id === args.eventId);
  if (!ev) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `找不到事件 ID=${args.eventId}`, { recoverable: false }); return;
  }
  if (ev.event_type !== 'comment') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `事件 ID=${args.eventId} 不是评论类型`, { recoverable: false }); return;
  }
  if (ev.status === 'unstable') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `事件 ID=${args.eventId} 的相对时间尚未稳定，无法创建回复。请在时间稳定后重新扫描。`, { recoverable: false }); return;
  }

  // Check duplicate — already succeeded
  if (hasSucceededAction(args.eventId, 'reply_comment')) {
    printJsonError('comments:prepare', RESULT_CODES.DUPLICATE_ACTION,
      '该评论已有成功回复记录，不能重复创建', { recoverable: false }); return;
  }

  // P1-3: Check duplicate — active action already exists
  if (hasActiveAction(args.eventId, 'reply_comment')) {
    printJsonError('comments:prepare', RESULT_CODES.DUPLICATE_ACTION,
      '该评论已有活跃的回复动作（prepared/approved/dry_run_ok），不能重复创建。请先完成或取消已有动作。', { recoverable: false }); return;
  }

  // Create action
  const actionId = createAction({
    eventId: args.eventId,
    actionType: 'reply_comment',
    targetTitle: ev.my_work_title || '',
    actionText: args.replyText.trim(),
  });

  // P0-3: Sync event status to 'planned'
  updateEventStatus(args.eventId, 'planned');

  const result = {
    actionId,
    eventId: args.eventId,
    actorName: ev.actor_name,
    workTitle: ev.my_work_title,
    commentText: ev.comment_text,
    replyText: args.replyText.trim(),
    status: 'prepared',
  };

  if (args.json) {
    printJsonResult('comments:prepare', result, { actionId });
  } else {
    console.log(`[prepare] 已创建回复候选 #${actionId}`);
    console.log(`  目标用户: ${ev.actor_name}`);
    console.log(`  作品: ${ev.my_work_title}`);
    console.log(`  原评论: ${ev.comment_text}`);
    console.log(`  回复文本: ${args.replyText}`);
    console.log(`  状态: prepared（待审批）`);
  }
}

main();
