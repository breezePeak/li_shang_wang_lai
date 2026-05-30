import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  FRIENDLY_RELATIONS,
  VISIT_DRAFTS,
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
// 2. VISIT_DRAFTS — fallback fixed templates
// ============================================================
describe('VISIT_DRAFTS (fallback)', () => {
  it('has exactly 3 entries', () => {
    expect(VISIT_DRAFTS).toHaveLength(3);
  });

  it('each draft has required metadata fields', () => {
    for (const d of VISIT_DRAFTS) {
      expect(typeof d.text).toBe('string');
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.text.length).toBeLessThan(30);
      expect(typeof d.commentCategory).toBe('string');
      expect(typeof d.replyMode).toBe('string');
      expect(typeof d.riskLevel).toBe('string');
    }
  });

  it('all drafts are low risk with auto_simple replyMode', () => {
    for (const d of VISIT_DRAFTS) {
      expect(d.riskLevel).toBe('low');
      expect(d.replyMode).toBe('auto_simple');
    }
  });

  it('contains known fallback texts', () => {
    const texts = VISIT_DRAFTS.map(d => d.text);
    expect(texts).toContain('支持一下');
    expect(texts).toContain('内容不错，来看看');
    expect(texts).toContain('互相加油');
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
// 4. isExecuteAllowedByRisk — updated risk gate
// ============================================================
describe('isExecuteAllowedByRisk', () => {
  it('low + auto_simple → allowed', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'auto_simple' })).toBe(true);
  });

  it('medium + agent_generated_review_required → allowed', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'agent_generated_review_required' })).toBe(true);
  });

  it('high → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'high', replyMode: 'agent_generated_review_required' })).toBe(false);
    expect(isExecuteAllowedByRisk({ riskLevel: 'high', replyMode: 'auto_simple' })).toBe(false);
  });

  it('ignore → blocked', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'ignore' })).toBe(false);
    expect(isExecuteAllowedByRisk({ riskLevel: 'low', replyMode: 'ignore' })).toBe(false);
  });

  it('null → blocked', () => {
    expect(isExecuteAllowedByRisk(null)).toBe(false);
  });

  it('medium + auto_simple → blocked (only agent_generated_review_required allowed for medium)', () => {
    expect(isExecuteAllowedByRisk({ riskLevel: 'medium', replyMode: 'auto_simple' })).toBe(false);
  });
});

// ============================================================
// 5. generateVisitCommentCandidates — contextual + fallback
// ============================================================
describe('generateVisitCommentCandidates', () => {
  it('context with hashtag → generates contextual candidates', () => {
    const ctx = {
      targetWorkTitle: 'React开发技巧',
      captionText: '',
      hashtags: ['React'],
      authorName: '某作者',
      canGenerateContextualComment: true,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of candidates) {
      expect(c.riskLevel).toBe('medium');
      expect(c.replyMode).toBe('agent_generated_review_required');
      expect(c.autoExecuteAllowed).toBe(false);
    }
    expect(candidates[0].text).toContain('React');
  });

  it('context with title but no hashtag → generates from title', () => {
    const ctx = {
      targetWorkTitle: 'Vue3组合式API教程',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of candidates) {
      expect(c.riskLevel).toBe('medium');
    }
  });

  it('no context → fallback fixed templates', () => {
    const ctx = {
      targetWorkTitle: '',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: false,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.riskLevel).toBe('low');
      expect(c.replyMode).toBe('auto_simple');
    }
  });

  it('null context → fallback fixed templates', () => {
    const candidates = generateVisitCommentCandidates(null);
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.riskLevel).toBe('low');
    }
  });

  it('no blocked patterns in generated comments', () => {
    const ctx = {
      targetWorkTitle: '互关技巧分享',
      captionText: '',
      hashtags: ['互关'],
      authorName: '',
      canGenerateContextualComment: true,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    for (const c of candidates) {
      expect(c.text).not.toMatch(/互关|回访|已赞|三连|求关注|私信|加V/);
    }
  });

  it('comments do not exceed 24 chars', () => {
    const ctx = {
      targetWorkTitle: '一个非常非常非常非常非常非常非常非常长的标题',
      captionText: '',
      hashtags: ['测试'],
      authorName: '',
      canGenerateContextualComment: true,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    for (const c of candidates) {
      expect(c.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('each candidate has sourceSignals', () => {
    const ctx = {
      targetWorkTitle: 'Node.js',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    };
    const candidates = generateVisitCommentCandidates(ctx);
    for (const c of candidates) {
      expect(Array.isArray(c.sourceSignals)).toBe(true);
      expect(c.sourceSignals.length).toBeGreaterThan(0);
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

  it('does not import insertAction or updateActionStatus', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).not.toMatch(/insertAction/);
    expect(src).not.toMatch(/updateActionStatus/);
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
// 8. Source code invariants — safety
// ============================================================
describe('live-review-visits.mjs — safety invariants', () => {
  it('does not call clickLike without execute guard', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/clickLike\(page,\s*\{ execute:\s*true \}\)/);
  });

  it('calls checkLikeState before acting in execute mode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
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
    const navInInteractive = src.indexOf('interactiveSelect');
    const navCallsAfter = src.indexOf('navigateToVideo', navInInteractive);
    expect(navCallsAfter).toBe(-1);
  });

  it('has risk gate using isExecuteAllowedByRisk', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/isExecuteAllowedByRisk/);
    expect(src).toMatch(/comment_risk_too_high/);
  });

  it('sets manualReviewMethod based on replyMode', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/user_selected_template/);
    expect(src).toMatch(/user_selected_agent_comment/);
  });

  it('autoExecuteAllowed is always false in record initialization and selection', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    const initMatch = src.match(/autoExecuteAllowed[:\s=]*false/g);
    expect(initMatch.length).toBeGreaterThanOrEqual(2);
  });

  it('each candidate requires individual input (no batch)', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/interactiveSelect\(page,\s*item,\s*isExecute\)/);
    const batchConfirm = src.match(/confirm.*all|approve.*all|batch/i);
    expect(batchConfirm).toBeNull();
  });

  it('imports extractVideoCommentContext and generateVisitCommentCandidates', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toMatch(/extractVideoCommentContext/);
    expect(src).toMatch(/generateVisitCommentCandidates/);
  });
});

// ============================================================
// 9. --default maxItems
// ============================================================
describe('visits:live-review --max-items', () => {
  it('default maxItems is 10', () => {
    const src = readFileSync(resolve(CLI_DIR, 'live-review-visits.mjs'), 'utf8');
    expect(src).toContain("options.maxItems || 10");
  });
});

// ============================================================
// 10. interactiveSelect — verify terminal prompts exist
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
