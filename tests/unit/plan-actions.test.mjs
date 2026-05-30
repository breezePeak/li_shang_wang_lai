import { describe, it, expect } from 'vitest';
import { generatePlan, stripUrlQuery, getMergeKey, resolveEffectiveRelation } from '../../src/cli/plan-actions.mjs';
import { parseRelationLine } from '../../src/adapters/notification-page.mjs';

function makeEvent(overrides = {}) {
  const { id, event_type, actor_name, actor_profile_key, actor_profile_url, relation, comment_text, target_work_id, target_work_url, dedup_confidence, ...rest } = overrides;
  return {
    id: id || 1,
    event_type: event_type || 'like',
    actor_name: actor_name || '测试用户',
    actor_profile_key: actor_profile_key || null,
    actor_profile_url: actor_profile_url || null,
    relation: relation || 'unknown',
    comment_text: comment_text || null,
    target_work_id: target_work_id || null,
    target_work_url: target_work_url || null,
    dedup_confidence: dedup_confidence || 'weak',
    status: 'new',
    ...rest,
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

describe('generatePlan — read-only guarantee', () => {
  it('consecutive runs produce same output without modifying event status', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
      makeEvent({ id: 2, event_type: 'comment', relation: 'unknown', actor_name: '路人' }),
    ];
    const beforeStatuses = events.map(e => e.status);
    generatePlan(events);
    generatePlan(events);
    generatePlan(events);
    const afterStatuses = events.map(e => e.status);
    expect(afterStatuses).toEqual(beforeStatuses);
  });

  it('consecutive runs return same candidate counts', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
      makeEvent({ id: 2, event_type: 'comment', relation: 'unknown', actor_name: '路人' }),
    ];
    const r1 = generatePlan(events);
    const r2 = generatePlan(events);
    expect(r2.visitWorkCandidates.length).toBe(r1.visitWorkCandidates.length);
    expect(r2.replyCommentCandidates.length).toBe(r1.replyCommentCandidates.length);
    expect(r2.skipped.length).toBe(r1.skipped.length);
  });
});

describe('generatePlan — output field invariants', () => {
  it('all visitWorkCandidates have executeAllowed=false', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
    ];
    const result = generatePlan(events);
    for (const v of result.visitWorkCandidates) {
      expect(v.executeAllowed).toBe(false);
    }
  });

  it('visitWorkCandidates only contain friend or mutual relations', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'like', relation: 'friend', actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1' }),
      makeEvent({ id: 2, event_type: 'like', relation: 'mutual', actor_profile_key: 'k2', actor_profile_url: 'https://www.douyin.com/user/k2' }),
      makeEvent({ id: 3, event_type: 'like', relation: 'unknown', actor_profile_key: 'k3', actor_profile_url: 'https://www.douyin.com/user/k3' }),
    ];
    const result = generatePlan(events);
    for (const v of result.visitWorkCandidates) {
      expect(['friend', 'mutual']).toContain(v.relation);
    }
    expect(result.visitWorkCandidates).toHaveLength(2);
  });
});

// ============================================================
// parseRelationLine — 在线识别为 friend
// ============================================================
describe('parseRelationLine', () => {
  it('line "在线" → friend', () => {
    expect(parseRelationLine('在线')).toBe('friend');
  });

  it('line "1小时前在线" → friend', () => {
    expect(parseRelationLine('1小时前在线')).toBe('friend');
  });

  it('line "27分钟前在线" → friend', () => {
    expect(parseRelationLine('27分钟前在线')).toBe('friend');
  });

  it('line "朋友" → friend', () => {
    expect(parseRelationLine('朋友')).toBe('friend');
  });

  it('line "互相关注" → mutual', () => {
    expect(parseRelationLine('互相关注')).toBe('mutual');
  });

  it('non-relation line "评论了你的作品" → null', () => {
    expect(parseRelationLine('评论了你的作品')).toBeNull();
  });

  it('line containing 在线 with extra text → still friend (caller filters by position)', () => {
    // parseRelationLine is only called on lines[1] (second line after username).
    // If a comment body "1小时前在线 xxx" appears on lines[2], it's never passed here.
    expect(parseRelationLine('1小时前在线 xxx')).toBe('friend');
  });

  it('empty/null → null', () => {
    expect(parseRelationLine('')).toBeNull();
    expect(parseRelationLine(null)).toBeNull();
  });
});

// ============================================================
// resolveEffectiveRelation — raw_payload_json 在线兜底
// ============================================================
describe('resolveEffectiveRelation — 在线兜底', () => {
  it('known relation (friend) stays unchanged', () => {
    const event = makeEvent({ relation: 'friend', raw_payload_json: null });
    expect(resolveEffectiveRelation(event)).toBe('friend');
  });

  it('known relation (mutual) stays unchanged', () => {
    const event = makeEvent({ relation: 'mutual' });
    expect(resolveEffectiveRelation(event)).toBe('mutual');
  });

  it('unknown + 在线 rawText → friend', () => {
    const event = {
      ...makeEvent({ relation: 'unknown' }),
      raw_payload_json: JSON.stringify({ rawText: '用户A\n1小时前在线\n赞了你的作品\n10:57' }),
    };
    expect(resolveEffectiveRelation(event)).toBe('friend');
  });

  it('unknown + 在线 rawText (plain 在线) → friend', () => {
    const event = {
      ...makeEvent({ relation: 'unknown' }),
      raw_payload_json: JSON.stringify({ rawText: '用户B\n在线\n赞了你的作品\n08:32' }),
    };
    expect(resolveEffectiveRelation(event)).toBe('friend');
  });

  it('unknown + 27分钟前在线 rawText → friend', () => {
    const event = {
      ...makeEvent({ relation: 'unknown' }),
      raw_payload_json: JSON.stringify({ rawText: '用户C\n27分钟前在线\n回复了你的评论' }),
    };
    expect(resolveEffectiveRelation(event)).toBe('friend');
  });

  it('unknown + 在线 in comment body (3rd line), not 2nd → stays unknown', () => {
    const event = {
      ...makeEvent({ relation: 'unknown' }),
      raw_payload_json: JSON.stringify({ rawText: '用户D\n评论了你的作品\n1小时前在线 来学习' }),
    };
    expect(resolveEffectiveRelation(event)).toBe('unknown');
  });

  it('unknown + no raw_payload_json → stays unknown', () => {
    const event = makeEvent({ relation: 'unknown', raw_payload_json: null });
    expect(resolveEffectiveRelation(event)).toBe('unknown');
  });

  it('unknown + malformed JSON → stays unknown', () => {
    const event = {
      ...makeEvent({ relation: 'unknown' }),
      raw_payload_json: '{broken',
    };
    expect(resolveEffectiveRelation(event)).toBe('unknown');
  });
});

// ============================================================
// generatePlan — 在线兜底让 unknown events 进入 visitWorkCandidates
// ============================================================
describe('generatePlan — 在线兜底进入 visitWorkCandidates', () => {
  it('unknown + online rawText + profile → enters visitWorkCandidates as friend', () => {
    const event = {
      ...makeEvent({
        id: 1, event_type: 'like', relation: 'unknown',
        actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1',
      }),
      raw_payload_json: JSON.stringify({ rawText: '用户X\n在线\n赞了你的作品\n10:57' }),
    };
    const result = generatePlan([event]);
    expect(result.visitWorkCandidates).toHaveLength(1);
    expect(result.visitWorkCandidates[0].relation).toBe('friend');
    expect(result.visitWorkCandidates[0].actorProfileKey).toBe('k1');
  });

  it('unknown + online rawText + no profile → skipped (no_actor_profile_url)', () => {
    const event = {
      ...makeEvent({
        id: 1, event_type: 'like', relation: 'unknown',
        actor_profile_key: null, actor_profile_url: null,
      }),
      raw_payload_json: JSON.stringify({ rawText: '用户Y\n在线\n赞了你的作品\n10:57' }),
    };
    const result = generatePlan([event]);
    expect(result.visitWorkCandidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('no_actor_profile_url');
  });

  it('unknown + 在线 in comment body (line 3) + profile → still skipped non_friend', () => {
    const event = {
      ...makeEvent({
        id: 1, event_type: 'like', relation: 'unknown',
        actor_profile_key: 'k1', actor_profile_url: 'https://www.douyin.com/user/k1',
      }),
      raw_payload_json: JSON.stringify({ rawText: '用户Z\n评论了你的作品\n1小时前在线 xxx' }),
    };
    const result = generatePlan([event]);
    expect(result.visitWorkCandidates).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('non_friend_non_mutual');
  });
});

// ============================================================
// generatePlan — URL normalization output
// ============================================================
describe('generatePlan — URL normalization', () => {
  it('dirty double-domain actor_profile_url → canonicalActorProfileUrl is clean', () => {
    const event = makeEvent({
      id: 1, event_type: 'like', relation: 'friend',
      actor_profile_key: 'k1',
      actor_profile_url: 'https://www.douyin.com//www.douyin.com/user/k1?enter_from=interact_cell',
      dedup_confidence: 'strong',
    });
    const result = generatePlan([event]);
    expect(result.visitWorkCandidates).toHaveLength(1);
    const v = result.visitWorkCandidates[0];
    expect(v.actorProfileUrl).toBe('https://www.douyin.com/user/k1');
    expect(v.canonicalActorProfileUrl).toBe('https://www.douyin.com/user/k1');
  });

  it('dirty target_work_url in replyCommentCandidates is normalized', () => {
    const event = makeEvent({
      id: 1, event_type: 'comment', relation: 'friend',
      actor_profile_key: null, actor_profile_url: null,
      target_work_url: 'https://www.douyin.com//www.douyin.com/video/12345?tab=like',
      comment_text: '好作品',
    });
    const result = generatePlan([event]);
    expect(result.replyCommentCandidates).toHaveLength(1);
    expect(result.replyCommentCandidates[0].targetWorkUrl).toBe('https://www.douyin.com/video/12345');
  });

  it('dirty actor_profile_url in replyCommentCandidates is normalized', () => {
    const event = makeEvent({
      id: 1, event_type: 'comment', relation: 'friend',
      actor_profile_url: 'https://www.douyin.com/https://www.douyin.com/user/k1',
      comment_text: '不错',
    });
    const result = generatePlan([event]);
    expect(result.replyCommentCandidates[0].actorProfileUrl).toBe('https://www.douyin.com/user/k1');
  });

  it('does not change interaction_events.status (read-only)', () => {
    const event = makeEvent({
      id: 1, event_type: 'like', relation: 'friend',
      actor_profile_key: 'k1',
      actor_profile_url: 'https://www.douyin.com//www.douyin.com/user/k1',
    });
    const beforeStatus = event.status;
    generatePlan([event]);
    expect(event.status).toBe(beforeStatus);
  });
});
