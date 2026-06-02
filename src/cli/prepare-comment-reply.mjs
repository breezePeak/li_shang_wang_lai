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
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { isAllowedTemplate, validateNaturalReply } from '../domain/reply-templates.mjs';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_WORK_CONTEXT_PATH = resolve(__dirname, '../../config/works.json');
const DEFAULT_WORK_CONTEXT_PATH = resolve(__dirname, '../../prompts/work-context.json');

function loadWorkContext() {
  const contextPath = existsSync(USER_WORK_CONTEXT_PATH) ? USER_WORK_CONTEXT_PATH : DEFAULT_WORK_CONTEXT_PATH;
  if (!existsSync(contextPath)) return null;
  try {
    return JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch { return null; }
}

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

function loadBatchItems(args) {
  const basePolicy = buildBasePolicy(args);

  if (args.itemsFile) {
    const raw = readFileSync(resolve(args.itemsFile), 'utf-8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) throw new Error('--items-file 必须是 JSON 数组，或包含 items 数组');
    return items.map((item, index) => normalizeBatchItem(item, index, basePolicy));
  }

  if (args.itemsJson) {
    const parsed = JSON.parse(args.itemsJson);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) throw new Error('--items-json 必须是 JSON 数组，或包含 items 数组');
    return items.map((item, index) => normalizeBatchItem(item, index, basePolicy));
  }

  return [normalizeBatchItem({
    eventId: args.eventId,
    replyText: args.replyText,
  }, 0, basePolicy)];
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

function prepareOne(item, events, workCtx) {
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

  // Work-context validation: --work-context-id must match a known work
  if (item.decision === 'reply' && item.relevance === 'relevant') {
    if (!item.workContextId) {
      return failResult(item, RESULT_CODES.BLOCKED, 'decision=reply 且 relevance=relevant 时，必须提供 workContextId。缺少作品上下文时，请设置 decision=manual_review。');
    }
    if (!workCtx || !Array.isArray(workCtx.works)) {
      return failResult(item, RESULT_CODES.BLOCKED, '作品上下文配置缺失或格式错误，无法校验作品上下文。请检查 config/works.json 或 prompts/work-context.json。');
    }
    const matchedWork = workCtx.works.find(w => w.id === item.workContextId);
    if (!matchedWork) {
      return failResult(item, RESULT_CODES.BLOCKED, `workContextId "${item.workContextId}" 在作品上下文配置中未找到`);
    }
    const eventTitle = (ev.my_work_title || '').trim();
    const workTitle = (matchedWork.title || '').trim();
    if (!eventTitle) {
      return failResult(item, RESULT_CODES.BLOCKED, `事件 #${item.eventId} 缺少作品标题，无法校验作品上下文匹配。请改为 decision=manual_review。`);
    }
    if (!workTitle) {
      return failResult(item, RESULT_CODES.BLOCKED, `作品上下文 "${item.workContextId}" 缺少 title 字段，无法校验匹配。`);
    }
    const eventTitleLower = eventTitle.toLowerCase();
    const workTitleLower = workTitle.toLowerCase();
    if (!eventTitleLower.includes(workTitleLower) && !workTitleLower.includes(eventTitleLower)) {
      return failResult(item, RESULT_CODES.BLOCKED, `作品标题不匹配: event="${ev.my_work_title}" vs work-context="${matchedWork.title}"。请确认 workContextId 或改为 decision=manual_review。`);
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

  const matchedWork = workCtx?.works?.find(w => w.id === item.workContextId) || null;

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
    workContextTitle: matchedWork ? matchedWork.title : '',
    workContextSummary: matchedWork ? matchedWork.summary : '',
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

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));
  const batchMode = Boolean(args.itemsFile || args.itemsJson);
  let items = [];
  try {
    items = loadBatchItems(args);
  } catch (err) {
    printJsonError('comments:prepare', RESULT_CODES.INVALID_ARGUMENTS, err.message, { recoverable: false });
    return;
  }

  const events = getEvents({ limit: 500 });
  const workCtx = loadWorkContext();
  const results = items.map(item => item.ok === false ? item : prepareOne(item, events, workCtx));
  const prepared = results.filter(item => item.ok).length;
  const failed = results.length - prepared;
  const actionIds = results.filter(item => item.ok).map(item => item.actionId);

  if (!batchMode && results.length === 1 && !results[0].ok) {
    printJsonError('comments:prepare', results[0].code, results[0].message, {
      recoverable: false,
      data: results[0],
    });
    return;
  }

  if (args.json) {
    printJsonResult('comments:prepare', { results, actionIds }, { prepared, failed, total: results.length });
  } else {
    console.log(`[prepare] prepared=${prepared} failed=${failed} total=${results.length}`);
    for (const result of results) {
      if (result.ok) {
        console.log(`  [event#${result.eventId}] action#${result.actionId} ${result.actorName}: ${result.replyText}`);
      } else {
        console.log(`  [event#${result.eventId || '-'}] failed ${result.code}: ${result.message}`);
      }
    }
    if (actionIds.length > 0) {
      console.log(`  下一步: npm run comments:execute-all -- --action-ids ${actionIds.join(',')} --execute`);
    }
  }
}

main();
