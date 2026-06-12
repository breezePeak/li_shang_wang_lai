import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { HermesWebSocketAgentProvider } from '../../src/agent/hermes-ws-agent-provider.mjs';

async function createServer(handler) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', socket => {
    socket.on('message', async (buffer) => {
      const message = JSON.parse(String(buffer || ''));
      await handler(socket, message);
    });
  });
  return server;
}

function getServerUrl(server) {
  const address = server.address();
  return `ws://127.0.0.1:${address.port}`;
}

describe('HermesWebSocketAgentProvider', () => {
  let server = null;
  let provider = null;

  afterEach(async () => {
    if (provider) {
      await provider.close();
      provider = null;
    }
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
  });

  it('sends prompt over websocket and parses comment output', async () => {
    let connectionCount = 0;
    let lastPrompt = '';
    server = await createServer(async (socket, message) => {
      lastPrompt = message.payload.prompt;
      socket.send(JSON.stringify({
        type: 'agent.response',
        requestId: message.requestId,
        ok: true,
        output: '{"comment":"挺真实"}',
      }));
    });
    server.on('connection', () => {
      connectionCount += 1;
    });

    provider = new HermesWebSocketAgentProvider({
      url: getServerUrl(server),
      timeoutMs: 2000,
    });

    await expect(provider.generateComment({ taskId: 'visit_ws_1' })).resolves.toBe('挺真实');
    await expect(provider.generateComment({ taskId: 'visit_ws_2' })).resolves.toBe('挺真实');

    expect(lastPrompt).toContain('只能返回 JSON');
    expect(connectionCount).toBe(1);
  });

  it('supports success payload nested under data.output', async () => {
    server = await createServer(async (socket, message) => {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        success: true,
        data: {
          output: '{"reply":"Hermes代看后觉得这个问题可以展开聊聊"}',
        },
      }));
    });

    provider = new HermesWebSocketAgentProvider({
      url: getServerUrl(server),
      timeoutMs: 2000,
    });

    await expect(provider.generateReply({
      taskId: 'reply_ws_1',
      requirements: { minLength: 15, maxLength: 30 },
    })).resolves.toBe('Hermes代看后觉得这个问题可以展开聊聊');
  });

  it('rejects when websocket returns an error response', async () => {
    server = await createServer(async (socket, message) => {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        ok: false,
        error: 'ws provider failed',
      }));
    });

    provider = new HermesWebSocketAgentProvider({
      url: getServerUrl(server),
      timeoutMs: 2000,
    });

    await expect(provider.generateComment({ taskId: 'visit_ws_fail' })).rejects.toThrow('ws provider failed');
  });

  it('keeps batch result order aligned with input task order', async () => {
    server = await createServer(async (socket, message) => {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        ok: true,
        output: JSON.stringify({
          replies: [
            { taskId: 'work_comment_2', reply: 'Hermes代看后觉得2号评论挺真诚自然' },
            { taskId: 'work_comment_1', reply: 'Hermes代看后觉得1号评论挺真诚自然' },
          ],
        }),
      }));
    });

    provider = new HermesWebSocketAgentProvider({
      url: getServerUrl(server),
      timeoutMs: 2000,
    });

    await expect(provider.generateReplies([
      { taskId: 'work_comment_1', requirements: { minLength: 15, maxLength: 30 } },
      { taskId: 'work_comment_2', requirements: { minLength: 15, maxLength: 30 } },
    ])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: 'Hermes代看后觉得1号评论挺真诚自然' },
      { taskId: 'work_comment_2', reply: 'Hermes代看后觉得2号评论挺真诚自然' },
    ]);
  });

  it('times out websocket connect attempts', async () => {
    class HangingWebSocket extends EventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;

      constructor() {
        super();
        this.readyState = HangingWebSocket.CONNECTING;
        this.terminated = false;
      }

      terminate() {
        this.terminated = true;
        this.readyState = 3;
      }
    }

    provider = new HermesWebSocketAgentProvider({
      url: 'ws://127.0.0.1:3001',
      timeoutMs: 50,
      WebSocketImpl: HangingWebSocket,
    });

    await expect(provider.generateComment({ taskId: 'visit_ws_timeout' }))
      .rejects.toThrow('agent websocket connect timeout after 50ms');
  });
});
