import { describe, it, expect } from 'vitest';
import { generatePlan, stripUrlQuery, getMergeKey } from '../../src/cli/plan-actions.mjs';

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 1,
    event_type: overrides.event_type || 'like',
    actor_name: overrides.actor_name || '测试用户',
    actor_profile_key: overrides.actor_profile_key || null,
    actor_profile_url: overrides.actor_profile_url || null,
    relation: overrides.relation || 'unknown',
    comment_text: overrides.comment_text || null,
    target_work_id: overrides.target_work_id || null,
    target_work_url: overrides.target_work_url || null,
    dedup_confidence: overrides.dedup_confidence || 'weak',
    status: 'new',
  };
}

describe('generatePlan — read-only preview', () => {
  it('does not modify interaction_events.status (no DB write)', () => {
    const event = makeEvent({ event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' });
    const beforeStatus = event.status;
    generatePlan([event]);
    expect(event.status).toBe(beforeStatus);
  });

  it('returns valid structure with all required keys', () => {
    const result = generatePlan([]);
    expect(result).toHaveProperty('replyCommentCandidates');
    expect(result).toHaveProperty('visitWorkCandidates');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.replyCommentCandidates)).toBe(true);
    expect(Array.isArray(result.visitWorkCandidates)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
  });

  it('comment event always generates replyCommentCandidate regardless of relation', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'comment', relation: 'friend', actor_profile_key: 'k1' }),
      makeEvent({ id: 2, event_type: 'comment', relation: 'unknown', actor_name: '路人甲' }),
    ];
    const result = generatePlan(events);
    expect(result.replyCommentCandidates).toHaveLength(2);
    expect(result.replyCommentCandidates[0].eventId).toBe(1);
    expect(result.replyCommentCandidates[1].eventId).toBe(2);
    expect(result.replyCommentCandidates[0].actionType).toBe('reply_comment_candidate');
    expect(result.replyCommentCandidates[1].actionType).toBe('reply_comment_candidate');
  });

  it('replyCommentCandidate includes all required fields', () => {
    const event = makeEvent({
      id: 42, event_type: 'comment', relation: 'friend',
      actor_name: '张三', actor_profile_key: 'k1',
      actor_profile_url: 'https://www.douyin.com/user/k1',
      comment_text: '好作品', dedup_confidence: 'medium',
      target_work_id: 'video-123', target_work_url: 'https://www.douyin.com/video/123',
    });
    const result = generatePlan([event]);
    const c = result.replyCommentCandidates[0];
    expect(c.eventId).toBe(42);
    expect(c.eventType).toBe('comment');
    expect(c.actorName).toBe('张三');
    expect(c.actorProfileUrl).toBe('https://www.douyin.com/user/k1');
    expect(c.actorProfileKey).toBe('k1');
    expect(c.relation).toBe('friend');
    expect(c.commentText).toBe('好作品');
    expect(c.targetWorkId).toBe('video-123');
    expect(c.targetWorkUrl).toBe('https://www.douyin.com/video/123');
    expect(c.dedupConfidence).toBe('medium');
    expect(c.replyMode).toBe('pending_review');
    expect(c.actionType).toBe('reply_comment_candidate');
    expect(c.requiresManualReview).toBe(false);
  });

  it('skippedNonFriend counts non-friend like events', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'unknown', actor_name: '路人甲' }),
      makeEvent({ id: 2, event_type: 'like', relation: 'friend', actor_profile_key: 'k2', actor_profile_url: 'https://www.douyin.com/user/k2' }),
    ];
    const result = generatePlan(events);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('non_friend_non_mutual');
    expect(result.summary.skippedNonFriend).toBe(1);
  });
});

describe('generatePlan — visit work merge logic', () => {
  it('same actorProfileKey for comment + like merges into one visitWorkCandidate', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'comment', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
      makeEvent({ id: 2, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates).toHaveLength(1);
    const v = result.visitWorkCandidates[0];
    expect(v.sourceEventIds).toEqual([1, 2]);
    expect(v.sourceEventTypes).toEqual(['comment', 'like']);
    expect(v.sourceRelations).toEqual(['friend', 'friend']);
    expect(v.actorProfileKey).toBe('k1');
  });

  it('profile URLs with different query params merge into one candidate', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: null, actor_profile_url: 'https://www.douyin.com/user/k1?from=panel' }),
      makeEvent({ id: 2, event_type: 'like', relation: 'friend', actor_profile_key: null, actor_profile_url: 'https://www.douyin.com/user/k1?from=profile' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates).toHaveLength(1);
    expect(result.visitWorkCandidates[0].canonicalActorProfileUrl).toBe('https://www.douyin.com/user/k1');
  });

  it('non-friend like does not generate visitWorkCandidate', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'unknown', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('non_friend_non_mutual');
  });

  it('weak dedup confidence sets requiresManualReview=true', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1', dedup_confidence: 'weak' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates[0].requiresManualReview).toBe(true);
    expect(result.visitWorkCandidates[0].dedupConfidenceSummary).toBe('weak');
  });

  it('medium dedup confidence sets requiresManualReview=false', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1', dedup_confidence: 'medium' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates[0].requiresManualReview).toBe(false);
    expect(result.visitWorkCandidates[0].dedupConfidenceSummary).toBe('medium');
  });

  it('visitWorkCandidate includes executeAllowed=false', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates[0].executeAllowed).toBe(false);
  });

  it('visitWorkCandidate includes sourceRelations and sourceDedupConfidences arrays', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'comment', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1', dedup_confidence: 'weak' }),
      makeEvent({ id: 2, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1', dedup_confidence: 'medium' }),
    ];
    const result = generatePlan(events);
    const v = result.visitWorkCandidates[0];
    expect(v.sourceRelations).toEqual(['friend', 'friend']);
    expect(v.sourceDedupConfidences).toEqual(['weak', 'medium']);
    expect(v.dedupConfidenceSummary).toBe('medium');
  });
});

describe('generatePlan — skip reasons', () => {
  it('friend without actor_profile_url skipped as no_actor_profile_url', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: null, actor_profile_url: null }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('no_actor_profile_url');
  });

  it('friend without profile key or URL skips as no_actor_profile_url', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: null, actor_profile_url: null }),
    ];
    const result = generatePlan(events);
    // no_actor_profile_url takes priority since there's no URL at all
    expect(result.skipped[0].reason).toBe('no_actor_profile_url');
  });

  it('mutual relation also generates visitWorkCandidate', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'mutual', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
    ];
    const result = generatePlan(events);
    expect(result.visitWorkCandidates).toHaveLength(1);
    expect(result.visitWorkCandidates[0].relation).toBe('mutual');
  });
});

describe('stripUrlQuery', () => {
  it('strips query params', () => {
    expect(stripUrlQuery('https://www.douyin.com/user/abc?from=panel&tab=main')).toBe('https://www.douyin.com/user/abc');
  });

  it('strips hash', () => {
    expect(stripUrlQuery('https://www.douyin.com/user/abc#section')).toBe('https://www.douyin.com/user/abc');
  });

  it('strips both query and hash', () => {
    expect(stripUrlQuery('https://www.douyin.com/user/abc?from=panel#section')).toBe('https://www.douyin.com/user/abc');
  });

  it('returns empty for null/empty', () => {
    expect(stripUrlQuery(null)).toBe('');
    expect(stripUrlQuery('')).toBe('');
  });

  it('passes through clean URL', () => {
    expect(stripUrlQuery('https://www.douyin.com/user/abc')).toBe('https://www.douyin.com/user/abc');
  });
});

describe('getMergeKey', () => {
  it('prefers actor_profile_key over URL', () => {
    const event = makeEvent({ actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' });
    expect(getMergeKey(event)).toBe('k1');
  });

  it('falls back to canonical URL when no key', () => {
    const event = makeEvent({ actor_profile_key: null, actor_profile_url: 'https://www.douyin.com/user/k1?from=panel' });
    expect(getMergeKey(event)).toBe('https://www.douyin.com/user/k1');
  });

  it('falls back to actor_name when no key and no URL', () => {
    const event = makeEvent({ actor_profile_key: null, actor_profile_url: null, actor_name: '测试用户' });
    expect(getMergeKey(event)).toBe('测试用户');
  });
});
