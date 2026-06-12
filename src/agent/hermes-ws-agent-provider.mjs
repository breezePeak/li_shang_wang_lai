import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { generateCommentWithHermes, generateRepliesWithHermes, generateReplyWithHermes } from './comment-agent-server.mjs';

function resolveTimeoutMs(options = {}) {
  const timeoutMs = Number(
    options.timeoutMs
    || process.env.AGENT_WS_TIMEOUT_MS
    || process.env.AGENT_TIMEOUT_MS
    || 60000
  );
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
}

function extractResponsePayload(message = {}) {
  if (message.ok === false) {
    throw new Error(message.error || 'agent websocket request failed');
  }
  if (message.success === false) {
    throw new Error(message.error || 'agent websocket request failed');
  }
  if (typeof message.output === 'string') return message.output;
  if (typeof message?.data?.output === 'string') return message.data.output;
  throw new Error('agent websocket response missing output');
}

export class HermesWebSocketAgentProvider {
  constructor(options = {}) {
    this.options = options;
    this.url = options.url || process.env.HERMES_WS_URL || '';
    this.timeoutMs = resolveTimeoutMs(options);
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.socket = null;
    this.connectPromise = null;
    this.pendingRequests = new Map();
    this.requestCounter = 0;
    this.closed = false;
  }

  createRequestId() {
    this.requestCounter += 1;
    try {
      return randomUUID();
    } catch {
      return `agent-ws-${Date.now()}-${this.requestCounter}`;
    }
  }

  attachSocketHandlers(socket) {
    socket.on('message', (buffer) => {
      let message = null;
      try {
        message = JSON.parse(String(buffer || ''));
      } catch {
        return;
      }

      const requestId = String(message?.requestId || '').trim();
      if (!requestId) return;
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;

      clearTimeout(pending.timeoutHandle);
      this.pendingRequests.delete(requestId);

      try {
        pending.resolve(extractResponsePayload(message));
      } catch (error) {
        pending.reject(error);
      }
    });

    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.rejectAllPending(error);
      }
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.connectPromise = null;
        this.rejectAllPending(new Error('agent websocket connection closed'));
      }
    });
  }

  rejectAllPending(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'agent websocket connection closed'));
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(reason);
    }
    this.pendingRequests.clear();
  }

  async ensureSocket() {
    if (this.closed) {
      throw new Error('agent websocket provider already closed');
    }
    if (!this.url) {
      throw new Error('HERMES_WS_URL is not configured');
    }
    if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url);
      let settled = false;

      const cleanup = () => {
        clearTimeout(connectTimeoutHandle);
        socket.off?.('open', onOpen);
        socket.off?.('error', onError);
        socket.off?.('close', onCloseBeforeOpen);
      };

      const connectTimeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.terminate?.();
        } catch {}
        this.connectPromise = null;
        reject(new Error(`agent websocket connect timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = socket;
        this.connectPromise = null;
        this.attachSocketHandlers(socket);
        resolve(socket);
      };

      const onError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.connectPromise = null;
        reject(error instanceof Error ? error : new Error(String(error || 'agent websocket connect failed')));
      };

      const onCloseBeforeOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.connectPromise = null;
        reject(new Error('agent websocket connection closed before open'));
      };

      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onCloseBeforeOpen);
    });

    try {
      return await this.connectPromise;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  async callAgent(prompt) {
    const socket = await this.ensureSocket();
    const requestId = this.createRequestId();

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`agent websocket request timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutHandle });

      try {
        socket.send(JSON.stringify({
          type: 'agent.prompt',
          requestId,
          payload: { prompt },
        }));
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
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

  async close() {
    this.closed = true;
    this.rejectAllPending(new Error('agent websocket provider closed'));
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (!socket) return;

    if (socket.readyState === this.WebSocketImpl.OPEN || socket.readyState === this.WebSocketImpl.CONNECTING) {
      await new Promise(resolve => {
        socket.once('close', () => resolve());
        socket.close();
      }).catch(() => {});
    }
  }
}
