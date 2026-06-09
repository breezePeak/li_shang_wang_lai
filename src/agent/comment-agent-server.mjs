import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

export const DEFAULT_COMMENT_MAX_LENGTH = 30;
export const DEFAULT_REPLY_MIN_LENGTH = 15;
const COMMENT_RULES_PATH = resolve('references', 'comment-safety-rules.md');
let cachedCommentRules = null;

export function loadCommentSafetyRules() {
  if (cachedCommentRules !== null) return cachedCommentRules;
  try {
    cachedCommentRules = readFileSync(COMMENT_RULES_PATH, 'utf8').trim();
  } catch {
    cachedCommentRules = '';
  }
  return cachedCommentRules;
}

export function getCommentMaxLength(value = process.env.COMMENT_MAX_LENGTH) {
  const n = Number(value || DEFAULT_COMMENT_MAX_LENGTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMMENT_MAX_LENGTH;
}

export function getReplyMinLength(value = process.env.REPLY_MIN_LENGTH || process.env.COMMENT_MIN_LENGTH) {
  const n = Number(value || DEFAULT_REPLY_MIN_LENGTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REPLY_MIN_LENGTH;
}

export function countVisibleChars(text = '') {
  return Array.from(String(text || '').replace(/\s+/g, '')).length;
}

export function hasAgentDisclosure(text = '') {
  const value = String(text || '').trim();
  return /(Agent|AI|助手|智能体|Hermes|OpenClaw|Claude|ChatGPT|代回|帮回|替.*回)/i.test(value);
}

export function hasForbiddenReplyPersona(text = '') {
  return /主人|主家|替.*主|帮.*主|自动回复|系统生成|系统提示/.test(String(text || ''));
}

export function buildCommentPrompt(context = {}) {
  const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
  const targetUser = context.targetUser || {};
  const work = context.work || {};
  const interaction = context.interaction || {};
  const safetyRules = loadCommentSafetyRules();

  return [
    '你是抖音创作者互动助手，只负责生成一条回访评论。',
    safetyRules ? ['必须遵守下面这份项目评论生成规则：', safetyRules].join('\n') : '',
    '输出格式要求：只能返回 JSON，格式为：{"comment":"评论内容"}。comment 字段必须是纯文本，不要 Markdown，不要解释，不要多个备选。',
    `本次 maxLength=${maxLength}。`,
    '',
    '上下文：',
    JSON.stringify({
      taskId: context.taskId || '',
      targetUser: {
        userId: targetUser.userId || '',
        nickname: targetUser.nickname || '',
        profileUrl: targetUser.profileUrl || '',
      },
      work: {
        workId: work.workId || '',
        desc: work.desc || '',
        authorNickname: work.authorNickname || targetUser.nickname || '',
      },
      interaction: {
        type: interaction.type || 'like',
        source: interaction.source || 'notification',
      },
      requirements: {
        maxLength,
        tone: context?.requirements?.tone || '自然、简短、像真人',
      },
    }, null, 2),
  ].join('\n');
}

export function buildReplyPrompt(context = {}) {
  const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
  const minLength = Number(context?.requirements?.minLength || getReplyMinLength());
  const requireAgentDisclosure = context?.requirements?.requireAgentDisclosure !== false;
  const safetyRules = loadCommentSafetyRules();
  const work = context.work || {};
  const comment = context.comment || {};

  return [
    '你是抖音创作者互动助手，只负责生成一条对评论的回复。',
    safetyRules ? ['必须遵守下面这份项目评论生成规则：', safetyRules].join('\n') : '',
    '输出格式要求：只能返回 JSON，格式为：{"reply":"回复内容"}。reply 字段必须是纯文本，不要 Markdown，不要解释，不要多个备选。',
    `本次回复长度必须在 ${minLength}-${maxLength} 个中文可见字符之间，少于 ${minLength} 个字不合格。`,
    requireAgentDisclosure ? [
      '本次是 Agent 代回评。必须由你根据自己的真实身份、模型名或工作方式自然披露，让对方知道不是作者本人直接回复。',
      '不要使用本项目写死的人设名或示例名；不要为了迎合项目而固定自称“小猿”。如果你本身叫 Hermes、OpenClaw、Claude、ChatGPT 或其他名称，可自然使用自己的身份。',
      '要让回复有你自己的 Agent 特点和观察，不要只机械加“代回”。不要写“主人/主家”“替主人回”“系统生成”“自动回复”等伪装身份或系统提示。',
    ].join('\n') : '',
    '',
    '上下文：',
    JSON.stringify({
      taskId: context.taskId || '',
      work: {
        workId: work.workId || '',
        title: work.title || '',
        desc: work.desc || '',
        authorNickname: work.authorNickname || '',
      },
      comment: {
        commentId: comment.commentId || '',
        actorName: comment.actorName || '',
        text: comment.text || '',
        timeText: comment.timeText || '',
      },
      requirements: {
        minLength,
        maxLength,
        requireAgentDisclosure,
        tone: context?.requirements?.tone || '自然、简短、像真人',
      },
    }, null, 2),
  ].filter(Boolean).join('\n');
}

export function buildReplyBatchPrompt(contexts = []) {
  const items = Array.isArray(contexts) ? contexts : [];
  const safetyRules = loadCommentSafetyRules();
  const normalized = items.map(context => {
    const work = context.work || {};
    const comment = context.comment || {};
    const minLength = Number(context?.requirements?.minLength || getReplyMinLength());
    const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
    const requireAgentDisclosure = context?.requirements?.requireAgentDisclosure !== false;

    return {
      taskId: context.taskId || '',
      work: {
        workId: work.workId || '',
        title: work.title || '',
        desc: work.desc || '',
        authorNickname: work.authorNickname || '',
      },
      comment: {
        commentId: comment.commentId || '',
        actorName: comment.actorName || '',
        text: comment.text || '',
        timeText: comment.timeText || '',
      },
      requirements: {
        minLength,
        maxLength,
        requireAgentDisclosure,
        tone: context?.requirements?.tone || '自然、简短、像真人',
      },
    };
  });

  return [
    '你是抖音创作者互动助手，只负责批量生成对评论的回复。',
    safetyRules ? ['必须遵守下面这份项目评论生成规则：', safetyRules].join('\n') : '',
    '输出格式要求：只能返回 JSON，格式为：{"replies":[{"taskId":"work_comment_1","reply":"回复内容"}]}。',
    'replies 数量必须与输入待回评列表一致；taskId 必须原样返回；reply 字段必须是纯文本，不要 Markdown，不要解释，不要多个备选。',
    '每条回复都要结合对应评论独立生成，避免机械重复；不要合并多条评论，不要漏掉任何 taskId。',
    '如果某条要求 requireAgentDisclosure=true，必须由你根据自己的真实身份、模型名或工作方式自然披露，让对方知道不是作者本人直接回复。',
    '不要使用本项目写死的人设名或示例名；不要为了迎合项目而固定自称“小猿”。如果你本身叫 Hermes、OpenClaw、Claude、ChatGPT 或其他名称，可自然使用自己的身份。',
    '要让每条回复有你自己的 Agent 特点和观察，不要只机械加“代回”。不要写“主人/主家”“替主人回”“系统生成”“自动回复”等伪装身份或系统提示。',
    '',
    '待回评列表：',
    JSON.stringify(normalized, null, 2),
  ].filter(Boolean).join('\n');
}

export function extractJson(text = '') {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last < first) {
    throw new Error('Hermes 返回格式错误: 未找到 JSON 对象');
  }

  const jsonText = raw.slice(first, last + 1);
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Hermes 返回格式错误: JSON 不是对象');
  }
  if (typeof parsed.comment === 'string') parsed.comment = parsed.comment.trim();
  if (typeof parsed.reply === 'string') parsed.reply = parsed.reply.trim();
  if (Array.isArray(parsed.replies)) {
    parsed.replies = parsed.replies.map(item => ({
      ...item,
      reply: typeof item?.reply === 'string' ? item.reply.trim() : item?.reply,
    }));
  }
  return parsed;
}

export function validateComment(comment, { maxLength = getCommentMaxLength() } = {}) {
  const text = String(comment || '').trim();
  if (!text) throw new Error('comment 为空');
  if (text.length > maxLength) throw new Error(`comment 超长: ${text.length}/${maxLength}`);
  if (/```|\{\s*"comment"|^\s*\[/.test(text)) throw new Error('comment 必须是纯文本');
  return text;
}

export function validateReply(reply, { minLength = getReplyMinLength(), maxLength = getCommentMaxLength(), requireAgentDisclosure = true } = {}) {
  const text = String(reply || '').trim();
  const visibleLength = countVisibleChars(text);
  if (!text) throw new Error('reply 为空');
  if (visibleLength < minLength) throw new Error(`reply 过短: ${visibleLength}/${minLength}`);
  if (visibleLength > maxLength) throw new Error(`reply 超长: ${visibleLength}/${maxLength}`);
  if (requireAgentDisclosure && !hasAgentDisclosure(text)) throw new Error('reply 缺少 Agent 身份提示');
  if (requireAgentDisclosure && hasForbiddenReplyPersona(text)) throw new Error('reply 使用了泛化或伪装身份提示');
  if (/```|\{\s*"reply"|^\s*\[/.test(text)) throw new Error('reply 必须是纯文本');
  return text;
}

export function validateReplyBatch(parsed, contexts = []) {
  if (!Array.isArray(parsed?.replies)) {
    throw new Error('Agent 返回格式错误: replies 必须是数组');
  }

  const expected = new Map();
  for (const context of contexts) {
    const taskId = String(context?.taskId || '').trim();
    if (!taskId) throw new Error('批量回复上下文缺少 taskId');
    if (expected.has(taskId)) throw new Error(`批量回复上下文 taskId 重复: ${taskId}`);
    expected.set(taskId, context);
  }

  if (parsed.replies.length !== expected.size) {
    throw new Error(`Agent 返回回复数量不匹配: ${parsed.replies.length}/${expected.size}`);
  }

  const byTaskId = new Map();
  for (const item of parsed.replies) {
    const taskId = String(item?.taskId || '').trim();
    if (!expected.has(taskId)) throw new Error(`Agent 返回未知 taskId: ${taskId || '(empty)'}`);
    if (byTaskId.has(taskId)) throw new Error(`Agent 返回重复 taskId: ${taskId}`);

    const context = expected.get(taskId);
    const minLength = Number(context?.requirements?.minLength || getReplyMinLength());
    const maxLength = Number(context?.requirements?.maxLength || getCommentMaxLength());
    const requireAgentDisclosure = context?.requirements?.requireAgentDisclosure !== false;
    byTaskId.set(taskId, validateReply(item?.reply, { minLength, maxLength, requireAgentDisclosure }));
  }

  const missing = [...expected.keys()].filter(taskId => !byTaskId.has(taskId));
  if (missing.length > 0) {
    throw new Error(`Agent 缺少回复 taskId: ${missing.join(', ')}`);
  }

  return contexts.map(context => {
    const taskId = String(context?.taskId || '').trim();
    return { taskId, reply: byTaskId.get(taskId) };
  });
}

export function resolveAgentCliConfig(options = {}) {
  const provider = String(options.provider || process.env.AGENT_PROVIDER || 'hermes').trim().toLowerCase();
  if (!['hermes', 'openclaw'].includes(provider)) {
    throw new Error(`不支持的 AGENT_PROVIDER: ${provider}`);
  }

  const bin = options.bin
    || (provider === 'openclaw' ? options.openclawBin : options.hermesBin)
    || (provider === 'openclaw' ? process.env.OPENCLAW_BIN : process.env.HERMES_BIN)
    || provider;

  const argsEnv = provider === 'openclaw' ? process.env.OPENCLAW_ARGS : process.env.HERMES_ARGS;
  const argsTemplate = Array.isArray(options.argsTemplate)
    ? options.argsTemplate
    : String(options.argsTemplate || argsEnv || 'chat -Q -q {prompt}')
      .split(' ')
      .map(part => part.trim())
      .filter(Boolean);

  const timeoutMs = Number(
    options.timeoutMs
    || process.env.AGENT_TIMEOUT_MS
    || (provider === 'openclaw' ? process.env.OPENCLAW_TIMEOUT_MS : process.env.HERMES_TIMEOUT_MS)
    || 60000
  );

  return {
    provider,
    bin,
    argsTemplate,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000,
  };
}

export async function callAgentCli(prompt, options = {}) {
  const config = resolveAgentCliConfig(options);
  const args = config.argsTemplate.map(part => part === '{prompt}' ? prompt : part);
  if (!args.includes(prompt)) args.push(prompt);

  const { stdout } = await execFileAsync(config.bin, args, {
    timeout: config.timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function callHermes(prompt, options = {}) {
  return callAgentCli(prompt, { ...options, provider: 'hermes' });
}

export async function generateCommentWithHermes(context, options = {}) {
  const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getCommentMaxLength());
  const basePrompt = buildCommentPrompt({
    ...context,
    requirements: {
      ...(context?.requirements || {}),
      maxLength,
    },
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint = attempt === 1 ? '' : [
      '',
      '上一次返回格式错误。你只能返回 JSON，例如：',
      '{"comment":"评论内容"}',
      '不要解释，不要 Markdown。',
    ].join('\n');
    try {
      const output = await callAgentCli(`${basePrompt}${retryHint}`, options);
      const parsed = extractJson(output);
      if (typeof parsed.comment !== 'string') {
        throw new Error('Agent 返回格式错误: comment 必须是 string');
      }
      return validateComment(parsed.comment, { maxLength });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Agent 生成评论失败');
}

export async function generateReplyWithHermes(context, options = {}) {
  const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getCommentMaxLength());
  const minLength = Number(context?.requirements?.minLength || options.minLength || getReplyMinLength());
  const requireAgentDisclosure = context?.requirements?.requireAgentDisclosure !== false;
  const basePrompt = buildReplyPrompt({
    ...context,
    requirements: {
      ...(context?.requirements || {}),
      minLength,
      maxLength,
      requireAgentDisclosure,
    },
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint = attempt === 1 ? '' : [
      '',
      '上一次返回格式错误。你只能返回 JSON，例如：',
      '{"reply":"回复内容"}',
      `回复必须是 ${minLength}-${maxLength} 个中文可见字符，不要解释，不要 Markdown。`,
      requireAgentDisclosure ? '回复里必须由你根据自己的真实身份或工作方式自然披露这是 Agent 代回；不要写主人/主家、自动回复或系统提示。' : '',
    ].join('\n');
    try {
      const output = await callAgentCli(`${basePrompt}${retryHint}`, options);
      const parsed = extractJson(output);
      if (typeof parsed.reply !== 'string') {
        throw new Error('Agent 返回格式错误: reply 必须是 string');
      }
      return validateReply(parsed.reply, { minLength, maxLength, requireAgentDisclosure });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Agent 生成回复失败');
}

export async function generateRepliesWithHermes(contexts = [], options = {}) {
  const items = Array.isArray(contexts) ? contexts : [];
  if (items.length === 0) return [];

  const normalized = items.map(context => {
    const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getCommentMaxLength());
    const minLength = Number(context?.requirements?.minLength || options.minLength || getReplyMinLength());
    const requireAgentDisclosure = context?.requirements?.requireAgentDisclosure !== false;
    return {
      ...context,
      requirements: {
        ...(context?.requirements || {}),
        minLength,
        maxLength,
        requireAgentDisclosure,
      },
    };
  });
  const basePrompt = buildReplyBatchPrompt(normalized);

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint = attempt === 1 ? '' : [
      '',
      '上一次返回格式错误。你只能返回 JSON，例如：',
      '{"replies":[{"taskId":"work_comment_1","reply":"Hermes代看后觉得这个问题后面可以展开聊聊"}]}',
      `必须返回 ${normalized.length} 条 replies，taskId 必须和输入完全一致，不要解释，不要 Markdown。`,
    ].join('\n');
    try {
      const output = await callAgentCli(`${basePrompt}${retryHint}`, options);
      const parsed = extractJson(output);
      return validateReplyBatch(parsed, normalized);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Agent 批量生成回复失败');
}
