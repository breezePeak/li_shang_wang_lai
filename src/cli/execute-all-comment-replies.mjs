import { runMigrations } from '../db/migrations.mjs';
import {
  getAction,
  getActionWithEvent,
  getActionsByStatus,
  hasSucceededAction,
} from '../db/action-repository.mjs';
import { getEvent } from '../db/interaction-repository.mjs';
import { getWorkComment, markCommentReplied, markCommentBlocked, markCommentSentUnverified } from '../db/work-comment-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { executePreparedReply } from '../services/comment-reply-executor.mjs';
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
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function parseArgs(argv) {
  const args = {
    actionId: null,
    actionIds: [],
    allPrepared: false,
    itemsFile: '',
    execute: false,
    maxItems: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id' && argv[i + 1]) args.actionId = parseInt(argv[++i]);
    if (argv[i] === '--action-ids' && argv[i + 1]) args.actionIds = argv[++i].split(',').map(v => parseInt(v.trim())).filter(Boolean);
    if (argv[i] === '--all-prepared') args.allPrepared = true;
    if (argv[i] === '--items-file' && argv[i + 1]) args.itemsFile = argv[++i];
    if (argv[i] === '--execute') args.execute = true;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--max-items' && argv[i + 1]) {
      const n = parseInt(argv[++i]);
      args.maxItems = Number.isFinite(n) && n > 0 ? n : 20;
    }
  }

  return args;
}

function loadWorkCommentItemsFromFile(itemsFile, maxItems) {
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
    items: items.slice(0, maxItems).map((item, index) => ({
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
    if (result.ok && result.status === 'succeeded') {
      comment.reply_status = 'succeeded';
      comment.execute_status_code = 'EXECUTE_CONFIRMED';
      comment.execute_error = '';
    } else if (result.status === 'sent_unverified') {
      comment.reply_status = 'sent_unverified';
      comment.execute_status_code = 'EXECUTE_SENT_UNVERIFIED';
      comment.execute_error = result.error || '';
    } else if (result.status === 'blocked') {
      comment.reply_status = 'blocked';
      comment.execute_status_code = 'EXECUTE_BLOCKED';
      comment.execute_error = result.error || '';
    } else {
      comment.execute_status_code = result.ok ? 'EXECUTE_VALIDATED' : 'EXECUTE_FAILED';
      comment.execute_error = result.ok ? '' : (result.error || 'execute_failed');
    }
  });

  parsed.workflow_status_code = results.every(item => item.ok) ? 'EXECUTE_JSON_DONE' : 'EXECUTE_JSON_PARTIAL';
  parsed.status_codes = {
    ...(parsed.status_codes || {}),
    execute: parsed.workflow_status_code,
  };
  writeFileSync(resolve(itemsFile), JSON.stringify(parsed, null, 2), 'utf8');
}

function collectActionIds(args) {
  if (args.allPrepared) {
    return getActionsByStatus('prepared', args.maxItems).map(action => action.id);
  }
  if (args.actionIds.length > 0) return args.actionIds.slice(0, args.maxItems);
  if (args.actionId) return [args.actionId];
  return [];
}

function validateDataGate(action) {
  if (!action.commentText || action.commentText.trim().length === 0) {
    return `无法获取原始评论内容（eventId=${action.eventId}），无法定位目标评论`;
  }
  if (!action.actionText || action.actionText.trim().length === 0) {
    return '回复内容为空';
  }
  if (hasSucceededAction(action.eventId, 'reply_comment')) {
    return '该评论已有成功回复记录';
  }

  const event = getEvent(action.eventId);
  if (event && event.status === 'unstable') {
    return `事件 #${action.eventId} 仍处于 unstable 状态，无法执行`;
  }

  let evidence = {};
  try {
    const fullAction = getAction(action.actionId);
    evidence = fullAction?.evidence_json ? JSON.parse(fullAction.evidence_json) : {};
  } catch (err) {
    return `动作审计数据无法解析：${err.message}`;
  }
  if (evidence.autoExecuteAllowed === true) return 'autoExecuteAllowed 当前必须为 false，不允许自动真实发送';
  if (evidence.decision && evidence.decision !== 'reply') return `决策为 "${evidence.decision}"，不允许真实发送`;
  if (evidence.riskLevel && evidence.riskLevel !== 'low') return `风险等级为 "${evidence.riskLevel}"，不允许真实发送`;
  if (evidence.relevance === 'irrelevant') return '相关性为 irrelevant，不允许真实发送';
  if (evidence.replyMode === 'ignore') return 'replyMode=ignore 的评论不允许发送';

  return null;
}

function validatePreparedAction(actionId) {
  const action = getActionWithEvent(actionId);
  if (!action) return { actionId, ok: false, error: `找不到动作 ID=${actionId}` };

  if (action.status !== 'prepared') {
    return { actionId, ok: false, status: action.status, error: `状态 ${action.status} 不可由 execute-all 处理` };
  }

  const gateError = validateDataGate(action);
  if (gateError) return { actionId, ok: false, status: action.status, error: gateError };

  return {
    actionId,
    ok: true,
    status: 'prepared',
    actorName: action.actorName,
    replyText: action.actionText,
  };
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
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, error: 'reply_text 为空；请先填写回复内容并执行 comments:prepare' };
  }
  if (row.reply_status !== 'prepared') {
    return { itemIndex: item.itemIndex, commentId: item.commentId, ok: false, status: row.reply_status, error: `状态 ${row.reply_status} 不可执行；请先运行 comments:prepare -- --items-file <json>` };
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
    dryRun: !args.execute,
    execute: args.execute,
    json: args.json,
    keepOpen: false,
    keepOpenOnError: !args.json,
    pauseOnError: !args.json,
    writeRunFiles: false,
    maxItems: args.maxItems,
  });

  if (!args.execute) {
    return items.map(item => {
      const validated = validateWorkCommentItem(item);
      return validated.ok
        ? { ...validated, mode: 'validate-only', next: `npm run comments:execute-all -- --items-file ${args.itemsFile} --execute` }
        : validated;
    });
  }

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

async function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  if (args.itemsFile) {
    let loaded = { parsed: null, items: [] };
    try {
      loaded = loadWorkCommentItemsFromFile(args.itemsFile, args.maxItems);
    } catch (err) {
      printJsonError('comments:execute-all', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
      return;
    }
    const results = await executeWorkCommentItems(loaded.items, args);
    updateExecuteJsonFile(args.itemsFile, loaded.parsed, results);
    const succeeded = results.filter(item => item.ok).length;
    const failed = results.length - succeeded;
    if (args.json) {
      printJsonResult('comments:execute-all', { results }, { succeeded, failed, execute: args.execute, mode: 'work_comment_json' });
    } else {
      console.log(`[comments:execute-all] mode=work_comment_json 成功 ${succeeded} 条，失败 ${failed} 条，真实执行=${args.execute}`);
      for (const item of results) {
        console.log(`  [comment#${item.commentId || '-'}] ${item.ok ? item.status : `failed ${item.error}`}`);
      }
    }
    return;
  }

  const actionIds = collectActionIds(args);

  if (actionIds.length === 0) {
    printJsonError('comments:execute-all', RESULT_CODES.BLOCKED,
      '缺少参数 --action-id、--action-ids 或 --all-prepared', { recoverable: false });
    return;
  }

  const results = [];
  for (const actionId of actionIds) {
    const validated = validatePreparedAction(actionId);
    if (!validated.ok) {
      results.push(validated);
      continue;
    }
    if (!args.execute) {
      results.push({ ...validated, mode: 'validate-only', next: `npm run comments:execute-all -- --action-id ${actionId} --execute` });
      continue;
    }
    const executed = await executePreparedReply(actionId, { execute: true, json: args.json });
    results.push(executed.ok
      ? { actionId, ok: true, status: executed.status, detail: executed }
      : { actionId, ok: false, status: 'execute_failed', error: executed.message || executed.code, detail: executed });
  }

  const succeeded = results.filter(item => item.ok).length;
  const failed = results.length - succeeded;
  if (args.json) {
    printJsonResult('comments:execute-all', { results }, { succeeded, failed, execute: args.execute });
  } else {
    console.log(`[comments:execute-all] 成功 ${succeeded} 条，失败 ${failed} 条，真实执行=${args.execute}`);
    for (const item of results) {
      console.log(`  [${item.actionId}] ${item.ok ? item.status : `failed ${item.error}`}`);
    }
  }
}

main().catch(err => {
  printJsonError('comments:execute-all', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
  process.exit(1);
});
