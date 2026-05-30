import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  VISIT_DRAFTS,
  buildReviewRecord,
  classifyLikeResult,
  formatTargetWorkId,
} from '../../src/cli/review-visits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 10_000) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: '/tmp/test_review_empty.db' },
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ============================================================
// 1. FRIENDLY_RELATIONS
// ============================================================
describe('FRIENDLY_RELATIONS', () => {
  it('contains friend and mutual', () => {
    expect(FRIENDLY_RELATIONS.has('friend')).toBe(true);
    expect(FRIENDLY_RELATIONS.has('mutual')).toBe(true);
  });

  it('does NOT contain unknown', () => {
    expect(FRIENDLY_RELATIONS.has('unknown')).toBe(false);
  });
});

// ============================================================
// 2. VISIT_DRAFTS — fixed template pool
// ============================================================
describe('VISIT_DRAFTS', () => {
  it('has exactly 3 entries', () => {
    expect(VISIT_DRAFTS).toHaveLength(3);
  });

  it('drafts are natural and non-marketing', () => {
    for (const d of VISIT_DRAFTS) {
      expect(d).toHaveProperty('text');
      expect(typeof d.text).toBe('string');
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.text).not.toMatch(/[!！?？]+$/);
      expect(d.text.length).toBeLessThan(30);
    }
  });

  it('contains known draft texts', () => {
    const texts = VISIT_DRAFTS.map(d => d.text);
    expect(texts).toContain('支持一下');
    expect(texts).toContain('内容不错，来看看');
    expect(texts).toContain('互相加油');
  });

  it('all drafts have metadata fields', () => {
    for (const d of VISIT_DRAFTS) {
      expect(d).toHaveProperty('commentCategory');
      expect(d).toHaveProperty('replyMode');
      expect(d).toHaveProperty('riskLevel');
      expect(d).toHaveProperty('templateId');
      expect(d.replyMode).toBe('auto_simple');
      expect(d.riskLevel).toBe('low');
    }
  });
});

// ============================================================
// 3. buildReviewRecord — reviewCandidates structure
// ============================================================
describe('buildReviewRecord', () => {
  const mockDiscovery = {
    actorName: '张三',
    actorProfileUrl: 'https://www.douyin.com/user/abc',
    relation: 'friend',
    sourceEventIds: [1, 2],
    sourceEventTypes: ['like', 'comment'],
    targetWorkUrl: 'https://www.douyin.com/video/123',
    targetWorkId: 'video-123',
    targetWorkTitle: '测试视频标题',
    likeState: 'not_liked',
    plannedActions: ['like_work', 'comment_work'],
  };

  it('produces correct structure with all fields', () => {
    const r = buildReviewRecord(mockDiscovery);
    expect(r.actorName).toBe('张三');
    expect(r.actorProfileUrl).toBe('https://www.douyin.com/user/abc');
    expect(r.relation).toBe('friend');
    expect(r.sourceEventIds).toEqual([1, 2]);
    expect(r.sourceEventTypes).toEqual(['like', 'comment']);
    expect(r.targetWorkUrl).toBe('https://www.douyin.com/video/123');
    expect(r.targetWorkId).toBe('video-123');
    expect(r.targetWorkTitle).toBe('测试视频标题');
    expect(r.likeState).toBe('not_liked');
    expect(r.suggestedActions).toEqual(['like_work', 'comment_work']);
  });

  it('includes commentDrafts from VISIT_DRAFTS', () => {
    const r = buildReviewRecord(mockDiscovery);
    expect(r.commentDrafts).toEqual(VISIT_DRAFTS);
  });

  it('selectedCommentDraft is always null (no auto-select)', () => {
    const r = buildReviewRecord(mockDiscovery);
    expect(r.selectedCommentDraft).toBeNull();
  });

  it('requiresManualReview is true, executeAllowed false, previewOnly true', () => {
    const r = buildReviewRecord(mockDiscovery);
    expect(r.requiresManualReview).toBe(true);
    expect(r.executeAllowed).toBe(false);
    expect(r.previewOnly).toBe(true);
  });

  it('handles discovery with missing fields gracefully', () => {
    const r = buildReviewRecord({});
    expect(r.actorName).toBeUndefined();
    expect(r.sourceEventIds).toBeUndefined();
    expect(r.suggestedActions).toBeUndefined();
    // invariant fields still hold
    expect(r.commentDrafts).toEqual(VISIT_DRAFTS);
    expect(r.selectedCommentDraft).toBeNull();
    expect(r.requiresManualReview).toBe(true);
    expect(r.executeAllowed).toBe(false);
    expect(r.previewOnly).toBe(true);
  });
});

// ============================================================
// 4. classifyLikeResult — same gate as discover-visits
// ============================================================
describe('classifyLikeResult (review-visits)', () => {
  it('already_liked + confirmed → skipped', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
    expect(r.status).toBe('skipped');
    expect(r.likeState).toBe('already_liked');
    expect(r.plannedActions).toEqual([]);
  });

  it('not_liked + confirmed → pending_review', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
    expect(r.status).toBe('pending_review');
    expect(r.likeState).toBe('not_liked');
    expect(r.plannedActions).toEqual(['like_work', 'comment_work']);
  });

  it('null → blocked / LIKE_STATE_UNKNOWN', () => {
    const r = classifyLikeResult(null);
    expect(r.status).toBe('blocked');
    expect(r.reason).toBe('LIKE_STATE_UNKNOWN');
  });
});

// ============================================================
// 5. No DB write imports in review-visits.mjs
// ============================================================
describe('review-visits.mjs — no DB writes', () => {
  it('does not import updateEventStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/updateEventStatus/);
  });

  it('does not import insertAction or updateActionStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/insertAction/);
    expect(src).not.toMatch(/updateActionStatus/);
  });

  it('does not import createPlan from plan-repository', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/createPlan/);
  });

  it('only imports getEvents from interaction-repository', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    const importMatch = src.match(/import \{([^}]+)\} from ['"]\.\.\/db\/interaction-repository/);
    expect(importMatch).not.toBeNull();
    const imports = importMatch[1].split(',').map(s => s.trim());
    expect(imports).toEqual(['getEvents']);
  });

  it('has no mutation operations (clickLike, page.type, page.click)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/clickLike|\.type\(|\.click\(/);
  });
});

// ============================================================
// 6. CLI output structure (empty DB — no browser needed)
// ============================================================
describe('visits:review JSON output structure', () => {
  it('empty DB produces valid JSON with correct command and summary keys', () => {
    const result = runCli('review-visits.mjs', ['--json', '--max-items', '5'], 15_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('visits:review');
    expect(parsed.data).toHaveProperty('reviewCandidates');
    expect(parsed.data.reviewCandidates).toEqual([]);
    expect(parsed.summary).toMatchObject({
      totalCandidates: 0,
      processed: 0,
      pendingReview: 0,
      skipped: 0,
      blocked: 0,
    });
  });
});

// ============================================================
// 7. --max-items default
// ============================================================
describe('visits:review --max-items', () => {
  it('default maxItems is 10', () => {
    const src = readFileSync(resolve(CLI_DIR, 'review-visits.mjs'), 'utf8');
    expect(src).toContain("options.maxItems || 10");
  });
});

// ============================================================
// 8. buildReviewRecord ↔ classifyLikeResult integration
// ============================================================
describe('review candidate — buildReviewRecord + classifyLikeResult integration', () => {
  it('pending_review candidate preserves executeAllowed=false, previewOnly=true', () => {
    const c = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
    const discovery = {
      actorName: '测试',
      actorProfileUrl: 'https://www.douyin.com/user/u1',
      relation: 'mutual',
      sourceEventIds: [1],
      sourceEventTypes: ['like'],
      targetWorkUrl: 'https://www.douyin.com/video/999',
      targetWorkId: 'video-999',
      targetWorkTitle: '测试作品',
      likeState: c.likeState,
      plannedActions: c.plannedActions,
    };
    const review = buildReviewRecord(discovery);
    expect(review.likeState).toBe('not_liked');
    expect(review.suggestedActions).toEqual(['like_work', 'comment_work']);
    expect(review.executeAllowed).toBe(false);
    expect(review.previewOnly).toBe(true);
    expect(review.selectedCommentDraft).toBeNull();
  });
});
