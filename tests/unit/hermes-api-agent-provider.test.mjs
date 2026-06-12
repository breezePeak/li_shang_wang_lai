import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HermesApiAgentProvider,
  parseSimpleEnv,
  readHermesEnvConfig,
} from '../../src/agent/hermes-api-agent-provider.mjs';

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

describe('HermesApiAgentProvider', () => {
  let server = null;
  let requests = null;

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
      requests = null;
    }
  });

  it('generateComment posts chat completions and parses response content', async () => {
    ({ server, requests } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"comment":"挺真实"}' } }],
      }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 2000,
    });

    await expect(provider.generateComment({
      taskId: 'visit_api_1',
      interaction: { type: 'comment' },
      work: { desc: '作品描述' },
    })).resolves.toBe('挺真实');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer local-token');
    const payload = JSON.parse(requests[0].body);
    expect(payload.model).toBe('hermes-agent');
    expect(payload.stream).toBe(false);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content).toContain('"comment":"评论内容"');
  });

  it('generateReply parses reply output', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"reply":"Hermes代看后觉得这个问题可以展开聊聊"}' } }],
      }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 2000,
    });

    await expect(provider.generateReply({
      taskId: 'reply_api_1',
      requirements: { minLength: 15, maxLength: 30 },
    })).resolves.toBe('Hermes代看后觉得这个问题可以展开聊聊');
  });

  it('generateReplies keeps batch order aligned with input taskIds', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              replies: [
                { taskId: 'work_comment_2', reply: 'Hermes代看后觉得2号评论挺真诚自然' },
                { taskId: 'work_comment_1', reply: 'Hermes代看后觉得1号评论挺真诚自然' },
              ],
            }),
          },
        }],
      }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 2000,
    });

    await expect(provider.generateReplies([
      { taskId: 'work_comment_1', requirements: { minLength: 15, maxLength: 30 }, comment: { text: '评论1' } },
      { taskId: 'work_comment_2', requirements: { minLength: 15, maxLength: 30 }, comment: { text: '评论2' } },
    ])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: 'Hermes代看后觉得1号评论挺真诚自然' },
      { taskId: 'work_comment_2', reply: 'Hermes代看后觉得2号评论挺真诚自然' },
    ]);
  });

  it('rejects when api returns non-2xx status', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'gateway exploded' } }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 2000,
    });

    await expect(provider.generateComment({ taskId: 'visit_api_fail' }))
      .rejects.toThrow('Hermes API request failed with status 500: gateway exploded');
  });

  it('rejects when response has no message content', async () => {
    ({ server } = await createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 2000,
    });

    await expect(provider.generateComment({ taskId: 'visit_api_missing' }))
      .rejects.toThrow('Hermes API response missing choices[0].message.content');
  });

  it('rejects on request timeout', async () => {
    ({ server } = await createServer(async (_req, res) => {
      await new Promise(resolve => setTimeout(resolve, 80));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"comment":"挺真实"}' } }],
      }));
    }));

    const provider = new HermesApiAgentProvider({
      baseUrl: getBaseUrl(server),
      apiKey: 'local-token',
      timeoutMs: 20,
    });

    await expect(provider.generateComment({ taskId: 'visit_api_timeout' }))
      .rejects.toThrow('Hermes API request timeout after 20ms');
  });

  it('rejects when apiKey is missing', async () => {
    const provider = new HermesApiAgentProvider({
      apiKey: '',
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });

    await expect(provider.generateComment({ taskId: 'visit_api_no_key' }))
      .rejects.toThrow('HERMES_API_KEY is not configured');
  });
});

describe('hermes api env helpers', () => {
  it('parses simple env content', () => {
    expect(parseSimpleEnv(`
      API_SERVER_KEY=abc123
      API_SERVER_PORT=8642
      API_SERVER_HOST=127.0.0.1
    `)).toEqual({
      API_SERVER_KEY: 'abc123',
      API_SERVER_PORT: '8642',
      API_SERVER_HOST: '127.0.0.1',
    });
  });

  it('reads API_SERVER_KEY from hermes env file', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tempDir = await mkdtemp(join(tmpdir(), 'hermes-api-provider-'));
    const hermesDir = join(tempDir, 'hermes');
    await (await import('node:fs/promises')).mkdir(hermesDir, { recursive: true });
    await writeFile(join(hermesDir, '.env'), 'API_SERVER_KEY=file-token\n', 'utf8');

    expect(readHermesEnvConfig({ LOCALAPPDATA: tempDir })).toMatchObject({
      API_SERVER_KEY: 'file-token',
    });
  });
});
