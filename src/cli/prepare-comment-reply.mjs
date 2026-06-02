// 评论回复准备命令
// 根据 eventId 和 replyText 创建 prepared 回复动作。
//
// 用法：
//   npm run comments:prepare -- --items-file replies.json --json
//   npm run comments:prepare -- --items-json '[{"eventId":1,"replyText":"谢谢支持"}]' --json
//   # 兼容单条：
//   npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>"
//   npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" --json
//   npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" \
//       --decision reply --risk-level low --relevance relevant \
//       --decision-reason "<理由>" --work-context-id <作品ID> \
//       --comment-category praise --reply-mode auto_simple --json
//
// 决策约束：
//   --decision 仅接受 reply / manual_review / ignore
//   --risk-level 仅接受 low / medium / high
//   --relevance 仅接受 relevant / neutral / irrelevant
//   --comment-category 使用内置评论分类
//   --reply-mode 仅接受 auto_simple / needs_review / ignore
//   仅 decision=reply + riskLevel=low 可以创建动作
//   replyMode=ignore 禁止创建动作
//   replyMode=auto_simple 要求调用方传入模板池文本，autoExecuteAllowed 固定 false
//   replyMode=auto_natural 用于接收 creator-comment-suggestion Skill 生成的自然回复，并做长度/安全词校验

import { runMigrations } from '../db/migrations.mjs';
import { createAction, hasSucceededAction, hasActiveAction } from '../db/action-repository.mjs';
import { getEvents, updateEventStatus } from '../db/interaction-repository.mjs';
import { getWorkComment, markCommentReplyPrepared } from '../db/work-comment-repository.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { isAllowedTemplate, validateNaturalReply } from '../domain/reply-templates.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    eventId: null,
    replyText: null,
    itemsJson: '',
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
    if (argv[i] === '--event-id' && argv[i + 1]) args.eventId = parseInt(argv[++i]);
    if (argv[i] === '--reply-text' && argv[i + 1]) args.replyText = argv[++i];
    if (argv[i] === '--items-json' && argv[i + 1]) args.itemsJson = argv[++i];
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

function normalizeBatchItem(item, index, basePolicy) {
  if (!item || typeof item !== 'object') {
    return { itemIndex: index, ok: false, error: 'batch item must be an object' };
  }
  return {
    itemIndex: index,
    eventId: Number(item.eventId ?? item.event_id),
    replyText: String(item.replyText ?? item.reply_text ?? ''),
    decision: item.decision ?? basePolicy.decision,
    riskLevel: item.riskLevel ?? item.risk_level ?? basePolicy.riskLevel,
    decisionReason: item.decisionReason ?? item.decision_reason ?? basePolicy.decisionReason,
    relevance: item.relevance ?? basePolicy.relevance,
    workContextId: item.workContextId ?? item.work_context_id ?? basePolicy.workContextId,
    commentCategory: item.commentCategory ?? item.comment_category ?? basePolicy.commentCategory,
    replyMode: item.replyMode ?? item.reply_mode ?? basePolicy.replyMode,
  };
}

function normalizeWorkCommentItem(item, index, basePolicy, workKey = '') {
  if (!item || typeof item !== 'object') {
    return { itemIndex: index, ok: false, error: 'batch item must be an object' };
  }
  return {
    itemIndex: index,
    mode: 'work_comment',
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
  if (Array.isArray(parsed)) {
    return {
      mode: 'legacy_event',
      items: parsed.map((item, index) => normalizeBatchItem(item, index, basePolicy)),
    };
  }
  if (Array.isArray(parsed?.items)) {
    return {
      mode: 'legacy_event',
      items: parsed.items.map((item, index) => normalizeBatchItem(item, index, basePolicy)),
    };
  }
  if (Array.isArray(parsed?.comments)) {
    return {
      mode: 'work_comment',
      items: parsed.comments.map((item, index) => normalizeWorkCommentItem(item, index, basePolicy, parsed.workKey || '')),
    };
  }
  if (Array.isArray(parsed?.works)) {
    const items = [];
    for (const work of parsed.works) {
      const comments = Array.isArray(work.comments) ? work.comments : [];
      for (const comment of comments) {
        items.push(normalizeWorkCommentItem(comment, items.length, basePolicy, work.workKey || work.work_key || ''));
      }
    }
    return { mode: 'work_comment', items };
  }
  throw new Error('--items-file/--items-json 必须是 JSON 数组、包含 items 数组，或第一步生成的 works[].comments[] 结构');
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

function updatePrepareJsonFile(itemsFile, parsed, results) {
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
    comment.prepare_status_code = result.ok ? 'PREPARE_READY' : 'PREPARE_FAILED';
    comment.prepare_error = result.ok ? '' : (result.message || result.error || result.code || 'prepare_failed');
    if (result.ok) {
      comment.reply_status = 'prepared';
      comment.reply_text = result.replyText || comment.reply_text || '';
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

function loadBatchItems(args) {
  const basePolicy = buildBasePolicy(args);

  if (args.itemsFile) {
    const raw = readFileSync(resolve(args.itemsFile), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...extractItemsFromParsedJson(parsed, basePolicy), parsed };
  }

  if (args.itemsJson) {
    const parsed = JSON.parse(args.itemsJson);
    return { ...extractItemsFromParsedJson(parsed, basePolicy), parsed: null };
  }

  return {
    mode: 'legacy_event',
    items: [normalizeBatchItem({
      eventId: args.eventId,
      replyText: args.replyText,
    }, 0, basePolicy)],
  };
}

function failResult(item, code, message, extra = {}) {
  return {
    itemIndex: item.itemIndex,
    eventId: item.eventId || null,
    ok: false,
    code,
    message,
    ...extra,
  };
}

function prepareOne(item, events) {
  // Validation
  const missing = [];
  if (!item.eventId) missing.push('eventId');
  if (!item.replyText || item.replyText.trim().length === 0) missing.push('replyText');
  if (missing.length > 0) {
    return failResult(
      item,
      missing.includes('replyText') ? RESULT_CODES.EMPTY_REPLY_TEXT : RESULT_CODES.BLOCKED,
      `缺少必填字段：${missing.join(', ')}。可选字段默认值：decision=reply riskLevel=low relevance=neutral replyMode=auto_natural commentCategory=unclear。`,
      { missing }
    );
  }

  // Check the event exists and is a comment
  const ev = events.find(e => e.id === item.eventId);
  if (!ev) {
    return failResult(item, RESULT_CODES.BLOCKED, `找不到事件 ID=${item.eventId}`);
  }
  if (ev.event_type !== 'comment') {
    return failResult(item, RESULT_CODES.BLOCKED, `事件 ID=${item.eventId} 不是评论类型`);
  }
  if (ev.status === 'unstable') {
    return failResult(item, RESULT_CODES.BLOCKED, `事件 ID=${item.eventId} 的相对时间尚未稳定，无法创建回复。请在时间稳定后重新扫描。`);
  }

  // Decision policy validation
  const validDecisions = ['reply', 'manual_review', 'ignore'];
  const validRiskLevels = ['low', 'medium', 'high'];

  if (!item.decision || !validDecisions.includes(item.decision)) {
    return failResult(item, RESULT_CODES.BLOCKED, `decision 缺失或值无效（允许: ${validDecisions.join(', ')}）。`);
  }
  if (!item.riskLevel || !validRiskLevels.includes(item.riskLevel)) {
    return failResult(item, RESULT_CODES.BLOCKED, `riskLevel 缺失或值无效（允许: ${validRiskLevels.join(', ')}）。`);
  }
  if (item.decision !== 'reply') {
    return failResult(item, RESULT_CODES.BLOCKED, `决策为 "${item.decision}"，不能创建回复动作。仅 decision=reply 可进入候选流程。`);
  }
  if (item.riskLevel !== 'low') {
    return failResult(item, RESULT_CODES.BLOCKED, `风险等级为 "${item.riskLevel}"，不能创建回复动作。仅 riskLevel=low 可进入候选流程。`);
  }

  // Relevance gate: decision=reply + relevance=irrelevant must block
  const validRelevance = ['relevant', 'neutral', 'irrelevant'];
  if (!item.relevance || !validRelevance.includes(item.relevance)) {
    return failResult(item, RESULT_CODES.BLOCKED, `relevance 缺失或值无效（允许: ${validRelevance.join(', ')}）。`);
  }
  if (item.decision === 'reply' && item.relevance === 'irrelevant') {
    return failResult(item, RESULT_CODES.BLOCKED, '相关性为 "irrelevant" 但决策为 "reply"，这不符合安全策略。irrelevant 评论不应自动回复。');
  }

  // Reply mode validation
  const validReplyModes = ['auto_simple', 'auto_natural', 'needs_review', 'ignore'];
  const validCategories = ['praise', 'encouragement', 'useful', 'question', 'request', 'risk', 'spam', 'unclear'];

  if (!item.replyMode || !validReplyModes.includes(item.replyMode)) {
    return failResult(item, RESULT_CODES.BLOCKED, `replyMode 缺失或值无效（允许: ${validReplyModes.join(', ')}）。`);
  }
  if (!item.commentCategory || !validCategories.includes(item.commentCategory)) {
    return failResult(item, RESULT_CODES.BLOCKED, `commentCategory 缺失或值无效（允许: ${validCategories.join(', ')}）。`);
  }

  // replyMode=ignore must not create action
  if (item.replyMode === 'ignore') {
    return failResult(item, RESULT_CODES.BLOCKED, 'replyMode=ignore 的评论不应创建回复动作。该评论需跳过。');
  }

  // replyMode=needs_review must not auto-create (decision must be manual_review)
  if (item.replyMode === 'needs_review' && item.decision === 'reply') {
    return failResult(item, RESULT_CODES.BLOCKED, 'replyMode=needs_review 的评论需要人工审核，不能设置 decision=reply。请改为 decision=manual_review。');
  }

  // replyMode=auto_simple: validate reply text is from allowed template pool
  if (item.replyMode === 'auto_simple') {
    if (!isAllowedTemplate(item.replyText)) {
      return failResult(item, RESULT_CODES.BLOCKED, `replyMode=auto_simple 的回复必须从安全模板池中选取。"${item.replyText.slice(0, 40)}" 不在允许的模板列表中。`);
    }
  }
  if (item.replyMode === 'auto_natural') {
    const natural = validateNaturalReply(item.replyText);
    if (!natural.ok) {
      return failResult(item, RESULT_CODES.BLOCKED, `replyMode=auto_natural 的回复未通过安全校验：${natural.errors.join('；')}`);
    }
  }

  // Check duplicate — already succeeded
  if (hasSucceededAction(item.eventId, 'reply_comment')) {
    return failResult(item, RESULT_CODES.DUPLICATE_ACTION, '该评论已有成功回复记录，不能重复创建');
  }

  // P1-3: Check duplicate — active action already exists
  if (hasActiveAction(item.eventId, 'reply_comment')) {
    return failResult(item, RESULT_CODES.DUPLICATE_ACTION, '该评论已有待执行回复动作（prepared），不能重复创建。请先执行或重置已有动作。');
  }

  // Create action with audit trail in evidence_json
  const auditInfo = {
    decision: item.decision,
    riskLevel: item.riskLevel,
    relevance: item.relevance || 'neutral',
    commentCategory: item.commentCategory || '',
    replyMode: item.replyMode || '',
    autoExecuteAllowed: false,
    decisionReason: item.decisionReason || '',
    workContextId: item.workContextId || '',
    policyVersion: '0.1.0',
    preparedAt: new Date().toISOString(),
  };
  const actionId = createAction({
    eventId: item.eventId,
    actionType: 'reply_comment',
    targetTitle: ev.my_work_title || '',
    actionText: item.replyText.trim(),
    evidenceJson: JSON.stringify(auditInfo),
  });

  // P0-3: Sync event status to 'planned'
  updateEventStatus(item.eventId, 'planned');

  return {
    itemIndex: item.itemIndex,
    ok: true,
    actionId,
    eventId: item.eventId,
    actorName: ev.actor_name,
    workTitle: ev.my_work_title,
    commentText: ev.comment_text,
    replyText: item.replyText.trim(),
    status: 'prepared',
    decision: item.decision,
    riskLevel: item.riskLevel,
    relevance: item.relevance || 'neutral',
    commentCategory: item.commentCategory || '',
    replyMode: item.replyMode || '',
    autoExecuteAllowed: false,
    workContextId: item.workContextId || '',
    decisionReason: item.decisionReason || '',
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

  const reason = JSON.stringify({
    decision: item.decision,
    riskLevel: item.riskLevel,
    relevance: item.relevance,
    commentCategory: item.commentCategory,
    replyMode: item.replyMode,
    decisionReason: item.decisionReason || '',
    preparedAt: new Date().toISOString(),
    source: 'comments:prepare-json',
  });
  markCommentReplyPrepared(item.commentId, item.replyText.trim(), reason);

  return {
    itemIndex: item.itemIndex,
    ok: true,
    mode: 'work_comment',
    commentId: item.commentId,
    workId: comment.work_id,
    modalId: comment.modal_id,
    actorName: comment.actor_name,
    commentText: comment.comment_text,
    replyText: item.replyText.trim(),
    status: 'prepared',
  };
}

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const batchMode = Boolean(args.itemsFile || args.itemsJson);
  let loaded = { mode: 'legacy_event', items: [] };
  try {
    loaded = loadBatchItems(args);
  } catch (err) {
    printJsonError('comments:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
    return;
  }

  const events = getEvents({ limit: 500 });
  const results = loaded.items.map(item => {
    if (item.ok === false) return item;
    return loaded.mode === 'work_comment' ? prepareWorkCommentOne(item) : prepareOne(item, events);
  });
  if (loaded.mode === 'work_comment' && args.itemsFile) {
    updatePrepareJsonFile(args.itemsFile, loaded.parsed, results);
  }
  const prepared = results.filter(item => item.ok).length;
  const failed = results.length - prepared;
  const actionIds = results.filter(item => item.ok).map(item => item.actionId);
  const commentIds = results.filter(item => item.ok && item.commentId).map(item => item.commentId);

  if (!batchMode && results.length === 1 && !results[0].ok) {
    printJsonError('comments:prepare', results[0].code, results[0].message, {
      recoverable: false,
      data: results[0],
    });
    return;
  }

  if (args.json) {
    printJsonResult('comments:prepare', { results, actionIds, commentIds }, { prepared, failed, total: results.length, mode: loaded.mode });
  } else {
    console.log(`[prepare] mode=${loaded.mode} prepared=${prepared} failed=${failed} total=${results.length}`);
    for (const result of results) {
      if (result.ok && loaded.mode === 'work_comment') {
        console.log(`  [comment#${result.commentId}] ${result.actorName}: ${result.replyText}`);
      } else if (result.ok) {
        console.log(`  [event#${result.eventId}] action#${result.actionId} ${result.actorName}: ${result.replyText}`);
      } else {
        console.log(`  [event#${result.eventId || '-'}] failed ${result.code}: ${result.message}`);
      }
    }
    if (commentIds.length > 0 && args.itemsFile) {
      console.log(`  下一步: npm run comments:execute-all -- --items-file ${args.itemsFile} --execute`);
    }
    if (actionIds.length > 0) {
      console.log(`  下一步: npm run comments:execute-all -- --action-ids ${actionIds.join(',')} --execute`);
    }
  }
}

main();
