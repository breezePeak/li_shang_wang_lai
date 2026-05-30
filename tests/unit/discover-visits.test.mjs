import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  createVisitDiscoveryBase,
  classifyLikeResult,
} from '../../src/cli/discover-visits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 10_000) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: '/tmp/test_discover_empty.db' },
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ============================================================
// 1. FRIENDLY_RELATIONS — only friend/mutual
// ============================================================
describe('FRIENDLY_RELATIONS', () => {
  it('contains friend and mutual', () => {
    expect(FRIENDLY_RELATIONS.has('friend')).toBe(true);
    expect(FRIENDLY_RELATIONS.has('mutual')).toBe(true);
  });

  it('does NOT contain unknown', () => {
    expect(FRIENDLY_RELATIONS.has('unknown')).toBe(false);
  });

  it('does NOT contain any other value', () => {
    expect(FRIENDLY_RELATIONS.has('')).toBe(false);
    expect(FRIENDLY_RELATIONS.has('non_friend')).toBe(false);
  });
});

// ============================================================
// 2. createVisitDiscoveryBase — base structure
// ============================================================
describe('createVisitDiscoveryBase', () => {
  it('sets executeAllowed=false and previewOnly=true', () => {
    const base = createVisitDiscoveryBase({ actorName: '张三' });
    expect(base.executeAllowed).toBe(false);
    expect(base.previewOnly).toBe(true);
  });

  it('defaults likeState to unknown and status to blocked', () => {
    const base = createVisitDiscoveryBase({ actorName: '张三' });
    expect(base.likeState).toBe('unknown');
    expect(base.status).toBe('blocked');
  });

  it('defaults plannedActions to empty array', () => {
    const base = createVisitDiscoveryBase({ actorName: '张三' });
    expect(base.plannedActions).toEqual([]);
  });

  it('has all required fields', () => {
    const base = createVisitDiscoveryBase({
      actorName: '张三',
      actorProfileKey: 'k1',
      actorProfileUrl: 'https://www.douyin.com/user/k1',
      relation: 'friend',
      sourceEventIds: [1, 2],
      sourceEventTypes: ['like', 'comment'],
    });
    expect(base.actorName).toBe('张三');
    expect(base.actorProfileKey).toBe('k1');
    expect(base.actorProfileUrl).toBe('https://www.douyin.com/user/k1');
    expect(base.relation).toBe('friend');
    expect(base.sourceEventIds).toEqual([1, 2]);
    expect(base.sourceEventTypes).toEqual(['like', 'comment']);
    expect(base.targetWorkUrl).toBe('');
    expect(base.targetWorkId).toBeNull();
    expect(base.targetWorkTitle).toBe('');
    expect(base.reason).toBeNull();
  });

  it('fills defaults for missing candidate fields', () => {
    const base = createVisitDiscoveryBase({});
    expect(base.actorName).toBe('unknown');
    expect(base.actorProfileKey).toBe('');
    expect(base.actorProfileUrl).toBe('');
    expect(base.relation).toBe('unknown');
    expect(base.sourceEventIds).toEqual([]);
    expect(base.sourceEventTypes).toEqual([]);
  });
});

// ============================================================
// 3. classifyLikeResult — 3 output states
// ============================================================
describe('classifyLikeResult', () => {
  it('already_liked → skipped, plannedActions=[]', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: true } });
    expect(result.status).toBe('skipped');
    expect(result.likeState).toBe('already_liked');
    expect(result.reason).toBe('already_liked_skip_comment');
    expect(result.plannedActions).toEqual([]);
  });

  it('not_liked → pending_review, plannedActions=["like_work","comment_work"]', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: false } });
    expect(result.status).toBe('pending_review');
    expect(result.likeState).toBe('not_liked');
    expect(result.reason).toBeNull();
    expect(result.plannedActions).toEqual(['like_work', 'comment_work']);
  });

  it('unknown (not ok) → blocked, likeState=unknown, reason=LIKE_STATE_UNKNOWN', () => {
    const result = classifyLikeResult({ ok: false, code: 'LIKE_STATE_UNKNOWN' });
    expect(result.status).toBe('blocked');
    expect(result.likeState).toBe('unknown');
    expect(result.reason).toBe('LIKE_STATE_UNKNOWN');
    expect(result.plannedActions).toEqual([]);
  });

  it('null / undefined → blocked', () => {
    expect(classifyLikeResult(null).status).toBe('blocked');
    expect(classifyLikeResult(null).likeState).toBe('unknown');
    expect(classifyLikeResult(undefined).status).toBe('blocked');
    expect(classifyLikeResult(undefined).reason).toBe('LIKE_STATE_UNKNOWN');
  });

  it('not_liked → executeAllowed is false (tested via createVisitDiscoveryBase + classify)', () => {
    const base = createVisitDiscoveryBase({ actorName: '测试' });
    const classification = classifyLikeResult({ ok: true, data: { alreadyLiked: false } });
    Object.assign(base, {
      likeState: classification.likeState,
      status: classification.status,
      plannedActions: classification.plannedActions,
      reason: classification.reason,
    });
    expect(base.status).toBe('pending_review');
    expect(base.executeAllowed).toBe(false);
    expect(base.previewOnly).toBe(true);
  });

  it('skipped → plannedActions does NOT include comment_work or like_work', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: true } });
    expect(result.plannedActions).not.toContain('comment_work');
    expect(result.plannedActions).not.toContain('like_work');
    expect(result.plannedActions).toEqual([]);
  });
});

// ============================================================
// 4. No updateEventStatus import in discover-visits.mjs
// ============================================================
describe('discover-visits.mjs — no updateEventStatus', () => {
  it('does not import updateEventStatus from interaction-repository', () => {
    const src = readFileSync(resolve(CLI_DIR, 'discover-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/updateEventStatus/);
  });

  it('does not import any DB write functions (insertAction, updateActionStatus)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'discover-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/insertAction/);
    expect(src).not.toMatch(/updateActionStatus/);
  });

  it('only imports getEvents from interaction-repository (read-only)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'discover-visits.mjs'), 'utf8');
    const importMatch = src.match(/import \{([^}]+)\} from ['"]\.\.\/db\/interaction-repository/);
    expect(importMatch).not.toBeNull();
    const imports = importMatch[1].split(',').map(s => s.trim());
    expect(imports).toEqual(['getEvents']);
  });
});

// ============================================================
// 5. discovered item structure invariants (populated from classify)
// ============================================================
describe('discovered item invariants', () => {
  it('pending_review item has executeAllowed=false and previewOnly=true', () => {
    const base = createVisitDiscoveryBase({ actorName: '测试' });
    const c = classifyLikeResult({ ok: true, data: { alreadyLiked: false } });
    Object.assign(base, {
      likeState: c.likeState,
      status: c.status,
      plannedActions: c.plannedActions,
      reason: c.reason,
    });
    expect(base.status).toBe('pending_review');
    expect(base.executeAllowed).toBe(false);
    expect(base.previewOnly).toBe(true);
  });

  it('skipped item has empty plannedActions', () => {
    const base = createVisitDiscoveryBase({ actorName: '测试' });
    const c = classifyLikeResult({ ok: true, data: { alreadyLiked: true } });
    Object.assign(base, {
      likeState: c.likeState,
      status: c.status,
      plannedActions: c.plannedActions,
      reason: c.reason,
    });
    expect(base.status).toBe('skipped');
    expect(base.plannedActions).toEqual([]);
    expect(base.executeAllowed).toBe(false);
  });

  it('blocked item has likeState=unknown and reason=LIKE_STATE_UNKNOWN', () => {
    const base = createVisitDiscoveryBase({ actorName: '测试' });
    const c = classifyLikeResult({ ok: false, code: 'LIKE_STATE_UNKNOWN' });
    Object.assign(base, {
      likeState: c.likeState,
      status: c.status,
      plannedActions: c.plannedActions,
      reason: c.reason,
    });
    expect(base.status).toBe('blocked');
    expect(base.likeState).toBe('unknown');
    expect(base.reason).toBe('LIKE_STATE_UNKNOWN');
  });
});

// ============================================================
// 6. Summary structure verification (via empty DB to avoid browser)
// ============================================================
describe('visits:discover JSON output structure', () => {
  it('empty DB produces valid JSON with correct summary keys', () => {
    const result = runCli('discover-visits.mjs', ['--json', '--max-items', '5'], 15_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('visits:discover');
    expect(parsed.data).toHaveProperty('visitDiscoveries');
    expect(parsed.summary).toMatchObject({
      totalCandidates: 0,
      processed: 0,
      pendingReview: 0,
      skipped: 0,
      blocked: 0,
    });
    expect(Object.keys(parsed.summary).sort()).toEqual([
      'blocked',
      'pendingReview',
      'processed',
      'skipped',
      'totalCandidates',
    ]);
  });
});

// ============================================================
// 7. --max-items logic verification (code structure)
// ============================================================
describe('visits:discover --max-items', () => {
  it('source code uses maxItems for slice', () => {
    const src = readFileSync(resolve(CLI_DIR, 'discover-visits.mjs'), 'utf8');
    expect(src).toContain('maxItems');
    expect(src).toContain('candidates.slice(0, maxItems)');
  });

  it('default maxItems is 10', () => {
    const src = readFileSync(resolve(CLI_DIR, 'discover-visits.mjs'), 'utf8');
    expect(src).toContain("options.maxItems || 10");
  });
});
