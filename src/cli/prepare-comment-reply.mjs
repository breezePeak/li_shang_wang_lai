// 评论回复准备命令
// 根据 eventId 和 replyText 创建一条待审批的回复动作。
// 替代旧的手工编辑 JSON 计划文件中 replyText 和 approved 字段的方式。
//
// 用法：
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
//   --comment-category 参见 comment-reply-policy.md 评论分类
//   --reply-mode 仅接受 auto_simple / needs_review / ignore
//   仅 decision=reply + riskLevel=low 可以创建动作
//   replyMode=ignore 禁止创建动作
//   replyMode=auto_simple 仅从模板池选回复，autoExecuteAllowed 固定 false
//   replyMode=auto_natural 允许经长度和安全词校验的 Agent 自然回复

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
const WORK_CONTEXT_PATH = resolve(__dirname, '../../prompts/work-context.json');

function loadWorkContext() {
  if (!existsSync(WORK_CONTEXT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(WORK_CONTEXT_PATH, 'utf-8'));
  } catch { return null; }
}

function parseArgs(argv) {
  const args = {
    eventId: null,
    replyText: null,
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

function main() {
  runMigrations();

  const args = parseArgs(process.argv.slice(2));

  // Validation
  const missing = [];
  if (!args.eventId) missing.push('--event-id');
  if (!args.replyText || args.replyText.trim().length === 0) missing.push('--reply-text');
  if (missing.length > 0) {
    printJsonError('comments:prepare',
      missing.includes('--reply-text') ? RESULT_CODES.EMPTY_REPLY_TEXT : RESULT_CODES.BLOCKED,
      `缺少必填参数：${missing.join(', ')}。可选参数默认值：--decision reply --risk-level low --relevance neutral --reply-mode auto_natural --comment-category unclear。`,
      { recoverable: false, data: { missing } }); return;
  }

  // Check the event exists and is a comment
  const events = getEvents({ limit: 500 });
  const ev = events.find(e => e.id === args.eventId);
  if (!ev) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `找不到事件 ID=${args.eventId}`, { recoverable: false }); return;
  }
  if (ev.event_type !== 'comment') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `事件 ID=${args.eventId} 不是评论类型`, { recoverable: false }); return;
  }
  if (ev.status === 'unstable') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `事件 ID=${args.eventId} 的相对时间尚未稳定，无法创建回复。请在时间稳定后重新扫描。`, { recoverable: false }); return;
  }

  // Decision policy validation
  const validDecisions = ['reply', 'manual_review', 'ignore'];
  const validRiskLevels = ['low', 'medium', 'high'];

  if (!args.decision || !validDecisions.includes(args.decision)) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `缺少 --decision 参数或值无效（允许: ${validDecisions.join(', ')}）。请先完成评论决策。`, { recoverable: false }); return;
  }
  if (!args.riskLevel || !validRiskLevels.includes(args.riskLevel)) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `缺少 --risk-level 参数或值无效（允许: ${validRiskLevels.join(', ')}）。请先完成风险分级。`, { recoverable: false }); return;
  }
  if (args.decision !== 'reply') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `决策为 "${args.decision}"，不能创建回复动作。仅 decision=reply 可进入候选流程。`, { recoverable: false }); return;
  }
  if (args.riskLevel !== 'low') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `风险等级为 "${args.riskLevel}"，不能创建回复动作。仅 riskLevel=low 可进入候选流程。`, { recoverable: false }); return;
  }

  // Relevance gate: decision=reply + relevance=irrelevant must block
  const validRelevance = ['relevant', 'neutral', 'irrelevant'];
  if (!args.relevance || !validRelevance.includes(args.relevance)) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `缺少 --relevance 参数或值无效（允许: ${validRelevance.join(', ')}）。请先完成相关性判断。`, { recoverable: false }); return;
  }
  if (args.decision === 'reply' && args.relevance === 'irrelevant') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `相关性为 "irrelevant" 但决策为 "reply"，这不符合安全策略。irrelevant 评论不应自动回复。`, { recoverable: false }); return;
  }

  // Reply mode validation
  const validReplyModes = ['auto_simple', 'auto_natural', 'needs_review', 'ignore'];
  const validCategories = ['praise', 'encouragement', 'useful', 'question', 'request', 'risk', 'spam', 'unclear'];

  if (!args.replyMode || !validReplyModes.includes(args.replyMode)) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `缺少 --reply-mode 参数或值无效（允许: ${validReplyModes.join(', ')}）。`, { recoverable: false }); return;
  }
  if (!args.commentCategory || !validCategories.includes(args.commentCategory)) {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `缺少 --comment-category 参数或值无效（允许: ${validCategories.join(', ')}）。`, { recoverable: false }); return;
  }

  // replyMode=ignore must not create action
  if (args.replyMode === 'ignore') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `replyMode=ignore 的评论不应创建回复动作。该评论需跳过。`, { recoverable: false }); return;
  }

  // replyMode=needs_review must not auto-create (decision must be manual_review)
  if (args.replyMode === 'needs_review' && args.decision === 'reply') {
    printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
      `replyMode=needs_review 的评论需要人工审核，不能设置 decision=reply。请改为 decision=manual_review。`, { recoverable: false }); return;
  }

  // replyMode=auto_simple: validate reply text is from allowed template pool
  if (args.replyMode === 'auto_simple') {
    if (!isAllowedTemplate(args.replyText)) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `replyMode=auto_simple 的回复必须从安全模板池中选取。"${args.replyText.slice(0, 40)}" 不在允许的模板列表中。`, { recoverable: false }); return;
    }
  }
  if (args.replyMode === 'auto_natural') {
    const natural = validateNaturalReply(args.replyText);
    if (!natural.ok) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `replyMode=auto_natural 的回复未通过安全校验：${natural.errors.join('；')}`, { recoverable: false }); return;
    }
  }

  // Work-context validation: --work-context-id must match a known work
  const workCtx = loadWorkContext();
  if (args.decision === 'reply' && args.relevance === 'relevant') {
    if (!args.workContextId) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `decision=reply 且 relevance=relevant 时，必须提供 --work-context-id。缺少作品上下文时，请设置 decision=manual_review。`, { recoverable: false }); return;
    }
    if (!workCtx || !Array.isArray(workCtx.works)) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        'work-context.json 缺失或格式错误，无法校验作品上下文', { recoverable: false }); return;
    }
    const matchedWork = workCtx.works.find(w => w.id === args.workContextId);
    if (!matchedWork) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `--work-context-id "${args.workContextId}" 在 work-context.json 中未找到`, { recoverable: false }); return;
    }
    const eventTitle = (ev.my_work_title || '').trim();
    const workTitle = (matchedWork.title || '').trim();
    if (!eventTitle) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `事件 #${args.eventId} 缺少作品标题，无法校验作品上下文匹配。请改为 decision=manual_review。`, { recoverable: false }); return;
    }
    if (!workTitle) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `work-context "${args.workContextId}" 缺少 title 字段，无法校验匹配。`, { recoverable: false }); return;
    }
    const eventTitleLower = eventTitle.toLowerCase();
    const workTitleLower = workTitle.toLowerCase();
    if (!eventTitleLower.includes(workTitleLower) && !workTitleLower.includes(eventTitleLower)) {
      printJsonError('comments:prepare', RESULT_CODES.BLOCKED,
        `作品标题不匹配: event="${ev.my_work_title}" vs work-context="${matchedWork.title}"。请确认 --work-context-id 或改为 decision=manual_review。`, { recoverable: false }); return;
    }
  }

  // Check duplicate — already succeeded
  if (hasSucceededAction(args.eventId, 'reply_comment')) {
    printJsonError('comments:prepare', RESULT_CODES.DUPLICATE_ACTION,
      '该评论已有成功回复记录，不能重复创建', { recoverable: false }); return;
  }

  // P1-3: Check duplicate — active action already exists
  if (hasActiveAction(args.eventId, 'reply_comment')) {
    printJsonError('comments:prepare', RESULT_CODES.DUPLICATE_ACTION,
      '该评论已有待执行回复动作（prepared），不能重复创建。请先执行或重置已有动作。', { recoverable: false }); return;
  }

  const matchedWork = workCtx?.works?.find(w => w.id === args.workContextId) || null;

  // Create action with audit trail in evidence_json
  const auditInfo = {
    decision: args.decision,
    riskLevel: args.riskLevel,
    relevance: args.relevance || 'neutral',
    commentCategory: args.commentCategory || '',
    replyMode: args.replyMode || '',
    autoExecuteAllowed: false,
    decisionReason: args.decisionReason || '',
    workContextId: args.workContextId || '',
    workContextTitle: matchedWork ? matchedWork.title : '',
    workContextSummary: matchedWork ? matchedWork.summary : '',
    policyVersion: '0.1.0',
    preparedAt: new Date().toISOString(),
  };
  const actionId = createAction({
    eventId: args.eventId,
    actionType: 'reply_comment',
    targetTitle: ev.my_work_title || '',
    actionText: args.replyText.trim(),
    evidenceJson: JSON.stringify(auditInfo),
  });

  // P0-3: Sync event status to 'planned'
  updateEventStatus(args.eventId, 'planned');

  const result = {
    actionId,
    eventId: args.eventId,
    actorName: ev.actor_name,
    workTitle: ev.my_work_title,
    commentText: ev.comment_text,
    replyText: args.replyText.trim(),
    status: 'prepared',
    decision: args.decision,
    riskLevel: args.riskLevel,
    relevance: args.relevance || 'neutral',
    commentCategory: args.commentCategory || '',
    replyMode: args.replyMode || '',
    autoExecuteAllowed: false,
    workContextId: args.workContextId || '',
    decisionReason: args.decisionReason || '',
  };

  if (args.json) {
    printJsonResult('comments:prepare', result, { actionId });
  } else {
    console.log(`[prepare] 已创建回复候选 #${actionId}`);
    console.log(`  目标用户: ${ev.actor_name}`);
    console.log(`  作品: ${ev.my_work_title}`);
    console.log(`  原评论: ${ev.comment_text}`);
    console.log(`  回复文本: ${args.replyText}`);
    console.log(`  决策: ${args.decision} | 风险: ${args.riskLevel}`);
    console.log(`  状态: prepared（待审批）`);
  }
}

main();
