import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = { limit: 20, workId: null, out: null, pretty: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && i + 1 < argv.length) args.limit = parseInt(argv[++i]) || 20;
    if (argv[i] === '--work-id' && i + 1 < argv.length) args.workId = argv[++i];
    if (argv[i] === '--out' && i + 1 < argv.length) args.out = argv[++i];
    if (argv[i] === '--pretty') args.pretty = true;
    if (argv[i] === '--no-pretty') args.pretty = false;
  }
  return args;
}

function main() {
  runMigrations();
  const db = getDb();
  const args = parseArgs(process.argv.slice(2));

  let sql = "SELECT wc.*, w.work_title, w.work_url, w.work_type, w.modal_id FROM work_comments wc LEFT JOIN works w ON wc.work_id = w.work_id WHERE wc.reply_status = 'pending'";
  const params = [];
  if (args.workId) {
    sql += ' AND wc.work_id = ?';
    params.push(args.workId);
  }
  sql += ' ORDER BY wc.first_seen_at ASC LIMIT ?';
  params.push(args.limit);

  const rows = db.prepare(sql).all(...params);

  const worksMap = new Map();
  for (const row of rows) {
    const workKey = row.work_id || row.modal_id || '__unknown__';
    if (!worksMap.has(workKey)) {
      worksMap.set(workKey, {
        work: {
          workId: row.work_id || '',
          modalId: row.modal_id || '',
          workUrl: row.work_url || (row.modal_id ? `https://www.douyin.com/user/self?modal_id=${row.modal_id}` : ''),
          workTitle: row.work_title || '',
          workType: row.work_type || '',
        },
        comments: [],
      });
    }
    worksMap.get(workKey).comments.push({
      commentId: row.id,
      commentKey: row.comment_key,
      actorName: row.actor_name || '',
      commentText: row.comment_text || '',
      eventTimeText: row.event_time_text || '',
    });
  }

  const output = {
    schemaVersion: 'reply-export-v1',
    exportedAt: new Date().toISOString(),
    purpose: '请根据作品信息和评论内容，为每条评论生成自然、简短、像真人的回复。',
    fieldDefinitions: {
      work: {
        workId: '作品唯一标识，通常来自 modal_id 或视频 ID',
        workUrl: '作品地址，后续执行回复时会打开这个地址',
        workTitle: '作品标题或描述，用来帮助理解评论上下文',
      },
      comments: {
        commentId: '数据库 work_comments.id，导入回复时必须原样返回',
        commentKey: '评论去重键，导入回复时必须原样返回',
        actorName: '评论人的昵称',
        commentText: '评论原文',
        eventTimeText: '评论时间文本，可能为空',
      },
      replyRules: {
        action: 'reply 表示回复；skip 表示不回复',
        replyText: '要写入评论区的回复内容',
        reason: '为什么这样回复或为什么跳过',
      },
    },
    replyRules: {
      tone: '自然、简短、像真人',
      maxLength: 40,
      language: 'zh-CN',
      avoid: [
        '不要说自己是 AI',
        '不要过度营销',
        '不要重复模板',
        '不要出现明显机器味',
        '不要回复敏感、辱骂、广告、引战内容',
      ],
      fallback: '如果不知道怎么回复，action=skip',
    },
    outputSchema: {
      schemaVersion: 'reply-result-v1',
      replies: [
        {
          commentId: 1,
          commentKey: '张三::说得太对了',
          action: 'reply',
          replyText: '感谢支持，一起交流。',
          reason: '正向评论，适合简短感谢',
        },
      ],
    },
    works: [...worksMap.values()],
  };

  const json = args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);

  if (args.out) {
    ensureDir(path.dirname(args.out));
    fs.writeFileSync(args.out, json, 'utf-8');
    console.error(`[replies:export] 导出 ${rows.length} 条待回复评论到 ${args.out}`);
  } else {
    process.stdout.write(json);
    console.error(`\n[replies:export] 导出 ${rows.length} 条待回复评论到 stdout`);
  }
}

main();