// 评论回复执行命令
// 只支持 interactions:scan 生成的按作品分组 JSON。
//
// 用法：
//   npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
//
// 输入要求：
//   JSON 中每条 comments[] 的 reply_text 由 Agent 根据评论内容、作品上下文和安全规则生成并填写。
//   reply_text 为空的评论会跳过。已经 succeeded/sent_unverified 的评论会跳过重复执行。
//   命令默认真实执行回复，不再需要 --execute。

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, markCommentReplied, markCommentBlocked, markCommentSentUnverified } from '../db/work-comment-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import {
  waitForWorkModal,
  findCommentInWorkModal,
  openReplyBoxByIndex,
  sendReplyInWorkModal,
  verifyReplyInWorkModal,
} from '../adapters/work-modal-page.mjs';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

function parseArgs(argv) {
  const args = {
    itemsFile: '',
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items-file' && argv[i + 1]) args.itemsFile = argv[++i];
    if (argv[i] === '--json') args.json = true;
  }

  return args;
}

function loadWorkCommentItemsFromFile(itemsFile) {
  const raw = readFileSync(resolve(itemsFile), 'utf8');
  const parsed = JSON.parse(raw);
  const items = [];

  if (Array.isArray(parsed?.works)) {
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) {
        items.push({ ...comment, workKey: work.workKey || work.work_key || '' });
      }
    }
  } else if (Array.isArray(parsed?.comments)) {
    items.push(...parsed.comments);
  } else if (Array.isArray(parsed)) {
    items.push(...parsed);
  } else {
    throw new Error('--items-file 必须是 interactions:scan 生成的 works[].comments[]、comments 数组或评论数组');
  }

  return {
    parsed,
    items: items.map((item, index) => ({
      itemIndex: index,
      commentId: Number(item.id ?? item.commentId ?? item.comment_id ?? item.workCommentId ?? item.work_comment_id),
      replyText: String(item.replyText ?? item.reply_text ?? ''),
      workUrl: item.workUrl ?? item.work_url ?? '',
      workId: item.workId ?? item.work_id ?? '',
      modalId: item.modalId ?? item.modal_id ?? '',
      actorName: item.actorName ?? item.actor_name ?? '',
      commentText: item.commentText ?? item.comment_text ?? '',
      eventTimeText: item.eventTimeText ?? item.event_time_text ?? '',
    })),
  };
}

function visitJsonComments(parsed, visitor) {
  if (Array.isArray(parsed?.works)) {
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) visitor(comment, work);
    }
    return;
  }
  if (Array.isArray(parsed?.comments)) {
    for (const comment of parsed.comments) visitor(comment, parsed);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const comment of parsed) visitor(comment, null);
  }
}

function updateExecuteJsonFile(itemsFile, parsed, results) {
  if (!itemsFile || !parsed) return;
  const byId = new Map();
  for (const result of results) {
    if (result.commentId) byId.set(Number(result.commentId), result);
  }
  if (byId.size === 0) return;

  visitJsonComments(parsed, (comment) => {
    const id = Number(comment.id ?? comment.commentId ?? comment.comment_id ?? comment.workCommentId ?? comment.work_comment_id);
    const result = byId.get(id);
    if (!result) return;

    // 本轮真实执行成功
    if (result.ok && result.status === 'succeeded') {
      comment.reply_status = 'succeeded';
      comment.execute_status_code = 'EXECUTE_CONFIRMED';
      comment.execute_error = '';
    // 之前已成功，本轮跳过重复执行
    } else if (!result.ok && result.status === 'succeeded') {
      comment.reply_status = 'succeeded';
      comment.execute_status_code = 'EXECUTE_ALREADY_CONFIRMED';
      comment.execute_error = '已回复，跳过重复执行';
    // 本轮发送未确认
    } else if (result.status === 'sent_unverified' && !result.fromAlready) {
      comment.reply_status = 'sent_unverified';
      comment.execute_status_code = 'EXECUTE_SENT_UNVERIFIED';
      comment.execute_error = result.error || '';
    // 之前已 sent_unverified，本轮跳过重复执行
    } else if (result.status === 'sent_unverified' && result.fromAlready) {
      comment.reply_status = 'sent_unverified';
      comment.execute_status_code = 'EXECUTE_ALREADY_SENT_UNVERIFIED';
      comment.execute_error = '已发送但未确认，跳过重复执行';
    } else if (result.status === 'blocked') {
      comment.reply_status = 'blocked';
      comment.execute_status_code = 'EXECUTE_BLOCKED';
      comment.execute_error = result.error || '';
    } else if (result.status === 'skipped_empty_reply') {
      comment.execute_status_code = 'EXECUTE_SKIPPED_EMPTY';
      comment.execute_error = 'reply_text 为空，跳过执行';
    } else {
      comment.execute_status_code = result.ok ? 'EXECUTE_VALIDATED' : 'EXECUTE_FAILED';
      comment.execute_error = result.ok ? '' : (result.error || 'execute_failed');
    }
  });

  const allOkOrSkipped = results.every(item => item.ok || isSkippedResult(item));
  parsed.workflow_status_code = allOkOrSkipped ? 'EXECUTE_JSON_DONE' : 'EXECUTE_JSON_PARTIAL';
  parsed.status_codes = {
    ...(parsed.status_codes || {}),
    execute: parsed.workflow_status_code,
  };
  writeFileSync(resolve(itemsFile), JSON.stringify(parsed, null, 2), 'utf8');
}

function validateWorkCommentItem(item) {
  if (!item.commentId) {
    return { itemIndex: item.itemIndex, ok: false, error: '缺少 work_comments.id；请使用 interactions:scan 生成的 JSON' };
  }
  const row = getWorkComment(item.commentId);
  if (!row) {
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, error: `找不到 work_comments.id=${item.commentId}` };
  }

  const replyText = String(item.replyText || row.reply_text || '').trim();
  if (!replyText) {
    console.error(`[comments:execute] commentId=${item.commentId} reply_text 为空，跳过执行`);
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, status: 'skipped_empty_reply' };
  }

  if (row.reply_status === 'succeeded') {
    console.error(`[comments:execute] commentId=${item.commentId} 已回复成功，跳过重复执行`);
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, status: 'succeeded' };
  }
  if (row.reply_status === 'sent_unverified') {
    console.error(`[comments:execute] commentId=${item.commentId} 已发送但未确认，跳过重复执行`);
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, status: 'sent_unverified', fromAlready: true };
  }

  const workUrl = item.workUrl || row.work_url || '';
  if (!workUrl) {
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, error: 'work_url 为空，无法打开作品' };
  }

  return {
    itemIndex: item.itemIndex,
    commentId: item.commentId,
    ok: true,
    status: row.reply_status,
    workUrl,
    workId: item.workId || row.work_id || '',
    modalId: item.modalId || row.modal_id || '',
    actorName: item.actorName || row.actor_name || '',
    commentText: item.commentText || row.comment_text || '',
    eventTimeText: item.eventTimeText || row.event_time_text || '',
    replyText,
  };
}

async function executeWorkCommentItems(items, args) {
  const run = createRunContext('comment-execute-json', {
    debug: true,
    dryRun: false,
    execute: true,
    json: args.json,
    keepOpen: false,
    keepOpenOnError: !args.json,
    pauseOnError: !args.json,
    writeRunFiles: false,
  });

  let browser = null;
  let page = null;
  const results = [];

  try {
    const ctx = await createBrowserContext({ headless: false, enableReuse: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    for (const item of items) {
      const validated = validateWorkCommentItem(item);
      if (!validated.ok) {
        results.push(validated);
        continue;
      }

      try {
        await page.goto(validated.workUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);

        const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
        if (!modalReady.ok) {
          markCommentBlocked(validated.commentId, modalReady.message || modalReady.code || 'work_modal_not_ready');
          results.push({ ...validated, ok: false, status: 'blocked', error: modalReady.message || modalReady.code });
          continue;
        }

        const found = await findCommentInWorkModal(page, {
          actorName: validated.actorName,
          commentText: validated.commentText,
          eventTimeText: validated.eventTimeText,
        }, { maxScrolls: 30 });
        if (!found.ok) {
          markCommentBlocked(validated.commentId, found.message || found.code || 'comment_not_found');
          results.push({ ...validated, ok: false, status: 'blocked', error: found.message || found.code });
          continue;
        }

        const opened = await openReplyBoxByIndex(page, found.data.commentIndex);
        if (!opened.ok) {
          markCommentBlocked(validated.commentId, opened.message || opened.code || 'reply_box_not_opened');
          results.push({ ...validated, ok: false, status: 'blocked', error: opened.message || opened.code });
          continue;
        }

        const sent = await sendReplyInWorkModal(page, validated.replyText);
        if (!sent.ok) {
          markCommentBlocked(validated.commentId, sent.message || sent.code || 'send_failed');
          results.push({ ...validated, ok: false, status: 'blocked', error: sent.message || sent.code });
          continue;
        }

        const verified = await verifyReplyInWorkModal(page, {
          commentText: validated.commentText,
          actorName: validated.actorName,
        }, validated.replyText, { timeoutMs: 7000 });
        if (!verified.ok) {
          markCommentSentUnverified(validated.commentId, verified.message || verified.code || 'send_unverified');
          results.push({ ...validated, ok: false, status: 'sent_unverified', error: verified.message || verified.code });
          continue;
        }

        markCommentReplied(validated.commentId);
        results.push({ ...validated, ok: true, status: 'succeeded', mode: 'execute' });
      } catch (err) {
        run.hadBlocked = true;
        markCommentBlocked(validated.commentId, err.message);
        if (page) {
          try {
            const { evidenceDir } = await captureEvidence(page, {
              outputDir: run.outputDir,
              step: `work-comment-${validated.commentId}`,
              code: RESULT_CODES.UNKNOWN_ERROR,
              message: err.message,
              recoverable: true,
            });
            run.evidenceDirectories.push(evidenceDir);
          } catch {}
        }
        results.push({ ...validated, ok: false, status: 'blocked', error: err.message });
      }
    }
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) await browser.close();
  }

  return results;
}

function isSkippedResult(result) {
  return result.status === 'skipped_empty_reply'
    || (!result.ok && result.status === 'succeeded')
    || (!result.ok && result.status === 'sent_unverified');
}

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  if (!args.itemsFile) {
    printJsonError(
      'comments:execute',
      RESULT_CODES.INVALID_ARGUMENTS,
      'comments:execute 只支持 --items-file <第一步JSON>',
      { recoverable: false }
    );
    return;
  }

  let loaded = { parsed: null, items: [] };
  try {
    loaded = loadWorkCommentItemsFromFile(args.itemsFile);
  } catch (err) {
    printJsonError('comments:execute', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
    return;
  }

  const results = await executeWorkCommentItems(loaded.items, args);
  updateExecuteJsonFile(args.itemsFile, loaded.parsed, results);

  // 消费后删除中间 JSON
  try {
    const absPath = resolve(args.itemsFile);
    if (existsSync(absPath)) {
      unlinkSync(absPath);
      console.log(`[comments:execute] 已删除中间 JSON: ${args.itemsFile}`);
    }
  } catch {}

  const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
  const skipped = results.filter(isSkippedResult).length;
  const failed = results.length - succeeded - skipped;

  const skipReasons = {};
  results.filter(isSkippedResult).forEach(r => {
    const reason = r.status === 'skipped_empty_reply' ? 'empty' : r.status;
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  });
  const skippedLog = skipped > 0 ? `，跳过 ${skipped} 条（${Object.entries(skipReasons).map(([k, v]) => `${k}×${v}`).join(', ')}）` : '';

  if (args.json) {
    printJsonResult('comments:execute', { results }, { succeeded, failed, skipped, mode: 'work_comment_json' });
  } else {
    console.log(`[comments:execute] mode=work_comment_json 成功 ${succeeded} 条，失败 ${failed} 条${skippedLog}`);
    for (const item of results) {
      const tag = item.status === 'skipped_empty_reply' ? ' [empty-reply]'
        : (!item.ok && item.status === 'succeeded') ? ' [already-done]'
        : (!item.ok && item.status === 'sent_unverified') ? ' [already-sent]'
        : '';
      console.log(`  [comment#${item.commentId || '-'}] ${item.ok ? item.status : `failed ${item.error}`}${tag}`);
    }
  }
}

main().catch(err => {
  printJsonError('comments:execute', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
  process.exit(1);
});
