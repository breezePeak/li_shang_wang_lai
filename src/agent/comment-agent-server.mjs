import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

export const DEFAULT_COMMENT_MAX_LENGTH = 30;
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
  const safetyRules = loadCommentSafetyRules();
  const work = context.work || {};
  const comment = context.comment || {};

  return [
    '你是抖音创作者互动助手，只负责生成一条对评论的回复。',
    safetyRules ? ['必须遵守下面这份项目评论生成规则：', safetyRules].join('\n') : '',
    '输出格式要求：只能返回 JSON，格式为：{"reply":"回复内容"}。reply 字段必须是纯文本，不要 Markdown，不要解释，不要多个备选。',
    `本次 maxLength=${maxLength}。`,
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
        maxLength,
        tone: context?.requirements?.tone || '自然、简短、像真人',
      },
    }, null, 2),
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
  if (typeof parsed.comment !== 'string') {
    throw new Error('Hermes 返回格式错误: comment 必须是 string');
  }
  parsed.comment = parsed.comment.trim();
  return parsed;
}

export function validateComment(comment, { maxLength = getCommentMaxLength() } = {}) {
  const text = String(comment || '').trim();
  if (!text) throw new Error('comment 为空');
  if (text.length > maxLength) throw new Error(`comment 超长: ${text.length}/${maxLength}`);
  if (/```|\{\s*"comment"|^\s*\[/.test(text)) throw new Error('comment 必须是纯文本');
  return text;
}

export function validateReply(reply, { maxLength = getCommentMaxLength() } = {}) {
  const text = String(reply || '').trim();
  if (!text) throw new Error('reply 为空');
  if (text.length > maxLength) throw new Error(`reply 超长: ${text.length}/${maxLength}`);
  if (/```|\{\s*"reply"|^\s*\[/.test(text)) throw new Error('reply 必须是纯文本');
  return text;
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
      return validateComment(parsed.comment, { maxLength });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Agent 生成评论失败');
}

export async function generateReplyWithHermes(context, options = {}) {
  const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getCommentMaxLength());
  const basePrompt = buildReplyPrompt({
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
      '{"reply":"回复内容"}',
      '不要解释，不要 Markdown。',
    ].join('\n');
    try {
      const output = await callAgentCli(`${basePrompt}${retryHint}`, options);
      const parsed = extractJson(output);
      if (typeof parsed.reply !== 'string') {
        throw new Error('Agent 返回格式错误: reply 必须是 string');
      }
      return validateReply(parsed.reply, { maxLength });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Agent 生成回复失败');
}
