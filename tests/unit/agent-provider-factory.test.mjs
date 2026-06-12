import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentProvider } from '../../src/agent/agent-provider-factory.mjs';
import { LocalAgentProvider } from '../../src/agent/local-agent-provider.mjs';
import { HermesWebSocketAgentProvider } from '../../src/agent/hermes-ws-agent-provider.mjs';
import { FallbackAgentProvider } from '../../src/agent/fallback-agent-provider.mjs';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAgentProvider', () => {
  it('returns LocalAgentProvider by default', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: undefined,
      HERMES_WS_URL: undefined,
      AGENT_WS_FALLBACK: undefined,
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(LocalAgentProvider);
  });

  it('uses websocket transport when HERMES_WS_URL is set', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: undefined,
      HERMES_WS_URL: 'ws://127.0.0.1:3001',
      AGENT_WS_FALLBACK: undefined,
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(FallbackAgentProvider);
    expect(provider.primary).toBeInstanceOf(HermesWebSocketAgentProvider);
    expect(provider.fallback).toBeInstanceOf(LocalAgentProvider);
  });

  it('forces cli transport when AGENT_TRANSPORT=cli', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'cli',
      HERMES_WS_URL: 'ws://127.0.0.1:3001',
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(LocalAgentProvider);
  });

  it('uses websocket transport when AGENT_TRANSPORT=ws', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'ws',
      HERMES_WS_URL: 'ws://127.0.0.1:3001',
      AGENT_WS_FALLBACK: undefined,
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(FallbackAgentProvider);
    expect(provider.primary).toBeInstanceOf(HermesWebSocketAgentProvider);
  });

  it('can disable fallback with AGENT_WS_FALLBACK=none', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'ws',
      HERMES_WS_URL: 'ws://127.0.0.1:3001',
      AGENT_WS_FALLBACK: 'none',
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(HermesWebSocketAgentProvider);
  });
});

describe('FallbackAgentProvider', () => {
  it('falls back when primary generateComment fails', async () => {
    const primary = {
      generateComment: vi.fn().mockRejectedValue(new Error('agent websocket connect timeout after 50ms')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fallback = {
      generateComment: vi.fn().mockResolvedValue('挺真实'),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new FallbackAgentProvider(primary, fallback);

    await expect(provider.generateComment({ taskId: 'visit_1' })).resolves.toBe('挺真实');

    expect(primary.generateComment).toHaveBeenCalledTimes(1);
    expect(fallback.generateComment).toHaveBeenCalledTimes(1);
  });

  it('falls back when primary generateReplies fails', async () => {
    const primary = {
      generateReplies: vi.fn().mockRejectedValue(new Error('ws down')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fallback = {
      generateReplies: vi.fn().mockResolvedValue([{ taskId: 'work_comment_1', reply: 'Hermes代看后觉得这条反馈挺真诚自然' }]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new FallbackAgentProvider(primary, fallback);

    await expect(provider.generateReplies([{ taskId: 'work_comment_1' }])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: 'Hermes代看后觉得这条反馈挺真诚自然' },
    ]);

    expect(primary.generateReplies).toHaveBeenCalledTimes(1);
    expect(fallback.generateReplies).toHaveBeenCalledTimes(1);
  });
});
