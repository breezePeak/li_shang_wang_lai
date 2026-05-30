import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  classifyLikeResult,
} from '../../src/cli/live-review-visits.mjs';
import {
  validateSelectedComment,
  isExecuteAllowed,
  FORBIDDEN_WORDS,
} from '../../src/domain/comment-policy.mjs';
import {
  generateVisitCommentCandidates,
} from '../../src/domain/visit-comment-generator.mjs';

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
});

// ============================================================
// 2. classifyLikeResult
// ============================================================
describe('classifyLikeResult', () => {
  it('already_liked → skipped', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
    expect(r.status).toBe('skipped');
  });

  it('not_liked → pending_review', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
    expect(r.status).toBe('pending_review');
  });

  it('null → blocked', () => {
    expect(classifyLikeResult(null).status).toBe('blocked');
  });
});

// ============================================================
// 3. validateSelectedComment
// ============================================================
describe('validateSelectedComment', () => {
  it('low + auto_simple + user_selected_template → valid', () => {
    const r = validateSelectedComment({
      text: '支持一下',
      replyMode: 'auto_simple',
      riskLevel: 'low',
      manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('medium + agent_generated + user_selected_agent_comment → valid', () => {
    const r = validateSelectedComment({
      text: 'React做得不错',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(true);
  });

  it('high → invalid', () => {
    const r = validateSelectedComment({
      text: 'test',
      replyMode: 'auto_simple',
      riskLevel: 'high',
      manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('high'))).toBe(true);
  });

  it('ignore → invalid', () => {
    const r = validateSelectedComment({
      text: 'test',
      replyMode: 'ignore',
      riskLevel: 'medium',
      manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
  });

  it('empty text → invalid', () => {
    const r = validateSelectedComment({
      text: '',
      replyMode: 'auto_simple',
      riskLevel: 'low',
      manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
  });

  it('no manualReviewMethod → invalid', () => {
    const r = validateSelectedComment({
      text: 'test',
      replyMode: 'auto_simple',
      riskLevel: 'low',
      manualReviewMethod: null,
    });
    expect(r.valid).toBe(false);
  });

  it('forbidden words → invalid', () => {
    const r = validateSelectedComment({
      text: '互关注我',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('forbidden'))).toBe(true);
  });

  it('too long → invalid', () => {
    const r = validateSelectedComment({
      text: '这'.repeat(41),
      replyMode: 'auto_simple',
      riskLevel: 'low',
      manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('too long'))).toBe(true);
  });

  it('wrong combination → invalid', () => {
    const r = validateSelectedComment({
      text: 'test',
      replyMode: 'auto_simple',
      riskLevel: 'medium',
      manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
  });
});

// ============================================================
// 4. isExecuteAllowed (from comment-policy)
// ============================================================
describe('isExecuteAllowed (comment-policy)', () => {
  it('valid combination → allowed', () => {
    const c = { riskLevel: 'medium', replyMode: 'agent_generated_review_required' };
    const r = { selectedCommentText: 'test', manualReviewMethod: 'user_selected_agent_comment' };
    expect(isExecuteAllowed(c, r)).toBe(true);
  });

  it('no selectedCommentText → blocked', () => {
    const c = { riskLevel: 'low', replyMode: 'auto_simple' };
    const r = { selectedCommentText: null, manualReviewMethod: 'user_selected_template' };
    expect(isExecuteAllowed(c, r)).toBe(false);
  });

  it('null → blocked', () => {
    expect(isExecuteAllowed(null, null)).toBe(false);
  });
});

// ============================================================
// 5. generateVisitCommentCandidates
// ============================================================
describe('generateVisitCommentCandidates', () => {
  it('contextual → usedFallback=false', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'React',
      captionText: '',
      hashtags: ['React'],
      authorName: '',
      canGenerateContextualComment: true,
    });
    expect(result.usedFallback).toBe(false);
    expect(result.generatedCommentCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it('no context → usedFallback=true', () => {
    const result = generateVisitCommentCandidates(null);
    expect(result.usedFallback).toBe(true);
    expect(result.generatedCommentCandidates).toHaveLength(3);
  });
});

// ============================================================
// 6. Source code invariants
// ============================================================
describe('live-review-visits.mjs — invariants', () => {
  it('imports validateSelectedComment and isExecuteAllowed from comment-policy', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/validateSelectedComment/);
    expect(src).toMatch(/isExecuteAllowed/);
    expect(src).toMatch(/comment-policy/);
  });

  it('imports generateAgentCommentCandidates', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/generateAgentCommentCandidates/);
    expect(src).toMatch(/llm-comment-generator/);
  });

  it('supports --comment-mode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/commentMode/);
    expect(src).toMatch(/VALID_COMMENT_MODES/);
  });

  it('skill mode outputs needsAgentComment + constraints', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/needsAgentComment/);
    expect(src).toMatch(/SKILL_CONSTRAINTS/);
  });

  it('skill mode supports --selected-comment-text', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/selectedCommentText/);
    expect(src).toMatch(/handleSkillExecution/);
  });

  it('comment_unconfirmed returns action=comment_unconfirmed not executed', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/action:\s*['"]comment_unconfirmed['"]/);
    expect(src).toMatch(/comment_not_confirmed/);
  });

  it('does not call clickLike without execute guard', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/clickLike\(page,\s*\{ execute:\s*true \}\)/);
  });

  it('re-checks like state before clickLike', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const recheckIndex = src.indexOf('const recheck = await checkLikeState(page)');
    const clickLikeIndex = src.indexOf('clickLike(page, { execute: true })');
    expect(recheckIndex).toBeGreaterThan(-1);
    expect(clickLikeIndex).toBeGreaterThan(-1);
    expect(recheckIndex).toBeLessThan(clickLikeIndex);
  });
});

// ============================================================
// 7. CLI output structure
// ============================================================
describe('visits:live-review JSON output', () => {
  it('empty DB produces valid JSON', () => {
    const result = runCli('live-review-visits.mjs', ['--json', '--max-items', '5'], 15_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('visits:live-review');
  });
});

// ============================================================
// 8. FORBIDDEN_WORDS
// ============================================================
describe('FORBIDDEN_WORDS', () => {
  it('contains expected words', () => {
    expect(FORBIDDEN_WORDS).toContain('互关');
    expect(FORBIDDEN_WORDS).toContain('回访');
    expect(FORBIDDEN_WORDS).toContain('已赞');
    expect(FORBIDDEN_WORDS).toContain('求关注');
    expect(FORBIDDEN_WORDS).toContain('加V');
    expect(FORBIDDEN_WORDS).toContain('引流');
  });
});
