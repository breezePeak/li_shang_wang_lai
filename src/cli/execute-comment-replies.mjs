/**
 * comments:reply — 执行评论回复计划
 */
import { createBrowserContext } from '../browser/browser-context.mjs';
import { ensureCommentPageReady, waitForCommentsArea, openReplyBox, sendReply } from '../adapters/comment-page.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

function parseArgs(argv) {
  const args = { plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' && argv[i + 1]) { args.plan = argv[++i]; }
  }
  return args;
}

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  if (!args.plan) {
    console.error('用法: npm run comments:reply -- --plan <计划文件路径>');
    process.exit(1);
  }

  if (!existsSync(args.plan)) {
    console.error(`计划文件不存在: ${args.plan}`);
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  const approved = (plan.items || []).filter(i => i.approved);

  if (approved.length === 0) {
    console.log('[reply] 计划中没有 approved: true 的评论。');
    process.exit(0);
  }

  console.log(`[reply] 共 ${approved.length} 条待回复`);

  let browser = null;
  const results = [];
  let success = 0;

  try {
    console.log('[reply] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    await ensureCommentPageReady(page);
    await waitForCommentsArea(page);

    for (let i = 0; i < approved.length; i++) {
      const item = approved[i];
      console.log(`\n[reply] [${i + 1}/${approved.length}] ${item.actorName}: "${item.commentText.slice(0, 40)}"`);

      const r = { eventId: item.eventId, actorName: item.actorName, status: 'failed', reason: '' };

      try {
        const opened = await openReplyBox(page, item.commentText);
        if (!opened) { r.reason = '找不到回复按钮'; results.push(r); console.log('[reply]   ✗ 找不到回复按钮'); continue; }

        const sent = await sendReply(page, item.replyText);
        if (sent) {
          r.status = 'succeeded'; success++;
          const db = getDb();
          db.prepare("UPDATE interaction_events SET status='replied',updated_at=? WHERE id=?")
            .run(new Date().toISOString(), item.eventId);
          console.log('[reply]   ✓ 已回复');
        } else {
          r.reason = '发送失败';
          console.log('[reply]   ✗ 发送失败');
        }
      } catch (err) {
        r.reason = err.message;
        console.log(`[reply]   ✗ ${err.message}`);
      }

      results.push(r);
      if (i < approved.length - 1) await page.waitForTimeout(1000);
    }
  } catch (err) {
    console.error('[reply] 错误:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      console.log('[reply] 回复完成，浏览器保持打开。手动关闭或 Ctrl+C 退出。');
      // Keep browser open for manual review
      await new Promise(() => {});
    }
  }

  const rd = path.resolve('data', 'plans');
  ensureDir(rd);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeJSON(path.join(rd, `reply-result-${ts}.json`), { plan: args.plan, results, success, total: approved.length });
  console.log(`[reply] ${success}/${approved.length} 成功`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
