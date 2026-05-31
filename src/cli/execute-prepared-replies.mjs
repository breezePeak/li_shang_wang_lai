import { createBrowserContext } from '../browser/browser-context.mjs';
import { ensureNotificationPageReady } from '../adapters/notification-page.mjs';
import { waitForWorkModal, findUnrepliedCommentsInModal, openReplyBoxByIndex, fillReplyInWorkModal, sendReplyInWorkModal, verifyReplyInWorkModal, detectVideoRemoved } from '../adapters/work-modal-page.mjs';
import { listPreparedComments, markCommentReplied, markCommentSentUnverified, markCommentBlocked } from '../db/work-comment-repository.mjs';
import { findWorkByWorkId, findWorkByModalId } from '../db/work-repository.mjs';
import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

async function main() {
  console.error('[replies:execute] 执行 prepared 状态的回复');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const run = createRunContext('replies-execute', commonArgs.options);
  const db = getDb();
  const options = commonArgs.options;

  const preparedComments = listPreparedComments({ limit: options.maxItems || 10, days: options.days || null });
  console.log(`[execute] 待执行: ${preparedComments.length} 条 prepared 评论${options.days ? ` (最近 ${options.days} 天)` : ''}`);

  if (preparedComments.length === 0) {
    console.log('[execute] 无 prepared 评论，退出');
    return;
  }

  const modeLabel = options.preview ? 'preview(预演)' : 'execute';
  console.log(`[execute] 模式: ${modeLabel}`);

  let browser = null;
  let page = null;
  const results = [];
  let succeeded = 0;
  let blocked = 0;

  try {
    console.error('[execute] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    await ensureNotificationPageReady(page);

    for (let i = 0; i < preparedComments.length; i++) {
      const comment = preparedComments[i];
      console.log(`\n[execute] ${i + 1}/${preparedComments.length}: ${comment.actor_name} "${comment.comment_text?.slice(0, 30)}" -> "${comment.reply_text?.slice(0, 30)}"`);

      const work = findWorkByWorkId(comment.work_id) || findWorkByModalId(comment.modal_id);
      if (!work) {
        console.log('[execute]   作品未找到，跳过');
        results.push({ status: 'blocked', reason: 'work not found' });
        blocked++;
        continue;
      }

      const modalUrl = `https://www.douyin.com/user/self?modal_id=${work.modal_id || work.work_id}`;
      console.log(`[execute]   打开 modal: ${modalUrl}`);
      await page.goto(modalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      const removed = await detectVideoRemoved(page);
      if (removed) {
        console.log(`[execute]   作品已删除: ${removed}`);
        results.push({ status: 'blocked', reason: `video removed: ${removed}` });
        blocked++;
        continue;
      }

      const modalResult = await waitForWorkModal(page);
      if (!modalResult.ok) {
        console.log(`[execute]   modal 未出现: ${modalResult.message}`);
        results.push({ status: 'blocked', reason: modalResult.message });
        blocked++;
        continue;
      }

      const scanResult = await findUnrepliedCommentsInModal(page, { selfNickname: '' });
      if (!scanResult.ok) {
        console.log(`[execute]   扫描评论失败: ${scanResult.message}`);
        results.push({ status: 'blocked', reason: scanResult.message });
        blocked++;
        continue;
      }

      const targetComment = scanResult.data.unreplied.find(c =>
        c.actorName === comment.actor_name && c.commentText.includes(comment.comment_text?.slice(0, 20))
      );
      if (!targetComment) {
        console.log('[execute]   评论未找到，可能已回复');
        results.push({ status: 'blocked', reason: 'comment not found in modal' });
        blocked++;
        continue;
      }

      const openResult = await openReplyBoxByIndex(page, targetComment.commentIndex);
      if (!openResult.ok) {
        console.log(`[execute]   打开回复框失败: ${openResult.message}`);
        results.push({ status: 'blocked', reason: openResult.message });
        blocked++;
        continue;
      }

      if (options.preview) {
        const fillResult = await fillReplyInWorkModal(page, comment.reply_text);
        if (!fillResult.ok) {
          console.log(`[execute]   填入失败: ${fillResult.message}`);
          results.push({ status: 'blocked', reason: fillResult.message });
          blocked++;
          continue;
        }
        console.log(`[execute]   ✓ [预演] 已填入: "${comment.reply_text?.slice(0, 30)}"`);
        results.push({ status: 'succeeded', reason: 'preview' });
        succeeded++;
        continue;
      }

      const sendResult = await sendReplyInWorkModal(page, comment.reply_text);
      if (!sendResult.ok) {
        console.log(`[execute]   发送失败: ${sendResult.message}`);
        results.push({ status: 'blocked', reason: sendResult.message });
        blocked++;
        continue;
      }

      const verifyResult = await verifyReplyInWorkModal(page, { actorName: comment.actor_name, commentText: comment.comment_text }, comment.reply_text);
      if (!verifyResult.ok) {
        console.log(`[execute]   ⚠ 未确认: ${verifyResult.message}`);
        markCommentSentUnverified(comment.id, verifyResult.message);
        results.push({ status: 'sent_unverified', reason: verifyResult.message });
        continue;
      }

      console.log(`[execute]   ✓ 回复成功: "${comment.reply_text?.slice(0, 30)}"`);
      markCommentReplied(comment.id);
      results.push({ status: 'succeeded' });
      succeeded++;

      await page.waitForTimeout(2000);
    }

  } catch (err) {
    console.error(`[execute] 错误: ${err.message}`);
    process.exitCode = 1;
  } finally {
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    writeJSON(path.join(plansDir, `execute-result-${ts}.json`), { mode: modeLabel, results, summary: { total: results.length, succeeded, blocked } });
    console.log(`\n[execute] 结果: ${succeeded} 成功 / ${blocked} 阻塞`);
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) await browser.close();
    else if (browser) console.log('[execute] 浏览器保持打开。');
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}