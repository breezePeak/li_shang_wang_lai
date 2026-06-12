import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirectApiAgentProvider,
  inferDirectApiBaseUrl,
  loadAgentSoul,
  resolveDirectApiConfig,
} from '../../src/agent/direct-api-agent-provider.mjs';

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function createServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += String(chunk);
    });
    req.on('end', async () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      await handler(req, res, body);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function getBaseUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('direct api config helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads direct api config from process env', () => {
    const config = withEnv({
      DIRECT_API_BASE_URL: 'https://openrouter.ai/api/v1/',
      DIRECT_API_KEY: 'direct-key',
      DIRECT_API_MODEL: 'openrouter/model',
      DIRECT_API_PROVIDER: 'openrouter',
    }, () => resolveDirectApiConfig({}, process.env));

    expect(config).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'direct-key',
      model: 'openrouter/model',
      keySource: 'env:DIRECT_API_KEY',
    });
  });

  it('reads provider key and model from hermes env without using API_SERVER_KEY as direct key', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tempDir = await mkdtemp(join(tmpdir(), 'direct-api-env-'));
    await mkdir(join(tempDir, 'hermes'), { recursive: true });
    await writeFile(join(tempDir, 'hermes', '.env'), [
      'OPENROUTER_API_KEY=file-openrouter-key',
      'HERMES_INFERENCE_MODEL=openrouter/auto-model',
      'API_SERVER_KEY=hermes-gateway-key',
    ].join('\n'), 'utf8');

    const config = withEnv({
      DIRECT_API_PROVIDER: 'openrouter',
      DIRECT_API_BASE_URL: undefined,
      DIRECT_API_KEY: undefined,
      DIRECT_API_MODEL: undefined,
      HERMES_INFERENCE_MODEL: undefined,
      LOCALAPPDATA: tempDir,
    }, () => resolveDirectApiConfig({}, process.env));

    expect(config).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'file-openrouter-key',
      model: 'openrouter/auto-model',
      keySource: 'env:OPENROUTER_API_KEY',
    });
  });

  it('does not treat API_SERVER_KEY as direct api key', () => {
    expect(() => resolveDirectApiConfig({
      provider: 'openrouter',
      model: 'openrouter/model',
    }, {
      API_SERVER_KEY: 'hermes-only-key',
    })).toThrow('DIRECT_API_KEY is not configured');
  });

  it('infers provider base urls', () => {
    expect(inferDirectApiBaseUrl('openrouter', {})).toBe('https://openrouter.ai/api/v1');
    expect(inferDirectApiBaseUrl('deepseek', {})).toBe('https://api.deepseek.com/v1');
    expect(inferDirectApiBaseUrl('dashscope', {})).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(inferDirectApiBaseUrl('qwen', {})).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('throws clear errors when baseUrl, key, or model are missing', () => {
    expect(() => resolveDirectApiConfig({
      provider: 'custom',
      apiKey: 'x',
      model: 'm',
    }, {})).toThrow('DIRECT_API_BASE_URL is not configured');

    expect(() => resolveDirectApiConfig({
      provider: 'openrouter',
      model: 'm',
    }, {})).toThrow('DIRECT_API_KEY is not configured');

    expect(() => resolveDirectApiConfig({
      provider: 'openrouter',
      apiKey: 'x',
    }, {})).toThrow('DIRECT_API_MODEL is not configured');
  });

  it('loads soul from options and enforces require flag', () => {
    expect(loadAgentSoul({ soul: '我是 Agent 灵魂设定' }, {})).toMatchObject({
      soul: '我是 Agent 灵魂设定',
      loaded: true,
    });

    expect(() => loadAgentSoul({}, { DIRECT_API_REQUIRE_SOUL: '1' })).toThrow('SOUL.md is required but not found');
  });
});

describe('DirectApiAgentProvider', () => {
  let server = null;
  let requests = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
      requests = null;
    }
  });

  it('generateComment posts chat completions with soul and safety rules', async () => {
    ({ server, requests } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"comment":"挺真诚的分享"}' } }],
      }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '赫妹儿，说话自然一点',
      timeoutMs: 2000,
      env: {},
    });

    await expect(provider.generateComment({
      taskId: 'visit_1',
      targetUser: { userId: 'u1', nickname: '小王', profileUrl: 'https://example.com/u1' },
      work: { workId: 'w1', desc: '今天聊一个做号踩坑', authorNickname: '作者A' },
      interaction: { type: 'like', source: 'notification' },
      requirements: { maxLength: 30, tone: '自然' },
    })).resolves.toBe('挺真诚的分享');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer direct-token');
    const payload = JSON.parse(requests[0].body);
    expect(payload.model).toBe('openrouter/test-model');
    expect(payload.stream).toBe(false);
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[0].content).toContain('赫妹儿，说话自然一点');
    expect(payload.messages[0].content).toContain('评论生成规则与安全边界');
    expect(payload.messages[1].content).toContain('"taskId": "visit_1"');
    expect(payload.messages[1].content).toContain('"workId": "w1"');
  });

  it('generateReply parses reply output and sends comment context', async () => {
    ({ server, requests } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"reply":"这个问题切得挺准，后面还能继续展开聊呀"}' } }],
      }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '自然一点',
      timeoutMs: 2000,
      env: {},
    });

    await expect(provider.generateReply({
      taskId: 'work_comment_1',
      work: { workId: 'w1', title: '作品标题', desc: '作品描述', authorNickname: '作者A' },
      comment: { commentId: 'c1', actorName: '小李', text: '这个点能展开讲吗', timeText: '1天前' },
      requirements: { minLength: 15, maxLength: 60, tone: '自然' },
    })).resolves.toBe('这个问题切得挺准，后面还能继续展开聊呀');

    const payload = JSON.parse(requests[0].body);
    expect(payload.messages[1].content).toContain('"taskId": "work_comment_1"');
    expect(payload.messages[1].content).toContain('"commentId": "c1"');
    expect(payload.messages[1].content).toContain('这个点能展开讲吗');
  });

  it('generateReplies keeps batch order aligned with input taskIds', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              replies: [
                { taskId: 'work_comment_2', reply: '第二条这句挺有画面感，后面还能顺着聊下去' },
                { taskId: 'work_comment_1', reply: '第一条这个问题挺具体，顺着展开会更自然呀' },
              ],
            }),
          },
        }],
      }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '自然一点',
      timeoutMs: 2000,
      env: {},
    });

    await expect(provider.generateReplies([
      { taskId: 'work_comment_1', comment: { text: '评论1' }, requirements: { minLength: 15, maxLength: 60 } },
      { taskId: 'work_comment_2', comment: { text: '评论2' }, requirements: { minLength: 15, maxLength: 60 } },
    ])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: '第一条这个问题挺具体，顺着展开会更自然呀' },
      { taskId: 'work_comment_2', reply: '第二条这句挺有画面感，后面还能顺着聊下去' },
    ]);
  });

  it('rejects when api returns non-2xx status', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'provider exploded' } }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '自然一点',
      timeoutMs: 2000,
      env: {},
    });

    await expect(provider.generateComment({ taskId: 'visit_fail' }))
      .rejects.toThrow('Direct API request failed with status 500: provider exploded');
  });

  it('rejects when response has no message content', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '自然一点',
      timeoutMs: 2000,
      env: {},
    });

    await expect(provider.generateComment({ taskId: 'visit_missing' }))
      .rejects.toThrow('Direct API response missing choices[0].message.content');
  });

  it('rejects on request timeout', async () => {
    ({ server } = await createServer(async (_req, res) => {
      await new Promise(resolve => setTimeout(resolve, 80));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"comment":"挺真诚的分享"}' } }],
      }));
    }));

    const provider = new DirectApiAgentProvider({
      provider: 'openrouter',
      baseUrl: getBaseUrl(server),
      apiKey: 'direct-token',
      model: 'openrouter/test-model',
      soul: '自然一点',
      timeoutMs: 20,
      env: {},
    });

    await expect(provider.generateComment({ taskId: 'visit_timeout' }))
      .rejects.toThrow('Direct API request timeout after 20ms');
  });
});
