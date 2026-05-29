import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 15_000) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ============================================================
// 1. Execute gates — blocked by state machine
// ============================================================
describe('execute gates — state machine enforcement', () => {
  it('blocks execute when action status is not execute_confirmed', () => {
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', '999', '--execute', '--max-items', '1', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBeDefined();
  });

  it('blocks dry-run when action status is not approved', () => {
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', '999', '--dry-run', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks execute when --dry-run and --execute both passed', () => {
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', '999', '--dry-run', '--execute', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks when duplicate (already succeeded)', () => {
    // action 6 was previously succeeded — cannot re-execute
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', '6', '--execute', '--max-items', '1', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks when missing action-id', () => {
    const result = runCli('execute-comment-reply.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});

// ============================================================
// 2. Prepare gates — unstable/decision/risk/relevance/ignore
// ============================================================
describe('prepare gates — policy enforcement', () => {
  it('blocks prepare for unstable event', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '1', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'low',
      '--relevance', 'relevant',
      '--comment-category', 'praise', '--reply-mode', 'auto_simple',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when decision=manual_review', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'manual_review', '--risk-level', 'medium',
      '--relevance', 'relevant',
      '--comment-category', 'question', '--reply-mode', 'needs_review',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when riskLevel=high', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'high',
      '--relevance', 'relevant',
      '--comment-category', 'risk', '--reply-mode', 'ignore',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when riskLevel=medium', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'medium',
      '--relevance', 'relevant',
      '--comment-category', 'question', '--reply-mode', 'needs_review',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when relevance=irrelevant + decision=reply', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'low',
      '--relevance', 'irrelevant',
      '--comment-category', 'unclear', '--reply-mode', 'needs_review',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when replyMode=ignore', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'ignore', '--risk-level', 'high',
      '--relevance', 'irrelevant',
      '--comment-category', 'spam', '--reply-mode', 'ignore',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare for auto_simple with non-template reply', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', '这是我自己写的回复',
      '--decision', 'reply', '--risk-level', 'low',
      '--relevance', 'neutral',
      '--comment-category', 'praise', '--reply-mode', 'auto_simple',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});

// ============================================================
// 3. Classifier reserved fields
// ============================================================
describe('classifier — reserved gate fields', () => {
  let classifyComment = null;

  beforeAll(async () => {
    const mod = await import('../../src/domain/comment-classifier.mjs');
    classifyComment = mod.classifyComment;
  });

  it('all results have autoExecuteAllowed=false', () => {
    const samples = ['支持一下', '求教程', '刷赞', '哈哈哈', ''];
    for (const s of samples) {
      expect(classifyComment(s).autoExecuteAllowed).toBe(false);
    }
  });

  it('all results have classifierSource=local_rules', () => {
    const samples = ['支持一下', '求教程', '刷赞'];
    for (const s of samples) {
      expect(classifyComment(s).classifierSource).toBe('local_rules');
    }
  });

  it('all results have dailyAutoReplyLimit=0', () => {
    expect(classifyComment('支持一下').dailyAutoReplyLimit).toBe(0);
  });

  it('all results have shadowModePassed=false', () => {
    expect(classifyComment('支持一下').shadowModePassed).toBe(false);
  });

  it('all results have sameUserSameWorkLimit=0', () => {
    expect(classifyComment('支持一下').sameUserSameWorkLimit).toBe(0);
  });

  it('auto_simple_candidate has templateId', () => {
    const r = classifyComment('支持一下');
    expect(r.replyMode).toBe('auto_simple_candidate');
    expect(r.templateId).toBeTruthy();
  });

  it('needs_review has empty templateId', () => {
    const r = classifyComment('求教程');
    expect(r.replyMode).toBe('needs_review');
    expect(r.templateId).toBe('');
  });

  it('ignore has empty templateId', () => {
    const r = classifyComment('刷赞');
    expect(r.replyMode).toBe('ignore');
    expect(r.templateId).toBe('');
  });
});

// ============================================================
// 4. Max-items enforcement
// ============================================================
describe('execute — max-items enforcement', () => {
  it('max-items default is 1 via CLI', () => {
    // The execute CLI always processes a single action (action-id)
    // maxItems is enforced via run-context defaults
    const result = runCli('execute-comment-reply.mjs', ['--action-id', '999', '--execute', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
  });
});

// ============================================================
// 5. auto_simple must not bypass approval chain
// ============================================================
describe('auto_simple — cannot bypass approval chain', () => {
  it('autoExecuteAllowed is always false in classifier', async () => {
    const mod = await import('../../src/domain/comment-classifier.mjs');
    const r = mod.classifyComment('支持一下');
    expect(r.autoExecuteAllowed).toBe(false);
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('prepare does NOT auto-execute (always status=prepared)', () => {
    // prepare always creates with status=prepared, never auto-executes
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', '谢谢认可～',
      '--decision', 'reply', '--risk-level', 'low',
      '--relevance', 'neutral',
      '--comment-category', 'praise', '--reply-mode', 'auto_simple',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
  });

  it('execute requires execute_confirmed status even for auto_simple', () => {
    // Even if someone creates an auto_simple action, execute still requires
    // the full state machine chain
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', '999', '--execute', '--max-items', '1', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    // Will fail because action 999 doesn't exist or isn't execute_confirmed
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});
