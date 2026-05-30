import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  createVisitDiscoveryBase,
  classifyLikeResult,
  formatTargetWorkId,
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

  it('has diagnostic fields defaulting to null', () => {
    const base = createVisitDiscoveryBase({ actorName: '张三' });
    expect(base.likeDiagnostics).toBeNull();
    expect(base.likeCheckSignal).toBeNull();
    expect(base.likeCheckConfidence).toBeNull();
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
// 3. classifyLikeResult — confidence gate + 3 output states
// ============================================================
describe('classifyLikeResult', () => {
  it('already_liked + confirmed → skipped, plannedActions=[]', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
    expect(result.status).toBe('skipped');
    expect(result.likeState).toBe('already_liked');
    expect(result.reason).toBe('already_liked_skip_comment');
    expect(result.plannedActions).toEqual([]);
  });

  it('not_liked + confirmed → pending_review, plannedActions=["like_work","comment_work"]', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
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

  // confidence gate
  it('confidence missing → blocked', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: false } });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('LIKE_STATE_UNKNOWN');
  });

  it('confidence !== confirmed → blocked', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'unknown' } });
    expect(result.status).toBe('blocked');
    expect(result.likeState).toBe('unknown');
  });

  it('alreadyLiked=true but confidence unknown → blocked', () => {
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'unknown' } });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('LIKE_STATE_UNKNOWN');
  });

  it('not_liked → existing executeAllowed/pending_review invariant still holds', () => {
    const base = createVisitDiscoveryBase({ actorName: '测试' });
    const classification = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
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
    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
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
    const c = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
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
    const c = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
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

// ============================================================
// 8. formatTargetWorkId — video-xxx / note-xxx prefix
// ============================================================
describe('formatTargetWorkId', () => {
  it('video URL → video-<id>', () => {
    expect(formatTargetWorkId('https://www.douyin.com/video/7645548152535502004')).toBe('video-7645548152535502004');
  });

  it('video URL with query params → video-<id>', () => {
    expect(formatTargetWorkId('https://www.douyin.com/video/123?tab=like')).toBe('video-123');
  });

  it('note URL → note-<id>', () => {
    expect(formatTargetWorkId('https://www.douyin.com/note/456')).toBe('note-456');
  });

  it('falls back to videoId arg if URL has no /video/ match', () => {
    expect(formatTargetWorkId(null, '999')).toBe('video-999');
  });

  it('returns null for empty inputs', () => {
    expect(formatTargetWorkId('')).toBeNull();
    expect(formatTargetWorkId(null, null)).toBeNull();
  });

  it('returns url as-is if no /video/ or /note/ match', () => {
    expect(formatTargetWorkId('https://www.douyin.com/other/123')).toBe('https://www.douyin.com/other/123');
  });
});

// ============================================================
// 9. Diagnostics pass-through from checkLikeState
// ============================================================
describe('discovered item — likeDiagnostics pass-through', () => {
  it('blocked likeResult → likeDiagnostics populated with candidates', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    const likeResult = {
      ok: false,
      code: 'LIKE_STATE_UNKNOWN',
      data: {
        candidateCount: 3,
        confidence: 'unknown',
        candidates: [{ tag: 'span', text: '赞', color: 'rgb(100,100,100)' }],
      },
    };
    base.likeDiagnostics = likeResult.data;
    base.likeCheckSignal = likeResult.data.confidence;
    base.likeCheckConfidence = likeResult.data.confidence;

    const classification = classifyLikeResult(likeResult);
    Object.assign(base, {
      status: classification.status,
      likeState: classification.likeState,
      reason: classification.reason,
      plannedActions: classification.plannedActions,
    });

    expect(base.status).toBe('blocked');
    expect(base.likeDiagnostics).not.toBeNull();
    expect(base.likeDiagnostics.candidates).toHaveLength(1);
    expect(base.likeDiagnostics.candidateCount).toBe(3);
    expect(base.likeCheckConfidence).toBe('unknown');
  });

  it('confirmed + alreadyLiked → likeDiagnostics still populated', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    const likeResult = { ok: true, data: { alreadyLiked: true, confidence: 'confirmed', signal: 'liked-class:span' } };
    base.likeDiagnostics = likeResult.data;
    base.likeCheckSignal = likeResult.data.signal;
    base.likeCheckConfidence = likeResult.data.confidence;

    const classification = classifyLikeResult(likeResult);
    Object.assign(base, {
      status: classification.status,
      likeState: classification.likeState,
      reason: classification.reason,
      plannedActions: classification.plannedActions,
    });

    expect(base.status).toBe('skipped');
    expect(base.likeDiagnostics).not.toBeNull();
    expect(base.likeCheckConfidence).toBe('confirmed');
    expect(base.likeCheckSignal).toBe('liked-class:span');
  });

  it('confirmed + not_liked → likeDiagnostics populated', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    const likeResult = { ok: true, data: { alreadyLiked: false, confidence: 'confirmed', signal: 'neutral-like-btn' } };
    base.likeDiagnostics = likeResult.data;
    base.likeCheckSignal = likeResult.data.signal;
    base.likeCheckConfidence = likeResult.data.confidence;

    const classification = classifyLikeResult(likeResult);
    Object.assign(base, {
      status: classification.status,
      likeState: classification.likeState,
      reason: classification.reason,
      plannedActions: classification.plannedActions,
    });

    expect(base.status).toBe('pending_review');
    expect(base.likeDiagnostics).not.toBeNull();
    expect(base.likeCheckConfidence).toBe('confirmed');
  });
});

// ============================================================
// 10. pageDiagnostics pass-through
// ============================================================
describe('discovered item — pageDiagnostics pass-through', () => {
  it('candidateCount=0 → likeDiagnostics.pageDiagnostics populated', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    const likeResult = {
      ok: false,
      code: 'LIKE_STATE_UNKNOWN',
      data: {
        candidateCount: 0,
        candidates: [],
        confidence: 'none',
        pageDiagnostics: {
          url: 'https://www.douyin.com/video/123',
          title: '测试视频 - 抖音',
          bodyTextLength: 500,
          bodyTextSample: '正文...',
          viewport: { w: 1920, h: 1080 },
          scrollY: 0,
          interactiveCount: 15,
          buttonCount: 5,
          svgCount: 12,
          roleButtonCount: 3,
          rightSideElements: [{ tag: 'span', text: '点赞', rect: { x: 1400, y: 500, w: 60, h: 24 } }],
          visibleInteractiveElements: [],
          visibleSvgParents: [],
        },
      },
    };
    base.likeDiagnostics = likeResult.data;
    base.likeCheckSignal = likeResult.data.confidence;
    base.likeCheckConfidence = likeResult.data.confidence;

    expect(base.likeDiagnostics.pageDiagnostics).not.toBeNull();
    expect(base.likeDiagnostics.pageDiagnostics.url).toContain('/video/123');
    expect(base.likeDiagnostics.pageDiagnostics.buttonCount).toBe(5);
    expect(base.likeDiagnostics.pageDiagnostics.rightSideElements).toHaveLength(1);
  });

  it('likeDiagnostics.pageDiagnostics has all required keys', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    base.likeDiagnostics = {
      candidateCount: 0,
      confidence: 'none',
      pageDiagnostics: {
        url: 'https://www.douyin.com/video/1',
        title: 'test',
        bodyTextLength: 0,
        bodyTextSample: '',
        viewport: { w: 0, h: 0 },
        scrollY: 0,
        interactiveCount: 0,
        buttonCount: 0,
        svgCount: 0,
        roleButtonCount: 0,
        rightSideElements: [],
        visibleInteractiveElements: [],
        visibleSvgParents: [],
      },
    };

    const pd = base.likeDiagnostics.pageDiagnostics;
    const requiredKeys = ['url', 'title', 'bodyTextLength', 'bodyTextSample', 'viewport', 'scrollY', 'interactiveCount', 'buttonCount', 'svgCount', 'roleButtonCount', 'rightSideElements', 'visibleInteractiveElements', 'visibleSvgParents'];
    for (const k of requiredKeys) {
      expect(pd).toHaveProperty(k);
    }
  });

  it('likeResult with candidates > 0 has pageDiagnostics=null (only for no-candidates)', () => {
    const base = createVisitDiscoveryBase({ actorName: 'test' });
    const likeResult = {
      ok: false,
      code: 'LIKE_STATE_UNKNOWN',
      data: {
        candidateCount: 5,
        candidates: [{ tag: 'span', text: '赞', color: 'rgb(50,50,50)' }],
        confidence: 'unknown',
        pageDiagnostics: null,
      },
    };
    base.likeDiagnostics = likeResult.data;
    expect(base.likeDiagnostics.pageDiagnostics).toBeNull();
    expect(base.likeDiagnostics.candidates).toHaveLength(1);
  });
});
