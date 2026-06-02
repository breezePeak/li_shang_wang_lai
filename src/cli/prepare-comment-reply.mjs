// 评论回复准备命令
// 只支持 interactions:scan 生成的按作品分组 JSON。
//
// 用法：
//   npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json --json
//
// 输入要求：
//   JSON 中每条 comments[] 必须包含 work_comments.id，并填写 reply_text。
//   本命令只更新 work_comments.reply_text，不改变 reply_status。回写 JSON 状态码。

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, saveReplyText } from '../db/work-comment-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { isAllowedTemplate, validateNaturalReply } from '../domain/reply-templates.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function parseArgs(argv) {
  const args = {
    itemsFile: '',
    json: false,
    decision: 'reply',
    riskLevel: 'low',
    decisionReason: '',
    relevance: 'neutral',
    workContextId: '',
    commentCategory: 'unclear',
    replyMode: 'auto_natural',
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--items-file' && argv[i + 1]) args.itemsFile = argv[++i];
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--decision' && argv[i + 1]) args.decision = argv[++i];
    if (argv[i] === '--risk-level' && argv[i + 1]) args.riskLevel = argv[++i];
    if (argv[i] === '--decision-reason' && argv[i + 1]) args.decisionReason = argv[++i];
    if (argv[i] === '--relevance' && argv[i + 1]) args.relevance = argv[++i];
    if (argv[i] === '--work-context-id' && argv[i + 1]) args.workContextId = argv[++i];
    if (argv[i] === '--comment-category' && argv[i + 1]) args.commentCategory = argv[++i];
    if (argv[i] === '--reply-mode' && argv[i + 1]) args.replyMode = argv[++i];
  }

  return args;
}

function buildBasePolicy(args) {
  return {
    decision: args.decision,
    riskLevel: args.riskLevel,
    decisionReason: args.decisionReason,
    relevance: args.relevance,
    workContextId: args.workContextId,
    commentCategory: args.commentCategory,
    replyMode: args.replyMode,
  };
}

function normalizeWorkCommentItem(item, index, basePolicy, workKey = '') {
  if (!item || typeof item !== 'object') {
    return { itemIndex: index, ok: false, error: 'batch item must be an object' };
  }
  return {
    itemIndex: index,
    commentId: Number(item.id ?? item.commentId ?? item.comment_id ?? item.workCommentId ?? item.work_comment_id),
    workKey: item.workKey ?? item.work_key ?? workKey,
    replyText: String(item.replyText ?? item.reply_text ?? ''),
    decision: item.decision ?? basePolicy.decision,
    riskLevel: item.riskLevel ?? item.risk_level ?? basePolicy.riskLevel,
    decisionReason: item.decisionReason ?? item.decision_reason ?? basePolicy.decisionReason,
    relevance: item.relevance ?? basePolicy.relevance,
    workContextId: item.workContextId ?? item.work_context_id ?? item.work_id ?? item.modal_id ?? basePolicy.workContextId,
    commentCategory: item.commentCategory ?? item.comment_category ?? basePolicy.commentCategory,
    replyMode: item.replyMode ?? item.reply_mode ?? basePolicy.replyMode,
  };
}

function extractItemsFromParsedJson(parsed, basePolicy) {
  if (Array.isArray(parsed?.works)) {
    const items = [];
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) {
        items.push(normalizeWorkCommentItem(comment, items.length, basePolicy, work.workKey || work.work_key || ''));
      }
    }
    return items;
  }
  if (Array.isArray(parsed?.comments)) {
    return parsed.comments.map((item, index) => normalizeWorkCommentItem(item, index, basePolicy, parsed.workKey || ''));
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => normalizeWorkCommentItem(item, index, basePolicy));
  }
  throw new Error('--items-file 必须是 interactions:scan 生成的 works[].comments[]、comments 数组或评论数组');
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

function loadBatchItems(args) {
  if (!args.itemsFile) {
    throw new Error('缺少 --items-file。comments:prepare 只支持 interactions:scan 生成的按作品分组 JSON。');
  }
  const basePolicy = buildBasePolicy(args);
  const raw = readFileSync(resolve(args.itemsFile), 'utf-8');
  const parsed = JSON.parse(raw);
  return { parsed, items: extractItemsFromParsedJson(parsed, basePolicy) };
}

function failResult(item, code, message, extra = {}) {
  return {
    itemIndex: item.itemIndex,
    commentId: item.commentId || null,
    ok: false,
    code,
    message,
    ...extra,
  };
}

function validateReplyPolicy(item) {
  const missing = [];
  if (!item.replyText || item.replyText.trim().length === 0) missing.push('replyText');
  if (missing.length > 0) {
    return failResult(
      item,
      RESULT_CODES.EMPTY_REPLY_TEXT,
      `缺少必填字段：${missing.join(', ')}。请在第一步生成的 JSON 中为每条要回复的评论填写 reply_text。`,
      { missing }
    );
  }

  const validDecisions = ['reply', 'manual_review', 'ignore'];
  const validRiskLevels = ['low', 'medium', 'high'];
  const validRelevance = ['relevant', 'neutral', 'irrelevant'];
  const validReplyModes = ['auto_simple', 'auto_natural', 'needs_review', 'ignore'];
  const validCategories = ['praise', 'encouragement', 'useful', 'question', 'request', 'risk', 'spam', 'unclear'];

  if (!item.decision || !validDecisions.includes(item.decision)) {
    return failResult(item, RESULT_CODES.BLOCKED, `decision 缺失或值无效（允许: ${validDecisions.join(', ')}）。`);
  }
  if (!item.riskLevel || !validRiskLevels.includes(item.riskLevel)) {
    return failResult(item, RESULT_CODES.BLOCKED, `riskLevel 缺失或值无效（允许: ${validRiskLevels.join(', ')}）。`);
  }
  if (!item.relevance || !validRelevance.includes(item.relevance)) {
    return failResult(item, RESULT_CODES.BLOCKED, `relevance 缺失或值无效（允许: ${validRelevance.join(', ')}）。`);
  }
  if (!item.replyMode || !validReplyModes.includes(item.replyMode)) {
    return failResult(item, RESULT_CODES.BLOCKED, `replyMode 缺失或值无效（允许: ${validReplyModes.join(', ')}）。`);
  }
  if (!item.commentCategory || !validCategories.includes(item.commentCategory)) {
    return failResult(item, RESULT_CODES.BLOCKED, `commentCategory 缺失或值无效（允许: ${validCategories.join(', ')}）。`);
  }
  if (item.decision !== 'reply') {
    return failResult(item, RESULT_CODES.BLOCKED, `决策为 "${item.decision}"，不能准备回复。仅 decision=reply 可进入回复流程。`);
  }
  if (item.riskLevel !== 'low') {
    return failResult(item, RESULT_CODES.BLOCKED, `风险等级为 "${item.riskLevel}"，不能准备回复。仅 riskLevel=low 可进入回复流程。`);
  }
  if (item.relevance === 'irrelevant') {
    return failResult(item, RESULT_CODES.BLOCKED, '相关性为 irrelevant，不允许准备回复。');
  }
  if (item.replyMode === 'ignore') {
    return failResult(item, RESULT_CODES.BLOCKED, 'replyMode=ignore 的评论不应准备回复。');
  }
  if (item.replyMode === 'needs_review' && item.decision === 'reply') {
    return failResult(item, RESULT_CODES.BLOCKED, 'replyMode=needs_review 的评论需要人工审核，不能设置 decision=reply。');
  }
  if (item.replyMode === 'auto_simple' && !isAllowedTemplate(item.replyText)) {
    return failResult(item, RESULT_CODES.BLOCKED, `replyMode=auto_simple 的回复必须从安全模板池中选取。"${item.replyText.slice(0, 40)}" 不在允许的模板列表中。`);
  }
  if (item.replyMode === 'auto_natural') {
    const natural = validateNaturalReply(item.replyText);
    if (!natural.ok) {
      return failResult(item, RESULT_CODES.BLOCKED, `replyMode=auto_natural 的回复未通过安全校验：${natural.errors.join('；')}`);
    }
  }
  return null;
}

function prepareWorkCommentOne(item) {
  if (!item.commentId) {
    return failResult(item, RESULT_CODES.BLOCKED, '缺少 work_comments.id；请使用 interactions:scan 生成的按作品分组 JSON');
  }

  const policyError = validateReplyPolicy(item);
  if (policyError) return policyError;

  const comment = getWorkComment(item.commentId);
  if (!comment) {
    return failResult(item, RESULT_CODES.BLOCKED, `找不到 work_comments.id=${item.commentId}`);
  }
  if (comment.reply_status === 'succeeded' || comment.reply_status === 'sent_unverified') {
    return failResult(item, RESULT_CODES.DUPLICATE_ACTION, `评论 #${item.commentId} 已回复或已发送，不能重复准备`);
  }

  saveReplyText(item.commentId, item.replyText.trim());

  return {
    itemIndex: item.itemIndex,
    ok: true,
    commentId: item.commentId,
    status: 'reply_text_written',
  };
}

function updatePrepareJsonFile(itemsFile, parsed, results) {
  const byId = new Map();
  for (const result of results) {
    if (result.commentId) byId.set(Number(result.commentId), result);
  }
  if (byId.size === 0) return;

  visitJsonComments(parsed, (comment) => {
    const id = Number(comment.id ?? comment.commentId ?? comment.comment_id ?? comment.workCommentId ?? comment.work_comment_id);
    const result = byId.get(id);
    if (!result) return;
    comment.prepare_status_code = result.ok ? 'PREPARE_READY' : 'PREPARE_FAILED';
    comment.prepare_error = result.ok ? '' : (result.message || result.error || result.code || 'prepare_failed');
    if (result.ok) {
      comment.execute_status_code = 'EXECUTE_WAIT_CONFIRM';
    }
  });

  parsed.workflow_status_code = 'PREPARE_JSON_UPDATED';
  parsed.status_codes = {
    ...(parsed.status_codes || {}),
    prepare: 'PREPARE_JSON_UPDATED',
    execute: 'EXECUTE_WAIT_CONFIRM',
  };
  writeFileSync(resolve(itemsFile), JSON.stringify(parsed, null, 2), 'utf8');
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  let loaded = { parsed: null, items: [] };
  try {
    loaded = loadBatchItems(args);
  } catch (err) {
    printJsonError('comments:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
    return;
  }

  const results = loaded.items.map(item => item.ok === false ? item : prepareWorkCommentOne(item));
  updatePrepareJsonFile(args.itemsFile, loaded.parsed, results);

  const prepared = results.filter(item => item.ok).length;
  const failed = results.length - prepared;
  const commentIds = results.filter(item => item.ok && item.commentId).map(item => item.commentId);

  if (args.json) {
    printJsonResult('comments:prepare', { results, commentIds }, { prepared, failed, total: results.length, mode: 'work_comment_json' });
  } else {
    console.log(`[prepare] mode=work_comment_json prepared=${prepared} failed=${failed} total=${results.length}`);
    for (const result of results) {
      if (result.ok) {
        console.log(`  [comment#${result.commentId}] reply_text_written`);
      } else {
        console.log(`  [comment#${result.commentId || '-'}] failed ${result.code}: ${result.message}`);
      }
    }
    if (commentIds.length > 0) {
      console.log(`  下一步: npm run comments:execute -- --items-file ${args.itemsFile}`);
    }
  }
}

main();
