import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import fs from 'fs';

function parseArgs(argv) {
  const args = { input: null, dryRun: false, commit: false, overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) args.input = argv[++i];
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--commit') args.commit = true;
    if (argv[i] === '--overwrite') args.overwrite = true;
  }
  return args;
}

function removeInputFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    console.error(`[replies:apply] 已删除输入文件: ${filePath}`);
  } catch (err) {
    console.error(`[replies:apply] ⚠ 删除输入文件失败: ${err.message}`);
  }
}

function main() {
  runMigrations();
  const db = getDb();
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('[replies:apply] 错误: 必须指定 --input <file>');
    process.exit(1);
  }

  if (!args.dryRun && !args.commit) {
    console.error('[replies:apply] 错误: 必须指定 --dry-run 或 --commit');
    process.exit(1);
  }

  let data;
  try {
    const raw = fs.readFileSync(args.input, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`[replies:apply] 错误: 读取或解析 JSON 失败: ${err.message}`);
    process.exit(1);
  }

  if (data.schemaVersion !== 'reply-result-v1') {
    console.error(`[replies:apply] 错误: schemaVersion 不匹配，期望 reply-result-v1，实际 ${data.schemaVersion}`);
    process.exit(1);
  }

  const replies = data.replies || [];
  console.error(`[replies:apply] 读取 ${replies.length} 条回复`);

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  for (const reply of replies) {
    const { commentId, commentKey, action, replyText, reason } = reply;

    if (!commentId || !commentKey) {
      console.error(`[replies:apply] ✗ commentId 或 commentKey 缺失: ${JSON.stringify(reply)}`);
      errors++;
      continue;
    }

    if (action !== 'reply' && action !== 'skip') {
      console.error(`[replies:apply] ✗ action 无效: ${action} (commentId=${commentId})`);
      errors++;
      continue;
    }

    if (action === 'reply' && (!replyText || !replyText.trim())) {
      console.error(`[replies:apply] ✗ action=reply 但 replyText 为空 (commentId=${commentId})`);
      errors++;
      continue;
    }

    if (replyText && replyText.length > 200) {
      console.error(`[replies:apply] ✗ replyText 超长 (${replyText.length} 字符, commentId=${commentId})`);
      errors++;
      continue;
    }

    const row = db.prepare('SELECT * FROM work_comments WHERE id = ?').get(commentId);
    if (!row) {
      console.error(`[replies:apply] ✗ commentId=${commentId} 不存在`);
      errors++;
      continue;
    }

    if (row.comment_key !== commentKey) {
      console.error(`[replies:apply] ✗ commentKey 不匹配: DB="${row.comment_key}" 输入="${commentKey}" (commentId=${commentId})`);
      errors++;
      continue;
    }

    if (row.reply_status !== 'pending' && !args.overwrite) {
      console.error(`[replies:apply] ✗ reply_status=${row.reply_status} 不是 pending (commentId=${commentId})，用 --overwrite 覆盖`);
      errors++;
      continue;
    }

    const now = new Date().toISOString();

    if (action === 'reply') {
      if (args.dryRun) {
        console.error(`[replies:apply] [dry-run] UPDATE commentId=${commentId}: reply_status=prepared, replyText="${replyText?.slice(0, 40)}"`);
      } else {
        db.prepare(
          "UPDATE work_comments SET reply_status = 'prepared', reply_text = ?, reply_reason = ?, last_seen_at = ? WHERE id = ? AND comment_key = ?"
        ).run(replyText, reason || null, now, commentId, commentKey);
        console.error(`[replies:apply] ✓ commentId=${commentId}: prepared, "${replyText?.slice(0, 40)}"`);
      }
      applied++;
    } else {
      if (args.dryRun) {
        console.error(`[replies:apply] [dry-run] UPDATE commentId=${commentId}: reply_status=skipped, reason="${reason}"`);
      } else {
        db.prepare(
          "UPDATE work_comments SET reply_status = 'skipped', reply_text = NULL, reply_reason = ?, last_seen_at = ? WHERE id = ? AND comment_key = ?"
        ).run(reason || null, now, commentId, commentKey);
        console.error(`[replies:apply] ✓ commentId=${commentId}: skipped, reason="${reason}"`);
      }
      skipped++;
    }
  }

  console.error(`\n[replies:apply] 完成: ${applied} 条回复, ${skipped} 条跳过, ${errors} 条错误`);
  if (args.dryRun) {
    console.error('[replies:apply] dry-run 模式，未写入数据库');
    return;
  }

  if (args.commit && errors === 0) {
    removeInputFile(args.input);
  }
}

main();
