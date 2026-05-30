import { describe, it, expect } from 'vitest';
import { assessCandidateLikeState } from '../../src/adapters/video-page.mjs';

function makeDiag(overrides = {}) {
  return {
    tag: overrides.tag || 'span',
    text: overrides.text || '',
    ariaLabel: overrides.ariaLabel || '',
    title: overrides.title || '',
    className: overrides.className || '',
    dataE2e: overrides.dataE2e || '',
    color: overrides.color || '',
    backgroundColor: overrides.backgroundColor || '',
    svgFill: overrides.svgFill || '',
    pathFill: overrides.pathFill || '',
    rect: { x: 0, y: 0, w: 100, h: 40 },
    visible: true,
  };
}

// ============================================================
// 1. aria-label / data-e2e / class detection
// ============================================================
describe('assessCandidateLikeState — selector coverage', () => {
  it('aria-label with 赞 识别为 unlike button', () => {
    const d = makeDiag({ tag: 'div', ariaLabel: '点赞' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
    expect(r.signal).toBe('neutral-like-btn');
  });

  it('aria-label with 赞 and liked class → already liked', () => {
    const d = makeDiag({ tag: 'div', ariaLabel: '点赞', className: 'active' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
    expect(r.signal).toBe('liked-class:div');
  });

  it('data-e2e containing like → neutral (text not matched)', () => {
    // data-e2e alone without text/aria-label → assessCandidate returns null
    // (the isLikeRelated check in DOM already filtered, but this tests the pure function)
    const d = makeDiag({ tag: 'span', dataE2e: 'like-button' });
    const r = assessCandidateLikeState(d);
    // No text, no aria-label, no class → can't determine
    expect(r).toBeNull();
  });

  it('class containing like → neutral', () => {
    const d = makeDiag({ tag: 'span', className: 'like-btn', text: '赞' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
    expect(r.signal).toBe('neutral-like-btn');
  });
});

// ============================================================
// 2. Already liked (red / active class / red SVG)
// ============================================================
describe('assessCandidateLikeState — already liked', () => {
  it('active class → liked=true', () => {
    const d = makeDiag({ tag: 'button', text: '点赞', className: 'active' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
    expect(r.signal).toBe('liked-class:button');
    expect(r.confidence).toBe('confirmed');
  });

  it('liked class → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '赞', className: 'hasLiked' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });

  it('selected class → liked=true', () => {
    const d = makeDiag({ tag: 'div', text: '点赞', className: 'selected' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });

  it('red color (rgb(254, 44, 85)) → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '点赞', color: 'rgb(254, 44, 85)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
    expect(r.signal).toBe('red-color:span');
  });

  it('red color (rgb(255, 0, 64)) → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '赞', color: 'rgb(255, 0, 64)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });

  it('red backgroundColor → liked=true', () => {
    const d = makeDiag({ tag: 'button', text: '点赞', backgroundColor: 'rgb(254, 44, 85)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
    expect(r.signal).toBe('red-bg:button');
  });

  it('SVG fill #FF0040 → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '赞', svgFill: '#FF0040' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
    expect(r.signal).toBe('red-svg:span');
  });

  it('SVG fill #FE2C55 → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '赞', svgFill: '#FE2C55' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });

  it('path fill red → liked=true', () => {
    const d = makeDiag({ tag: 'span', text: '点赞', pathFill: 'red' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });

  it('class checked → liked=true', () => {
    const d = makeDiag({ tag: 'button', text: '赞', className: 'checked' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(true);
  });
});

// ============================================================
// 3. Not liked (clear unlike button)
// ============================================================
describe('assessCandidateLikeState — not liked', () => {
  it('赞 text with no red/liked indicators → not liked', () => {
    const d = makeDiag({ tag: 'span', text: '赞', color: 'rgb(100, 100, 100)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
    expect(r.signal).toBe('neutral-like-btn');
    expect(r.confidence).toBe('confirmed');
  });

  it('点赞 text with no red/liked indicators → not liked', () => {
    const d = makeDiag({ tag: 'span', text: '点赞', color: 'rgb(80, 80, 80)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
  });

  it('grey color (rgb(128,128,128)) on 赞 → not red → not liked', () => {
    const d = makeDiag({ tag: 'span', text: '赞', color: 'rgb(128, 128, 128)' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
  });

  it('SVG fill not red → still neutral', () => {
    const d = makeDiag({ tag: 'span', text: '赞', svgFill: '#000000' });
    const r = assessCandidateLikeState(d);
    expect(r.liked).toBe(false);
  });
});

// ============================================================
// 4. Can't determine (null → unknown)
// ============================================================
describe('assessCandidateLikeState — unknown', () => {
  it('empty diag → null', () => {
    const d = makeDiag({});
    const r = assessCandidateLikeState(d);
    expect(r).toBeNull();
  });

  it('non-like text → null', () => {
    const d = makeDiag({ tag: 'span', text: '分享', color: 'rgb(50,50,50)' });
    const r = assessCandidateLikeState(d);
    expect(r).toBeNull();
  });

  it('null diag → null', () => {
    expect(assessCandidateLikeState(null)).toBeNull();
  });

  it('class with like/digg but no text → null (caller must provide text or aria)', () => {
    const d = makeDiag({ tag: 'span', className: 'like-icon' });
    const r = assessCandidateLikeState(d);
    expect(r).toBeNull();
  });
});

// ============================================================
// 5. classifyLikeResult integration (discover-visits compatibility)
// ============================================================
describe('classifyLikeResult compatibility', () => {
  // simulate the high-level classifyLikeResult from discover-visits.mjs
  function classifyLikeResult(likeResult) {
    if (!likeResult || !likeResult.ok) {
      return { status: 'blocked', likeState: 'unknown', reason: 'LIKE_STATE_UNKNOWN', plannedActions: [] };
    }
    if (likeResult.data?.alreadyLiked) {
      return { status: 'skipped', likeState: 'already_liked', reason: 'already_liked_skip_comment', plannedActions: [] };
    }
    return { status: 'pending_review', likeState: 'not_liked', reason: null, plannedActions: ['like_work', 'comment_work'] };
  }

  it('already_liked from assessCandidateLikeState → skipped', () => {
    const d = makeDiag({ tag: 'button', text: '点赞', className: 'active' });
    const assess = assessCandidateLikeState(d);
    expect(assess.liked).toBe(true);

    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: assess.liked } });
    expect(result.status).toBe('skipped');
    expect(result.likeState).toBe('already_liked');
    expect(result.plannedActions).toEqual([]);
  });

  it('not_liked from assessCandidateLikeState → pending_review', () => {
    const d = makeDiag({ tag: 'span', text: '赞', color: 'rgb(100, 100, 100)' });
    const assess = assessCandidateLikeState(d);
    expect(assess.liked).toBe(false);

    const result = classifyLikeResult({ ok: true, data: { alreadyLiked: assess.liked } });
    expect(result.status).toBe('pending_review');
    expect(result.likeState).toBe('not_liked');
    expect(result.plannedActions).toEqual(['like_work', 'comment_work']);
  });

  it('null assess → blocked / LIKE_STATE_UNKNOWN', () => {
    const d = makeDiag({});
    const assess = assessCandidateLikeState(d);
    expect(assess).toBeNull();

    const result = classifyLikeResult({ ok: false, code: 'LIKE_STATE_UNKNOWN' });
    expect(result.status).toBe('blocked');
    expect(result.likeState).toBe('unknown');
    expect(result.reason).toBe('LIKE_STATE_UNKNOWN');
  });
});
