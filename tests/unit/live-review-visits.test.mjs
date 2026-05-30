import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  VISIT_DRAFTS,
  classifyLikeResult,
} from '../../src/cli/live-review-visits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 10_000) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: '/tmp/test_live_review_empty.db' },
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
// 2. VISIT_DRAFTS — exactly 3, structured with metadata
// ============================================================
describe('VISIT_DRAFTS', () => {
  it('has exactly 3 entries', () => {
    expect(VISIT_DRAFTS).toHaveLength(3);
  });

  it('each draft has required metadata fields', () => {
    for (const d of VISIT_DRAFTS) {
      expect(typeof d.text).toBe('string');
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.text.length).toBeLessThan(30);
      expect(d.text).not.toMatch(/[!！?？]+$/);
      expect(typeof d.commentCategory).toBe('string');
      expect(typeof d.replyMode).toBe('string');
      expect(typeof d.riskLevel).toBe('string');
      expect(typeof d.templateId).toBe('string');
    }
  });

  it('all drafts are low risk with auto_simple replyMode', () => {
    for (const d of VISIT_DRAFTS) {
      expect(d.riskLevel).toBe('low');
      expect(d.replyMode).toBe('auto_simple');
    }
  });

  it('contains known draft texts', () => {
    const texts = VISIT_DRAFTS.map(d => d.text);
    expect(texts).toContain('支持一下');
    expect(texts).toContain('内容不错，来看看');
    expect(texts).toContain('互相加油');
  });

  it('has correct commentCategory mapping', () => {
    const support = VISIT_DRAFTS.find(d => d.text === '支持一下');
    expect(support.commentCategory).toBe('support');
    expect(support.templateId).toBe('visit-support-1');

    const praise = VISIT_DRAFTS.find(d => d.text === '内容不错，来看看');
    expect(praise.commentCategory).toBe('praise');
    expect(praise.templateId).toBe('visit-praise-1');

    const encouragement = VISIT_DRAFTS.find(d => d.text === '互相加油');
    expect(encouragement.commentCategory).toBe('encouragement');
    expect(encouragement.templateId).toBe('visit-encouragement-1');
  });

  it('templateIds are unique', () => {
    const ids = VISIT_DRAFTS.map(d => d.templateId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ============================================================
// 3. classifyLikeResult — same gate as review/discover
// ============================================================
describe('classifyLikeResult (live-review-visits)', () => {
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

  it('confidence missing → blocked', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: false } });
    expect(r.status).toBe('blocked');
  });
});

// ============================================================
// 4. No DB write imports
// ============================================================
describe('live-review-visits.mjs — no DB writes', () => {
  it('does not import updateEventStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/updateEventStatus/);
  });

  it('does not import insertAction or updateActionStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/insertAction/);
    expect(src).not.toMatch(/updateActionStatus/);
  });

  it('does not import createPlan', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/createPlan/);
  });

  it('only imports getEvents from interaction-repository', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const importMatch = src.match(/import \{([^}]+)\} from ['"]\.\.\/db\/interaction-repository/);
    expect(importMatch).not.toBeNull();
    const imports = importMatch[1].split(',').map(s => s.trim());
    expect(imports).toEqual(['getEvents']);
  });
});

// ============================================================
// 5. CLI output structure (empty DB)
// ============================================================
describe('visits:live-review JSON output structure', () => {
  it('empty DB produces valid JSON with correct command and summary keys', () => {
    const result = runCli('live-review-visits.mjs', ['--json', '--max-items', '5'], 15_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('visits:live-review');
    expect(parsed.data).toHaveProperty('reviewCandidates');
    expect(parsed.summary).toMatchObject({
      totalCandidates: 0,
      processed: 0,
      pendingReview: 0,
      skipped: 0,
      blocked: 0,
      executed: 0,
      stopped: false,
    });
  });
});

// ============================================================
// 6. postVideoComment — code structure (no browser needed)
// ============================================================
describe('postVideoComment (from video-page.mjs)', () => {
  it('exports postVideoComment function', () => {
    const src = readFileSync(resolve(CLI_DIR, '../adapters/video-page.mjs'), 'utf8');
    expect(src).toMatch(/export async function postVideoComment/);
  });

  it('has execute guard that returns ACTION_NOT_APPROVED', () => {
    const src = readFileSync(resolve(CLI_DIR, '../adapters/video-page.mjs'), 'utf8');
    expect(src).toMatch(/ACTION_NOT_APPROVED[^]*非 execute 模式，拒绝真实评论操作/);
  });

  it('checks for empty reply text', () => {
    const src = readFileSync(resolve(CLI_DIR, '../adapters/video-page.mjs'), 'utf8');
    expect(src).toMatch(/EMPTY_REPLY_TEXT/);
  });

  it('uses COMMENT_INPUT_NOT_FOUND and COMMENT_SEND_BUTTON_NOT_FOUND codes', () => {
    const src = readFileSync(resolve(CLI_DIR, '../adapters/video-page.mjs'), 'utf8');
    expect(src).toMatch(/COMMENT_INPUT_NOT_FOUND/);
    expect(src).toMatch(/COMMENT_SEND_BUTTON_NOT_FOUND/);
  });
});

// ============================================================
// 7. Source code invariants — safety
// ============================================================
describe('live-review-visits.mjs — safety invariants', () => {
  it('does not call clickLike without execute guard (only via exported fn)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    // Should only import clickLike, not call it directly
    const callCount = (src.match(/clickLike\(/g) || []).length;
    const importMatches = src.match(/import.*clickLike/g);
    // clickLike is only called inside interactiveSelect, and only with { execute: true }
    expect(callCount).toBeGreaterThanOrEqual(1); // called in interactiveSelect
    // But it must pass execute: true
    expect(src).toMatch(/clickLike\(page,\s*\{ execute:\s*true \}\)/);
  });

  it('calls checkLikeState before acting in execute mode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    // interactiveSelect should re-check before clickLike
    const recheckIndex = src.indexOf('const recheck = await checkLikeState(page)');
    const clickLikeIndex = src.indexOf('clickLike(page, { execute: true })');
    expect(recheckIndex).toBeGreaterThan(-1);
    expect(clickLikeIndex).toBeGreaterThan(-1);
    expect(recheckIndex).toBeLessThan(clickLikeIndex);
  });

  it('does not enter comment management page', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/ensureCommentPageReady|comment-page|commentPage/);
  });

  it('does not re-open targetWorkUrl before execute', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    // navigateToVideo should only be called in processCandidate, not in interactiveSelect
    const navInInteractive = src.indexOf('interactiveSelect');
    const navCallsAfter = src.indexOf('navigateToVideo', navInInteractive);
    expect(navCallsAfter).toBe(-1);
  });

  it('has risk gate: blocks non-low risk or non-auto_simple drafts from execute', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/draft\.riskLevel !== ['"]low['"] \|\| draft\.replyMode !== ['"]auto_simple['"]/);
    expect(src).toMatch(/comment_risk_too_high/);
  });

  it('sets manualReviewMethod to user_selected_template on draft selection', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/manualReviewMethod.*user_selected_template/);
  });

  it('autoExecuteAllowed is always false in record initialization and selection', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const initMatch = src.match(/autoExecuteAllowed[:\s=]*false/g);
    expect(initMatch.length).toBeGreaterThanOrEqual(2);
  });

  it('each candidate requires individual input (no batch)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    // The interactive loop calls interactiveSelect per candidate
    expect(src).toMatch(/interactiveSelect\(page,\s*item,\s*isExecute\)/);
    // No "for all items at once" pattern
    const batchConfirm = src.match(/confirm.*all|approve.*all|batch/i);
    expect(batchConfirm).toBeNull();
  });
});

// ============================================================
// 8. --default maxItems
// ============================================================
describe('visits:live-review --max-items', () => {
  it('default maxItems is 10', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toContain("options.maxItems || 10");
  });
});

// ============================================================
// 9. interactiveSelect — verify terminal prompts exist
// ============================================================
describe('interactiveSelect — terminal prompts', () => {
  it('dry-run prompt does not mention execution', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/dry-run，不会执行真实点赞\/评论/);
  });

  it('execute prompt mentions immediate execution', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/选择后将立即执行当前条/);
  });

  it('prompt accepts s for skip and q for quit', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/输入 s 跳过，q 停止/);
  });
});
