import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  generateCommentWithHermes,
  generateRepliesWithHermes,
  generateReplyWithHermes,
} from './comment-agent-server.mjs';

export function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:8642/v1').replace(/\/+$/, '');
}

export function resolveHermesEnvPath(env = process.env) {
  const localAppData = String(env?.LOCALAPPDATA || '').trim();
  if (process.platform === 'win32' && localAppData) {
    return join(localAppData, 'hermes', '.env');
  }
  return join(homedir(), '.hermes', '.env');
}

export function parseSimpleEnv(content = '') {
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export function readHermesEnvConfig(env = process.env) {
  const filePath = resolveHermesEnvPath(env);
  if (!existsSync(filePath)) return {};
  try {
    return parseSimpleEnv(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function readHermesEnvKey(env = process.env) {
  return String(readHermesEnvConfig(env).API_SERVER_KEY || '').trim();
}

function resolveTimeoutMs(options = {}) {
  const timeoutMs = Number(
    options.timeoutMs
    || process.env.AGENT_API_TIMEOUT_MS
    || process.env.AGENT_TIMEOUT_MS
    || 60000
  );
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
}

async function parseErrorResponse(response) {
  try {
    const data = await response.json();
    return data?.error?.message || data?.error || data?.message || '';
  } catch {
    try {
      return (await response.text()).trim();
    } catch {
      return '';
    }
  }
}

export class HermesApiAgentProvider {
  constructor(options = {}) {
    this.options = options;
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.HERMES_API_BASE_URL);
    this.apiKey = options.apiKey || process.env.HERMES_API_KEY || readHermesEnvKey() || '';
    this.model = options.model || process.env.HERMES_API_MODEL || 'hermes-agent';
    this.timeoutMs = resolveTimeoutMs(options);
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async callAgent(prompt) {
    if (!this.apiKey) {
      throw new Error('HERMES_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`Hermes API request timeout after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await parseErrorResponse(response);
        throw new Error(`Hermes API request failed with status ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const data = await response.json();
      const output = data?.choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !output.trim()) {
        throw new Error('Hermes API response missing choices[0].message.content');
      }

      return output;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message === `Hermes API request timeout after ${this.timeoutMs}ms`) {
        throw new Error(`Hermes API request timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async generateComment(context) {
    return generateCommentWithHermes(context, {
      ...this.options,
      callAgent: this.callAgent.bind(this),
    });
  }

  async generateReply(context) {
    return generateReplyWithHermes(context, {
      ...this.options,
      callAgent: this.callAgent.bind(this),
    });
  }

  async generateReplies(contexts) {
    return generateRepliesWithHermes(contexts, {
      ...this.options,
      callAgent: this.callAgent.bind(this),
    });
  }

  async close() {}
}
