import { createBrowserContext } from '../browser/browser-context.mjs';
import { ensureNotificationPageReady } from '../adapters/notification-page.mjs';
import { waitForWorkModal, extractWorkModalContext, findUnrepliedCommentsInModal, openReplyBoxByIndex, fillReplyInWorkModal, sendReplyInWorkModal, verifyReplyInWorkModal, detectVideoRemoved } from '../adapters/work-modal-page.mjs';
import { generateReplyText } from '../domain/reply-template.mjs';
import { listPreparedComments, listPendingCommentsGroupedByWork, markCommentReplyPrepared, markCommentReplied, markCommentSentUnverified, markCommentBlocked } from '../db/work-comment-repository.mjs';
import { findWorkByWorkId, findWorkByModalId } from '../db/work-repository.mjs';
import { getDb } from '../db/database.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

async function main() {
  console.error('[interactions:reply] Phase 3: 生成回复 + Phase 4: 执行回复');

  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const run = createRunContext('interactions-reply', commonArgs.options);
  const db = getDb();

  const options = commonArgs.options;
  const modeLabel = options.preview ? 'preview(预演)' : (options.execute ? 'execute' : 'dry-run');
  console.log(`[reply] 模式: ${modeLabel}, maxItems: ${options.maxItems}`);

  // Phase 3: Generate replies for pending comments
  console.log(`\n[reply] === Phase 3: 生成回复 ===`);
  const pendingGroups = listPendingCommentsGroupedByWork({ limit: 100 });
  let totalPending = 0;
  for (const [, comments] of pendingGroups) totalPending += comments.length;
  console.log(`[reply] 待回复评论: ${totalPending} 条, 涉及 ${pendingGroups.size} 个作品`);

  let preparedCount = 0;
  for (const [workKey, comments] of pendingGroups) {
    const work = findWorkByWorkId(workKey) || findWorkByModalId(workKey);
    const workTitle = work?.work_title || '';
    console.log(`[reply] 作品 ${workKey}: ${comments.length} 条待回复, title="${workTitle}"`);

    for (const comment of comments) {
      if (comment.actor_name === '...' || comment.comment_text === '...' || comment.comment_text === '作者') {
        continue;
      }
      const { replyText, reason } = generateReplyText(comment.comment_text, { workTitle });
      markCommentReplyPrepared(comment.id, replyText, reason);
      preparedCount++;
    }
  }
  console.log(`[reply] Phase 3 完成: ${preparedCount} 条评论已生成回复(prepared)`);

  if (options.dryRun && !options.preview && !options.execute) {
    console.log(`[reply] dry-run 模式，不执行回复`);
    const prepared = listPreparedComments({ limit: 10 });
    for (const c of prepared) {
      console.log(`  ${c.actor_name} "${c.comment_text?.slice(0, 30)}" -> "${c.reply_text}"`);
    }
    return;
  }

  // Phase 4: Execute replies
  console.log(`\n[reply] === Phase 4: 执行回复 ===`);
  const preparedComments = listPreparedComments({ limit: options.maxItems || 10 });
  console.log(`[reply] 待执行: ${preparedComments.length} 条`);

  if (preparedComments.length === 0) {
    console.log(`[reply] 无 prepared 评论，退出`);
    return;
  }

  let browser = null;
  let page = null;
  const results = [];
  let succeeded = 0;
  let blocked = 0;

  try {
    console.error('[reply] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    await ensureNotificationPageReady(page);

    for (let i = 0; i < preparedComments.length; i++) {
      const comment = preparedComments[i];
      console.log(`\n[reply] ${i + 1}/${preparedComments.length}: ${comment.actor_name} "${comment.comment_text?.slice(0, 30)}" -> "${comment.reply_text}"`);

      const work = findWorkByWorkId(comment.work_id) || findWorkByModalId(comment.modal_id);
      if (!work) {
        console.log(`[reply]   作品未找到，跳过`);
        markCommentBlocked(comment.id, 'work not found in DB');
        results.push({ status: 'blocked', reason: 'work not found' });
        blocked++;
        continue;
      }

      // Open work modal
      const modalUrl = `https://www.douyin.com/user/self?modal_id=${work.modal_id || work.work_id}`;
      console.log(`[reply]   打开 modal: ${modalUrl}`);
      await page.goto(modalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      const removed = await detectVideoRemoved(page);
      if (removed) {
        console.log(`[reply]   作品已删除: ${removed}`);
        markCommentBlocked(comment.id, `video removed: ${removed}`);
        results.push({ status: 'blocked', reason: `video removed: ${removed}` });
        blocked++;
        continue;
      }

      const modalResult = await waitForWorkModal(page, { closeAutoPlay: true });
      if (!modalResult.ok) {
        console.log(`[reply]   modal 未出现: ${modalResult.message}`);
        markCommentBlocked(comment.id, `modal not found: ${modalResult.message}`);
        results.push({ status: 'blocked', reason: modalResult.message });
        blocked++;
        continue;
      }

      // Find the comment in modal and click reply
      const selfProfile = { nickname: '' };
      const scanResult = await findUnrepliedCommentsInModal(page, { selfNickname: selfProfile.nickname });
      if (!scanResult.ok) {
        console.log(`[reply]   扫描评论失败: ${scanResult.message}`);
        markCommentBlocked(comment.id, `scan failed: ${scanResult.message}`);
        results.push({ status: 'blocked', reason: scanResult.message });
        blocked++;
        continue;
      }

      const targetComment = scanResult.data.unreplied.find(c =>
        c.actorName === comment.actor_name && c.commentText.includes(comment.comment_text?.slice(0, 20))
      );
      if (!targetComment) {
        console.log(`[reply]   评论未找到在 modal 中，可能已回复`);
        markCommentBlocked(comment.id, 'comment not found in modal');
        results.push({ status: 'blocked', reason: 'comment not found' });
        blocked++;
        continue;
      }

      // Click reply button
      const openResult = await openReplyBoxByIndex(page, targetComment.commentIndex);
      if (!openResult.ok) {
        console.log(`[reply]   打开回复框失败: ${openResult.message}`);
        markCommentBlocked(comment.id, `open reply box failed: ${openResult.message}`);
        results.push({ status: 'blocked', reason: openResult.message });
        blocked++;
        continue;
      }

      if (options.preview) {
        const fillResult = await fillReplyInWorkModal(page, comment.reply_text);
        if (!fillResult.ok) {
          console.log(`[reply]   填入失败: ${fillResult.message}`);
          markCommentBlocked(comment.id, `fill failed: ${fillResult.message}`);
          results.push({ status: 'blocked', reason: fillResult.message });
          blocked++;
          continue;
        }
        console.log(`[reply]   ✓ [预演] 已填入: "${comment.reply_text?.slice(0, 30)}"`);
        results.push({ status: 'succeeded', reason: 'preview' });
        succeeded++;
        continue;
      }

      // Execute reply
      const sendResult = await sendReplyInWorkModal(page, comment.reply_text);
      if (!sendResult.ok) {
        console.log(`[reply]   发送失败: ${sendResult.message}`);
        markCommentBlocked(comment.id, `send failed: ${sendResult.message}`);
        results.push({ status: 'blocked', reason: sendResult.message });
        blocked++;
        continue;
      }

      const verifyResult = await verifyReplyInWorkModal(page, { actorName: comment.actor_name, commentText: comment.comment_text }, comment.reply_text);
      if (!verifyResult.ok) {
        console.log(`[reply]   ⚠ 未确认: ${verifyResult.message}`);
        markCommentSentUnverified(comment.id, verifyResult.message);
        results.push({ status: 'sent_unverified', reason: verifyResult.message });
        continue;
      }

      console.log(`[reply]   ✓ 回复成功: "${comment.reply_text?.slice(0, 30)}"`);
      markCommentReplied(comment.id);
      results.push({ status: 'succeeded' });
      succeeded++;

      await page.waitForTimeout(2000);
    }

  } catch (err) {
    console.error(`[reply] 错误: ${err.message}`);
    process.exitCode = 1;
  } finally {
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `reply-result-${ts}.json`);
    writeJSON(resultPath, { mode: modeLabel, results, summary: { total: results.length, succeeded, blocked } });
    console.log(`\n[reply] 结果: ${succeeded} 成功 / ${blocked} 阻塞 / ${results.length - succeeded - blocked} 其他`);
    console.log(`[reply] 已保存: ${resultPath}`);

    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) {
      await browser.close();
    } else if (browser) {
      console.log('[reply] 浏览器保持打开。');
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
