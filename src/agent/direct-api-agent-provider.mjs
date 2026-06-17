import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  extractJson,
  getCommentMaxLength,
  getReplyMaxLength,
  getReplyMinLength,
  getReplyLengthTolerance,
  loadCommentSafetyRules,
  validateComment,
  validateReply,
  validateReplyBatch,
} from './comment-agent-server.mjs';
import { mergeAgentEnv } from './agent-env.mjs';

const DIRECT_API_DEFAULT_TIMEOUT_MS = 60000;
const DIRECT_API_DEFAULT_TEMPERATURE = 0.6;
const DIRECT_API_SINGLE_MAX_TOKENS = 256;

function normalizeProviderName(value = '') {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return '';
  if (provider === 'qwen') return 'dashscope';
  return provider;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function readOptionalFile(filePath = '') {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath || !existsSync(normalizedPath)) return '';
  try {
    return readFileSync(normalizedPath, 'utf8').trim();
  } catch {
    return '';
  }
}

function getProviderBaseUrlFromEnv(provider, mergedEnv = {}) {
  if (provider === 'openai') {
    return firstNonEmpty([
      mergedEnv.OPENAI_BASE_URL,
      mergedEnv.OPENAI_API_BASE_URL,
      mergedEnv.OPENAI_API_BASE,
    ]);
  }
  if (provider === 'openrouter') {
    return firstNonEmpty([
      mergedEnv.OPENROUTER_BASE_URL,
      mergedEnv.OPENROUTER_API_BASE_URL,
    ]);
  }
  if (provider === 'deepseek') {
    return firstNonEmpty([
      mergedEnv.DEEPSEEK_BASE_URL,
      mergedEnv.DEEPSEEK_API_BASE_URL,
    ]);
  }
  if (provider === 'dashscope') {
    return firstNonEmpty([
      mergedEnv.DASHSCOPE_BASE_URL,
      mergedEnv.DASHSCOPE_API_BASE_URL,
      mergedEnv.QWEN_BASE_URL,
      mergedEnv.QWEN_API_BASE_URL,
    ]);
  }
  return '';
}

function getProviderDefaultBaseUrl(provider) {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1';
  if (provider === 'dashscope') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return '';
}

function getProviderKey(provider, mergedEnv = {}) {
  if (provider === 'openai') return firstNonEmpty([mergedEnv.OPENAI_API_KEY]);
  if (provider === 'openrouter') return firstNonEmpty([mergedEnv.OPENROUTER_API_KEY]);
  if (provider === 'deepseek') return firstNonEmpty([mergedEnv.DEEPSEEK_API_KEY]);
  if (provider === 'dashscope') return firstNonEmpty([mergedEnv.DASHSCOPE_API_KEY, mergedEnv.QWEN_API_KEY]);
  return '';
}

function getProviderKeySource(provider, mergedEnv = {}) {
  if (provider === 'openai' && String(mergedEnv.OPENAI_API_KEY || '').trim()) return 'env:OPENAI_API_KEY';
  if (provider === 'openrouter' && String(mergedEnv.OPENROUTER_API_KEY || '').trim()) return 'env:OPENROUTER_API_KEY';
  if (provider === 'deepseek' && String(mergedEnv.DEEPSEEK_API_KEY || '').trim()) return 'env:DEEPSEEK_API_KEY';
  if (provider === 'dashscope') {
    if (String(mergedEnv.DASHSCOPE_API_KEY || '').trim()) return 'env:DASHSCOPE_API_KEY';
    if (String(mergedEnv.QWEN_API_KEY || '').trim()) return 'env:QWEN_API_KEY';
  }
  return '';
}

function getProviderModel(provider, mergedEnv = {}) {
  if (provider === 'openai') return firstNonEmpty([mergedEnv.OPENAI_MODEL]);
  if (provider === 'openrouter') return firstNonEmpty([mergedEnv.OPENROUTER_MODEL]);
  if (provider === 'deepseek') return firstNonEmpty([mergedEnv.DEEPSEEK_MODEL]);
  if (provider === 'dashscope') return firstNonEmpty([mergedEnv.DASHSCOPE_MODEL, mergedEnv.QWEN_MODEL]);
  return '';
}

function parseErrorDetail(data) {
  return data?.error?.message || data?.error || data?.message || '';
}

async function parseErrorResponse(response) {
  try {
    const data = await response.json();
    return parseErrorDetail(data);
  } catch {
    try {
      return (await response.text()).trim();
    } catch {
      return '';
    }
  }
}

export function normalizeDirectApiBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function inferDirectApiProvider(mergedEnv = {}, options = {}) {
  const explicit = normalizeProviderName(firstNonEmpty([
    options.provider,
    mergedEnv.DIRECT_API_PROVIDER,
    mergedEnv.HERMES_INFERENCE_PROVIDER,
    mergedEnv.HERMES_PROVIDER,
    mergedEnv.MODEL_PROVIDER,
    mergedEnv.AGENT_PROVIDER,
  ]));
  if (explicit) return explicit;

  if (String(mergedEnv.OPENROUTER_API_KEY || '').trim()) return 'openrouter';
  if (String(mergedEnv.DEEPSEEK_API_KEY || '').trim()) return 'deepseek';
  if (String(mergedEnv.DASHSCOPE_API_KEY || '').trim()) return 'dashscope';
  if (String(mergedEnv.QWEN_API_KEY || '').trim()) return 'dashscope';
  if (String(mergedEnv.OPENAI_API_KEY || '').trim()) return 'openai';

  if (firstNonEmpty([options.baseUrl, mergedEnv.DIRECT_API_BASE_URL])) {
    return 'custom';
  }

  return '';
}

export function inferDirectApiBaseUrl(provider, mergedEnv = {}, options = {}) {
  const explicitBaseUrl = normalizeDirectApiBaseUrl(firstNonEmpty([
    options.baseUrl,
    mergedEnv.DIRECT_API_BASE_URL,
  ]));
  if (explicitBaseUrl) return explicitBaseUrl;

  const normalizedProvider = normalizeProviderName(provider);
  if (!normalizedProvider || normalizedProvider === 'custom') {
    throw new Error('DIRECT_API_BASE_URL is not configured');
  }

  const providerBaseUrl = normalizeDirectApiBaseUrl(getProviderBaseUrlFromEnv(normalizedProvider, mergedEnv));
  if (providerBaseUrl) return providerBaseUrl;

  if (['anthropic', 'claude', 'gemini'].includes(normalizedProvider)) {
    throw new Error(`Direct API provider ${normalizedProvider} is not OpenAI-compatible; set DIRECT_API_BASE_URL / DIRECT_API_KEY / DIRECT_API_MODEL explicitly`);
  }

  const defaultBaseUrl = getProviderDefaultBaseUrl(normalizedProvider);
  if (defaultBaseUrl) return defaultBaseUrl;

  throw new Error('DIRECT_API_BASE_URL is not configured');
}

export function inferDirectApiKey(provider, mergedEnv = {}, options = {}) {
  const explicitKey = firstNonEmpty([
    options.apiKey,
    mergedEnv.DIRECT_API_KEY,
  ]);
  if (explicitKey) return explicitKey;

  const normalizedProvider = normalizeProviderName(provider);
  const providerKey = getProviderKey(normalizedProvider, mergedEnv);
  if (providerKey) return providerKey;

  throw new Error('DIRECT_API_KEY is not configured');
}

export function inferDirectApiModel(provider, mergedEnv = {}, options = {}) {
  const explicitModel = firstNonEmpty([
    options.model,
    mergedEnv.DIRECT_API_MODEL,
    mergedEnv.HERMES_INFERENCE_MODEL,
    mergedEnv.HERMES_MODEL,
    mergedEnv.MODEL_NAME,
    mergedEnv.MODEL,
  ]);
  if (explicitModel) return explicitModel;

  const normalizedProvider = normalizeProviderName(provider);
  const providerModel = getProviderModel(normalizedProvider, mergedEnv);
  if (providerModel) return providerModel;

  throw new Error('DIRECT_API_MODEL is not configured');
}

export function resolveDirectApiConfig(options = {}, env = process.env) {
  const mergedEnv = mergeAgentEnv(env, options);
  const provider = inferDirectApiProvider(mergedEnv, options);
  const baseUrl = inferDirectApiBaseUrl(provider, mergedEnv, options);
  const apiKey = inferDirectApiKey(provider, mergedEnv, options);
  const model = inferDirectApiModel(provider, mergedEnv, options);
  const timeoutMs = parsePositiveNumber(
    firstNonEmpty([options.timeoutMs, mergedEnv.DIRECT_API_TIMEOUT_MS, mergedEnv.AGENT_TIMEOUT_MS]),
    DIRECT_API_DEFAULT_TIMEOUT_MS
  );
  const temperature = Number(firstNonEmpty([options.temperature, mergedEnv.DIRECT_API_TEMPERATURE]) || DIRECT_API_DEFAULT_TEMPERATURE);
  const maxTokens = parseNonNegativeNumber(mergedEnv.DIRECT_API_MAX_TOKENS, 0);

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    temperature: Number.isFinite(temperature) ? temperature : DIRECT_API_DEFAULT_TEMPERATURE,
    maxTokens,
    keySource: options.apiKey
      ? 'options.apiKey'
      : String(mergedEnv.DIRECT_API_KEY || '').trim()
        ? 'env:DIRECT_API_KEY'
        : getProviderKeySource(provider, mergedEnv),
  };
}

export function resolveSoulPaths(options = {}, env = process.env) {
  const cwd = String(options.cwd || env.PWD || process.cwd() || '').trim();
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  const userProfile = String(env.USERPROFILE || '').trim();
  const home = String(env.HOME || (env === process.env ? homedir() : '') || '').trim();
  const paths = [];

  if (options.soulPath) paths.push(String(options.soulPath));
  if (env.DIRECT_API_SOUL_PATH) paths.push(String(env.DIRECT_API_SOUL_PATH));
  if (cwd) paths.push(resolve(cwd, 'SOUL.md'));
  if (localAppData) paths.push(join(localAppData, 'hermes', 'SOUL.md'));
  if (userProfile) paths.push(join(userProfile, '.hermes', 'SOUL.md'));
  if (home) paths.push(join(home, '.hermes', 'SOUL.md'));

  return [...new Set(paths.map(filePath => resolve(String(filePath))))];
}

export function loadAgentSoul(options = {}, env = process.env) {
  if (typeof options.soul === 'string' && options.soul.trim()) {
    return { soul: options.soul.trim(), path: '', loaded: true, source: 'options.soul' };
  }

  for (const filePath of resolveSoulPaths(options, env)) {
    const soul = readOptionalFile(filePath);
    if (!soul) continue;
    return { soul, path: filePath, loaded: true, source: filePath };
  }

  if (String(env.DIRECT_API_REQUIRE_SOUL || '').trim() === '1') {
    throw new Error('SOUL.md is required but not found');
  }

  return { soul: '', path: '', loaded: false, source: '' };
}

export function buildDirectSystemPrompt({ taskType, outputFormat, soul, safetyRules }) {
  return [
    '你正在执行 li_shang_wang_lai 项目中的短视频互动评论生成任务。',
    '',
    '下面是 Agent 自身风格设定。如果风格设定与项目安全规则冲突，以项目安全规则为准。',
    '',
    '<agent_soul>',
    soul || '未提供',
    '</agent_soul>',
    '',
    '下面是项目评论安全规则。必须严格遵守。',
    '',
    '<project_comment_safety_rules>',
    safetyRules || '未提供',
    '</project_comment_safety_rules>',
    '',
    '任务边界：',
    '1. 你只负责生成评论或回复文本。',
    '2. 你不能要求用户关注、互关、私信、引流。',
    '3. 你不能声称自己已经观看、点赞、收藏、购买、体验过。',
    '4. 不要输出解释。',
    '5. 不要输出 Markdown。',
    '6. 不要输出多个备选。',
    '7. 只返回指定 JSON。',
    '8. 如果 Agent 风格与安全规则冲突，安全规则优先。',
    '',
    `当前任务类型：${taskType || 'unknown'}`,
    '',
    '输出格式：',
    outputFormat,
  ].join('\n');
}

export function buildDirectCommentMessages(context, options = {}) {
  const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getCommentMaxLength());
  const payload = {
    taskType: 'return_visit_comment',
    taskId: context?.taskId || '',
    targetUser: {
      userId: context?.targetUser?.userId || '',
      nickname: context?.targetUser?.nickname || '',
      profileUrl: context?.targetUser?.profileUrl || '',
    },
    work: {
      workId: context?.work?.workId || '',
      desc: context?.work?.desc || '',
      authorNickname: context?.work?.authorNickname || '',
    },
    interaction: {
      type: context?.interaction?.type || '',
      source: context?.interaction?.source || '',
    },
    requirements: {
      maxLength,
      tone: context?.requirements?.tone || '自然、简短、像真人',
    },
  };

  return [
    {
      role: 'system',
      content: buildDirectSystemPrompt({
        taskType: payload.taskType,
        outputFormat: '{"comment":"评论内容"}',
        soul: options.soul || '',
        safetyRules: options.safetyRules || '',
      }),
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

export function buildDirectReplyMessages(context, options = {}) {
  const minLength = Number(context?.requirements?.minLength || options.minLength || getReplyMinLength());
  const maxLength = Number(context?.requirements?.maxLength || options.maxLength || getReplyMaxLength());
  const payload = {
    taskType: 'comment_reply',
    taskId: context?.taskId || '',
    work: {
      workId: context?.work?.workId || '',
      url: context?.work?.url || '',
      title: context?.work?.title || '',
      desc: context?.work?.desc || '',
      authorNickname: context?.work?.authorNickname || '',
      publishedAt: context?.work?.publishedAt || '',
    },
    comment: {
      commentId: context?.comment?.commentId || '',
      actorName: context?.comment?.actorName || '',
      text: context?.comment?.text || '',
      timeText: context?.comment?.timeText || '',
    },
    requirements: {
      minLength,
      maxLength,
      tone: context?.requirements?.tone || '自然、简短、像真人',
      uniquenessPolicy: context?.requirements?.uniquenessPolicy || '',
      avoidReplyText: context?.requirements?.avoidReplyText || '',
    },
  };

  return [
    {
      role: 'system',
      content: buildDirectSystemPrompt({
        taskType: payload.taskType,
        outputFormat: '{"reply":"回复内容"}',
        soul: options.soul || '',
        safetyRules: options.safetyRules || '',
      }),
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

export function buildDirectReplyBatchMessages(contexts, options = {}) {
  const items = (Array.isArray(contexts) ? contexts : []).map(context => ({
    taskId: context?.taskId || '',
    work: {
      workId: context?.work?.workId || '',
      url: context?.work?.url || '',
      title: context?.work?.title || '',
      desc: context?.work?.desc || '',
      authorNickname: context?.work?.authorNickname || '',
      publishedAt: context?.work?.publishedAt || '',
    },
    comment: {
      commentId: context?.comment?.commentId || '',
      actorName: context?.comment?.actorName || '',
      text: context?.comment?.text || '',
      timeText: context?.comment?.timeText || '',
    },
    requirements: {
      minLength: Number(context?.requirements?.minLength || options.minLength || getReplyMinLength()),
      maxLength: Number(context?.requirements?.maxLength || options.maxLength || getReplyMaxLength()),
      tone: context?.requirements?.tone || '自然、简短、像真人',
      uniquenessPolicy: context?.requirements?.uniquenessPolicy || '',
      avoidReplyText: context?.requirements?.avoidReplyText || '',
    },
  }));

  return [
    {
      role: 'system',
      content: buildDirectSystemPrompt({
        taskType: 'comment_reply_batch',
        outputFormat: '{"replies":[{"taskId":"work_comment_1","reply":"回复内容"}]}',
        soul: options.soul || '',
        safetyRules: options.safetyRules || '',
      }),
    },
    {
      role: 'user',
      content: JSON.stringify({
        taskType: 'comment_reply_batch',
        items,
      }, null, 2),
    },
  ];
}

export class DirectApiAgentProvider {
  constructor(options = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl || fetch;
    this.config = resolveDirectApiConfig(options, options.env || process.env);
    this.provider = this.config.provider;
    this.baseUrl = this.config.baseUrl;
    this.apiKey = this.config.apiKey;
    this.model = this.config.model;
    this.timeoutMs = this.config.timeoutMs;
    this.temperature = this.config.temperature;
    this.defaultMaxTokens = this.config.maxTokens;
    this.safetyRules = loadCommentSafetyRules();
    this.soulInfo = loadAgentSoul(options, options.env || process.env);

    if (this.soulInfo.loaded) {
      console.error(`[agent:direct-api] soul=loaded path=${this.soulInfo.path || this.soulInfo.source}`);
    } else {
      console.error('[agent:direct-api] soul=missing');
    }

    console.error(
      `[agent:direct-api] provider=${this.provider} baseUrl=${this.baseUrl} model=${this.model}` +
      ` key=${this.config.keySource || 'unknown'} soul=${this.soulInfo.loaded ? 'loaded' : 'missing'}`
    );
  }

  async callChat(messages, { taskType = '', maxTokens = null } = {}) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`Direct API request timeout after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    const promptChars = Array.isArray(messages)
      ? messages.reduce((total, message) => total + String(message?.content || '').length, 0)
      : 0;

    console.error(
      `[agent:direct-api] request start taskType=${taskType} provider=${this.provider}` +
      ` baseUrl=${this.baseUrl} model=${this.model} promptChars=${promptChars}`
    );

    try {
      const payload = {
        model: this.model,
        stream: false,
        temperature: this.temperature,
        messages,
      };
      if (typeof maxTokens === 'number' && maxTokens > 0) {
        payload.max_tokens = maxTokens;
      }

      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await parseErrorResponse(response);
        throw new Error(`Direct API request failed with status ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const data = await response.json();
      const output = data?.choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !output.trim()) {
        throw new Error('Direct API response missing choices[0].message.content');
      }

      console.error(
        `[agent:direct-api] request done taskType=${taskType} elapsedMs=${Date.now() - startedAt} outputChars=${output.length}`
      );
      return output;
    } catch (error) {
      const reason = error?.name === 'AbortError' || error?.message === `Direct API request timeout after ${this.timeoutMs}ms`
        ? `Direct API request timeout after ${this.timeoutMs}ms`
        : (error?.message || String(error));
      console.error(`[agent:direct-api] request failed taskType=${taskType} elapsedMs=${Date.now() - startedAt} reason=${reason}`);
      if (reason === `Direct API request timeout after ${this.timeoutMs}ms`) {
        throw new Error(reason);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async generateComment(context) {
    const maxLength = Number(context?.requirements?.maxLength || this.options.maxLength || getCommentMaxLength());
    const baseMessages = buildDirectCommentMessages({
      ...context,
      requirements: {
        ...(context?.requirements || {}),
        maxLength,
      },
    }, {
      soul: this.soulInfo.soul,
      safetyRules: this.safetyRules,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = attempt === 1
        ? baseMessages
        : [
          ...baseMessages,
          {
            role: 'user',
            content: [
              '上一次输出不符合要求。你只能返回 JSON，例如：',
              '{"comment":"评论内容"}',
              '不要解释，不要 Markdown。',
            ].join('\n'),
          },
        ];
      try {
        const output = await this.callChat(messages, {
          taskType: 'return_visit_comment',
          maxTokens: this.defaultMaxTokens || DIRECT_API_SINGLE_MAX_TOKENS,
        });
        const parsed = extractJson(output);
        if (typeof parsed.comment !== 'string') {
          throw new Error('Direct API 返回格式错误: comment 必须是 string');
        }
        return validateComment(parsed.comment, { maxLength });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Direct API 生成评论失败');
  }

  async generateReply(context) {
    const minLength = Number(context?.requirements?.minLength || this.options.minLength || getReplyMinLength());
    const maxLength = Number(context?.requirements?.maxLength || this.options.maxLength || getReplyMaxLength());
    const lengthTolerance = Number(context?.requirements?.lengthTolerance ?? this.options.lengthTolerance ?? getReplyLengthTolerance());
    const baseMessages = buildDirectReplyMessages({
      ...context,
      requirements: {
        ...(context?.requirements || {}),
        minLength,
        maxLength,
      },
    }, {
      soul: this.soulInfo.soul,
      safetyRules: this.safetyRules,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = attempt === 1
        ? baseMessages
        : [
          ...baseMessages,
          {
            role: 'user',
            content: [
              '上一次输出不符合要求。你只能返回 JSON，例如：',
              '{"reply":"回复内容"}',
              '回复必须在指定长度范围内，不要解释，不要 Markdown。',
            ].join('\n'),
          },
        ];
      try {
        const output = await this.callChat(messages, {
          taskType: 'comment_reply',
          maxTokens: this.defaultMaxTokens || DIRECT_API_SINGLE_MAX_TOKENS,
        });
        const parsed = extractJson(output);
        if (typeof parsed.reply !== 'string') {
          throw new Error('Direct API 返回格式错误: reply 必须是 string');
        }
        return validateReply(parsed.reply, { minLength, maxLength, lengthTolerance });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Direct API 生成回复失败');
  }

  async generateReplies(contexts) {
    const normalized = Array.isArray(contexts) ? contexts.map(context => ({
      ...context,
      requirements: {
        ...(context?.requirements || {}),
        minLength: Number(context?.requirements?.minLength || this.options.minLength || getReplyMinLength()),
        maxLength: Number(context?.requirements?.maxLength || this.options.maxLength || getReplyMaxLength()),
      },
    })) : [];
    if (normalized.length === 0) return [];

    const baseMessages = buildDirectReplyBatchMessages(normalized, {
      soul: this.soulInfo.soul,
      safetyRules: this.safetyRules,
    });
    const maxTokens = this.defaultMaxTokens || Math.min(4096, Math.max(512, normalized.length * 160));

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = attempt === 1
        ? baseMessages
        : [
          ...baseMessages,
          {
            role: 'user',
            content: [
              '上一次输出不符合要求。你只能返回 JSON，例如：',
              '{"replies":[{"taskId":"work_comment_1","reply":"回复内容"}]}',
              `必须返回 ${normalized.length} 条 replies，taskId 必须与输入完全一致。`,
              '不要解释，不要 Markdown。',
            ].join('\n'),
          },
        ];
      try {
        const output = await this.callChat(messages, {
          taskType: 'comment_reply_batch',
          maxTokens,
        });
        const parsed = extractJson(output);
        return validateReplyBatch(parsed, normalized);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Direct API 批量生成回复失败');
  }

  async close() {}
}
