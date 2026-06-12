import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentProvider } from '../../src/agent/agent-provider-factory.mjs';
import { LocalAgentProvider } from '../../src/agent/local-agent-provider.mjs';
import { FallbackAgentProvider } from '../../src/agent/fallback-agent-provider.mjs';
import { HermesApiAgentProvider } from '../../src/agent/hermes-api-agent-provider.mjs';

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
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(LocalAgentProvider);
  });

  it('forces cli transport when AGENT_TRANSPORT=cli', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'cli',
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(LocalAgentProvider);
  });

  it('uses api transport when AGENT_TRANSPORT=api', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'api',
      AGENT_API_FALLBACK: undefined,
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(FallbackAgentProvider);
    expect(provider.primary).toBeInstanceOf(HermesApiAgentProvider);
    expect(provider.fallback).toBeInstanceOf(LocalAgentProvider);
  });

  it('can disable api fallback with AGENT_API_FALLBACK=none', () => {
    const provider = withEnv({
      AGENT_TRANSPORT: 'api',
      AGENT_API_FALLBACK: 'none',
    }, () => createAgentProvider());

    expect(provider).toBeInstanceOf(HermesApiAgentProvider);
  });
});

describe('FallbackAgentProvider', () => {
  it('falls back when primary generateComment fails', async () => {
    const primary = {
      generateComment: vi.fn().mockRejectedValue(new Error('primary failed')),
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
      generateReplies: vi.fn().mockRejectedValue(new Error('primary down')),
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

  it('api transport falls back to cli when primary fails', async () => {
    const primary = {
      generateReplies: vi.fn().mockRejectedValue(new Error('Hermes API request failed with status 500: boom')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fallback = {
      generateReplies: vi.fn().mockResolvedValue([{ taskId: 'work_comment_1', reply: 'Hermes代看后觉得这条反馈挺真诚自然' }]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const provider = new FallbackAgentProvider(primary, fallback, { name: 'api' });

    await expect(provider.generateReplies([{ taskId: 'work_comment_1' }])).resolves.toEqual([
      { taskId: 'work_comment_1', reply: 'Hermes代看后觉得这条反馈挺真诚自然' },
    ]);

    expect(primary.generateReplies).toHaveBeenCalledTimes(1);
    expect(fallback.generateReplies).toHaveBeenCalledTimes(1);
  });
});
