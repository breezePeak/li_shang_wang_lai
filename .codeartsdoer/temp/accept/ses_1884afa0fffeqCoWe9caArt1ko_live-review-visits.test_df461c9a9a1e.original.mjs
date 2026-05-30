import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  classifyLikeResult,
  isExecuteAllowedByRisk,
} from '../../src/cli/live-review-visits.mjs';
import {
  generateVisitCommentCandidates,
  FIXED_FALLBACK_TEMPLATES,
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

  it('does NOT contain unknown', () => {
    expect(FRIENDLY_RELATIONS.has('unknown')).toBe(false);
  });
});

// ============================================================
// 2. FIXED_FALLBACK_TEMPLATES
// ============================================================
describe('FIXED_FALLBACK_TEMPLATES', () => {
  it('has 3 entries all low risk', () => {
    expect(FIXED_FALLBACK_TEMPLATES).toHaveLength(3);
    for (const d of FIXED_FALLBACK_TEMPLATES) {
      expect(d.riskLevel).toBe('low');
      expect(d.replyMode).toBe('auto_simple');
      expect(d.autoExecuteAllowed).toBe(false);
    }
  });
});

// ============================================================
// 3. classifyLikeResult
// ============================================================
describe('classifyLikeResult (live-review-visits)', () => {
  it('already_liked + confirmed → skipped', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: true, confidence: 'confirmed' } });
    expect(r.status).toBe('skipped');
    expect(r.likeState).toBe('already_liked');
  });

  it('not_liked + confirmed → pending_review', () => {
    const r = classifyLikeResult({ ok: true, data: { alreadyLiked: false, confidence: 'confirmed' } });
    expect(r.status).toBe('pending_review');
  });

  it('null → blocked', () => {
    const r = classifyLikeResult(null);
    expect(r.status).toBe('blocked');
  });
});

// ============================================================
// 4. isExecuteAllowedByRisk — with manualReviewMethod + selectedCommentText
// ============================================================
describe('isExecuteAllowedByRisk', () => {
  const withTemplate = { selectedCommentText: '支持一下', manualReviewMethod: 'user_selected_template' };
  const withAgent = { selectedCommentText: 'React不错', manualReviewMethod: 'user_selected_agent_comment' };
  const noSelection = { selectedCommentText: null, manualReviewMethod: null };

  it('low + auto_simple + user_selected_template → allowed', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'auto_simple' }, withTemplate)).toBe(true);
  });

  it('medium + agent_generated + user_selected_agent_comment → allowed', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'agent_generated_review_required' }, withAgent)).toBe(true);
  });

  it('high → blocked regardless', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'high', replyMode: 'auto_simple' }, withTemplate)).toBe(false);
    expect(isExecuteAllowedByRisk({ riskLevel: 'high', replyMode: 'agent_generated_review_required' }, withAgent)).toBe(false);
  });

  it('ignore → blocked regardless', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'ignore' }, withAgent)).toBe(false);
  });

  it('no selectedCommentText → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'auto_simple' }, noSelection)).toBe(false);
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'agent_generated_review_required' }, noSelection)).toBe(false);
  });

  it('null candidate → blocked', () => {
    expect(isExecuteAllowedByRisk(null, withTemplate)).toBe(false);
  });

  it('null record → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'auto_simple' }, null)).toBe(false);
  });

  it('low + auto_simple + wrong manualReviewMethod → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'auto_simple' }, withAgent)).toBe(false);
  });

  it('medium + agent_generated + wrong manualReviewMethod → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'agent_generated_review_required' }, withTemplate)).toBe(false);
  });
});

// ============================================================
// 5. generateVisitCommentCandidates — returns { generatedCommentCandidates, usedFallback }
// ============================================================
describe('generateVisitCommentCandidates', () => {
  it('context with hashtag → contextual candidates + usedFallback=false', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'React开发技巧',
      captionText: '',
      hashtags: ['React'],
      authorName: '某作者',
      canGenerateContextualComment: true,
    });
    expect(result.usedFallback).toBe(false);
    expect(result.generatedCommentCandidates.length).toBeGreaterThanOrEqual(2);
    for (const c of result.generatedCommentCandidates) {
      expect(c.riskLevel).toBe('medium');
      expect(c.replyMode).toBe('agent_generated_review_required');
      expect(c.autoExecuteAllowed).toBe(false);
    }
    expect(result.generatedCommentCandidates[0].text).toContain('React');
  });

  it('context with title → contextual candidates', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'Vue3组合式API教程',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    });
    expect(result.usedFallback).toBe(false);
    expect(result.generatedCommentCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it('no context → fallback + usedFallback=true', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: '',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: false,
    });
    expect(result.usedFallback).toBe(true);
    expect(result.generatedCommentCandidates).toHaveLength(3);
    for (const c of result.generatedCommentCandidates) {
      expect(c.riskLevel).toBe('low');
      expect(c.replyMode).toBe('auto_simple');
    }
  });

  it('null → fallback + usedFallback=true', () => {
    const result = generateVisitCommentCandidates(null);
    expect(result.usedFallback).toBe(true);
    expect(result.generatedCommentCandidates).toHaveLength(3);
  });

  it('no forbidden patterns in generated comments', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: '互关技巧分享',
      captionText: '',
      hashtags: ['互关'],
      authorName: '',
      canGenerateContextualComment: true,
    });
    for (const c of result.generatedCommentCandidates) {
      expect(c.text).not.toMatch(/互关|回访|已赞|三连|求关注|私信|加V|加微信|互赞|引流|广告/);
    }
  });

  it('comments ≤24 chars', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: '一个非常非常非常非常非常非常非常非常长的标题',
      captionText: '',
      hashtags: ['测试'],
      authorName: '',
      canGenerateContextualComment: true,
    });
    for (const c of result.generatedCommentCandidates) {
      expect(c.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('each candidate has required fields', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'Test',
      captionText: 'desc',
      hashtags: ['tag'],
      authorName: 'author',
      canGenerateContextualComment: true,
    });
    for (const c of result.generatedCommentCandidates) {
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(0);
      expect(typeof c.commentCategory).toBe('string');
      expect(typeof c.replyMode).toBe('string');
      expect(typeof c.riskLevel).toBe('string');
      expect(typeof c.reason).toBe('string');
      expect(Array.isArray(c.sourceSignals)).toBe(true);
      expect(c.autoExecuteAllowed).toBe(false);
    }
  });
});

// ============================================================
// 6. No DB write imports
// ============================================================
describe('live-review-visits.mjs — no DB writes', () => {
  it('does not import updateEventStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/updateEventStatus/);
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
// 7. CLI output structure (empty DB)
// ============================================================
describe('visits:live-review JSON output structure', () => {
  it('empty DB produces valid JSON with correct keys', () => {
    const result = runCli('live-review-visits.mjs', ['--json', '--max-items', '5'], 15_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('visits:live-review');
    expect(parsed.data).toHaveProperty('reviewCandidates');
  });
});

// ============================================================
// 8. Source code invariants — safety
// ============================================================
describe('live-review-visits.mjs — safety invariants', () => {
  it('does not call clickLike without execute guard', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/clickLike\(page,\s*\{ execute:\s*true \}\)/);
  });

  it('calls checkLikeState before clickLike in execute mode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const recheckIndex = src.indexOf('const recheck = await checkLikeState(page)');
    const clickLikeIndex = src.indexOf('clickLike(page, { execute: true })');
    expect(recheckIndex).toBeGreaterThan(-1);
    expect(clickLikeIndex).toBeGreaterThan(-1);
    expect(recheckIndex).toBeLessThan(clickLikeIndex);
  });

  it('does not re-open targetWorkUrl before execute', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const navInInteractive = src.indexOf('interactiveSelect');
    const navCallsAfter = src.indexOf('navigateToVideo', navInInteractive);
    expect(navCallsAfter).toBe(-1);
  });

  it('has risk gate using isExecuteAllowedByRisk with record', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/isExecuteAllowedByRisk\(selected,\s*record\)/);
    expect(src).toMatch(/comment_risk_too_high/);
  });

  it('sets manualReviewMethod based on replyMode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/user_selected_template/);
    expect(src).toMatch(/user_selected_agent_comment/);
  });

  it('autoExecuteAllowed is always false', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const initMatch = src.match(/autoExecuteAllowed[:\s=]*false/g);
    expect(initMatch.length).toBeGreaterThanOrEqual(2);
  });

  it('handles comment unconfirmed', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/unconfirmed/);
    expect(src).toMatch(/comment_not_confirmed/);
  });

  it('does not export VISIT_DRAFTS', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/export const VISIT_DRAFTS/);
  });

  it('imports extractVideoCommentContext and generateVisitCommentCandidates', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/extractVideoCommentContext/);
    expect(src).toMatch(/generateVisitCommentCandidates/);
  });

  it('each candidate requires individual input (no batch)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/interactiveSelect\(page,\s*item,\s*isExecute\)/);
  });
});

// ============================================================
// 9. maxItems default
// ============================================================
describe('visits:live-review --max-items', () => {
  it('default maxItems is 10', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toContain("options.maxItems || 10");
  });
});

// ============================================================
// 10. interactiveSelect prompts
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
});
