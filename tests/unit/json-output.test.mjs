import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = []) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

/**
 * Strict JSON parse: entire stdout must be valid JSON.
 * Must NOT rely on splitting lines — that hides pollution.
 */
function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

describe('P0-1: pure --json stdout contract', () => {
  it('actions:pending --json stdout must parse as single JSON', () => {
    const result = runCli('report-pending.mjs', ['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('actions:pending');
    expect(parsed.summary).toBeDefined();
    expect(typeof parsed.summary.pendingComments).toBe('number');
    expect(typeof parsed.summary.blocked).toBe('number');
  });

  it('comments:prepare --json stdout must parse as single JSON', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999',
      '--reply-text', 'test',
      '--json',
    ]);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    // May succeed or fail depending on if event 999 exists
    // But stdout must always be valid JSON
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('comments:prepare batch --items-json stdout must parse as single JSON', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--items-json', '[{"eventId":999001,"replyText":"小虾先记下啦"},{"eventId":999002,"replyText":"小虾觉得挺有意思"}]',
      '--json',
    ]);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('comments:prepare');
    expect(Array.isArray(parsed.data.results)).toBe(true);
    expect(parsed.data.results).toHaveLength(2);
  });

  it('comments:execute-all validate-only --json stdout must parse as single JSON', () => {
    const result = runCli('execute-all-comment-replies.mjs', [
      '--action-id', '999',
      '--json',
    ]);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    // May succeed or fail depending on whether the local DB already has this action id.
    // The contract here is that stdout stays pure JSON.
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('execute-reciprocal-likes --execute --json must return FEATURE_DISABLED', () => {
    const result = runCli('execute-reciprocal-likes.mjs', [
      '--execute',
      '--plan', 'nonexistent.json',
    ]);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('FEATURE_DISABLED');
  });

  it('scan-interactions --json stdout must parse as single JSON when type is invalid', () => {
    const result = runCli('scan-interactions.mjs', [
      '--json',
      '--type', 'invalid',
    ]);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});
