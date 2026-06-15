import { describe, expect, it } from 'vitest';
import {
  NORMALIZED_STATUS,
  buildNormalizedStatusDistribution,
  isNormalizedRetryableStatus,
  isNormalizedTerminalStatus,
  normalizeInteractionEventStatus,
  normalizeReplyStatus,
  normalizeVisitTaskStatus,
} from '../../src/domain/status-model.mjs';

describe('status-model normalization', () => {
  it('normalizes reply statuses into unified buckets', () => {
    expect(normalizeReplyStatus('pending')).toBe(NORMALIZED_STATUS.PENDING);
    expect(normalizeReplyStatus('prepared')).toBe(NORMALIZED_STATUS.PENDING);
    expect(normalizeReplyStatus('succeeded')).toBe(NORMALIZED_STATUS.SUCCEEDED);
    expect(normalizeReplyStatus('manually_replied')).toBe(NORMALIZED_STATUS.SUCCEEDED);
    expect(normalizeReplyStatus('blocked')).toBe(NORMALIZED_STATUS.TERMINAL_FAILED);
    expect(normalizeReplyStatus('sent_unverified')).toBe(NORMALIZED_STATUS.UNCERTAIN);
    expect(normalizeReplyStatus('skipped')).toBe(NORMALIZED_STATUS.SKIPPED);
  });

  it('normalizes visit task statuses into unified buckets', () => {
    expect(normalizeVisitTaskStatus('pending_visit')).toBe(NORMALIZED_STATUS.PENDING);
    expect(normalizeVisitTaskStatus('collecting_content')).toBe(NORMALIZED_STATUS.RUNNING);
    expect(normalizeVisitTaskStatus('done')).toBe(NORMALIZED_STATUS.SUCCEEDED);
    expect(normalizeVisitTaskStatus('failed_collect')).toBe(NORMALIZED_STATUS.RETRYABLE_FAILED);
    expect(normalizeVisitTaskStatus('failed')).toBe(NORMALIZED_STATUS.TERMINAL_FAILED);
    expect(normalizeVisitTaskStatus('skipped_private')).toBe(NORMALIZED_STATUS.SKIPPED);
  });

  it('normalizes interaction event statuses into unified buckets', () => {
    expect(normalizeInteractionEventStatus('new')).toBe(NORMALIZED_STATUS.PENDING);
    expect(normalizeInteractionEventStatus('planned')).toBe(NORMALIZED_STATUS.PENDING);
    expect(normalizeInteractionEventStatus('running')).toBe(NORMALIZED_STATUS.RUNNING);
    expect(normalizeInteractionEventStatus('replied')).toBe(NORMALIZED_STATUS.SUCCEEDED);
    expect(normalizeInteractionEventStatus('blocked')).toBe(NORMALIZED_STATUS.TERMINAL_FAILED);
    expect(normalizeInteractionEventStatus('sent_unverified')).toBe(NORMALIZED_STATUS.UNCERTAIN);
  });

  it('treats unknown statuses as uncertain by default', () => {
    expect(normalizeReplyStatus('mystery')).toBe(NORMALIZED_STATUS.UNCERTAIN);
    expect(normalizeVisitTaskStatus('mystery')).toBe(NORMALIZED_STATUS.UNCERTAIN);
    expect(normalizeInteractionEventStatus('mystery')).toBe(NORMALIZED_STATUS.UNCERTAIN);
  });
});

describe('status-model helpers', () => {
  it('aggregates raw status rows into normalized distribution', () => {
    const distribution = buildNormalizedStatusDistribution([
      { status: 'pending_visit', count: 2 },
      { status: 'executing', count: 1 },
      { status: 'failed_collect', count: 3 },
      { status: 'done', count: 4 },
      { status: 'skipped_private', count: 5 },
    ], {
      normalize: normalizeVisitTaskStatus,
    });

    expect(distribution).toEqual({
      pending: 2,
      running: 1,
      succeeded: 4,
      retryable_failed: 3,
      terminal_failed: 0,
      skipped: 5,
      uncertain: 0,
    });
  });

  it('exposes terminal and retryable semantics', () => {
    expect(isNormalizedTerminalStatus(NORMALIZED_STATUS.SUCCEEDED)).toBe(true);
    expect(isNormalizedTerminalStatus(NORMALIZED_STATUS.TERMINAL_FAILED)).toBe(true);
    expect(isNormalizedTerminalStatus(NORMALIZED_STATUS.SKIPPED)).toBe(true);
    expect(isNormalizedTerminalStatus(NORMALIZED_STATUS.PENDING)).toBe(false);

    expect(isNormalizedRetryableStatus(NORMALIZED_STATUS.PENDING)).toBe(true);
    expect(isNormalizedRetryableStatus(NORMALIZED_STATUS.RUNNING)).toBe(true);
    expect(isNormalizedRetryableStatus(NORMALIZED_STATUS.RETRYABLE_FAILED)).toBe(true);
    expect(isNormalizedRetryableStatus(NORMALIZED_STATUS.UNCERTAIN)).toBe(true);
    expect(isNormalizedRetryableStatus(NORMALIZED_STATUS.SKIPPED)).toBe(false);
  });
});
