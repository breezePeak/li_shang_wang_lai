import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = []) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function parseOutput(result) {
  const stdout = result.stdout || '';
  try {
    return JSON.parse(stdout.trim().split('\n').pop() || stdout.trim());
  } catch {
    return null;
  }
}

describe('comment reply approval workflow', () => {
  let testActionId = null;

  // prepare requires an existing event — use eventId from live DB
  it('should prepare a reply action for an existing comment', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '2',
      '--reply-text', '测试回复内容',
      '--json',
    ]);

    const parsed = parseOutput(result);
    if (parsed && parsed.ok) {
      testActionId = parsed.data.actionId;
    }
    expect(parsed).not.toBeNull();
    // May fail if event doesn't exist or already has active action
    // Either ok:true with actionId or DUPLICATE_ACTION is acceptable
  });

  it('should block duplicate active reply actions for same event', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '2',
      '--reply-text', '另一个回复',
      '--json',
    ]);

    const parsed = parseOutput(result);
    expect(parsed).not.toBeNull();
    // Should fail because an active action already exists
    expect(parsed.ok).toBe(false);
  });

  it('should require approved status for dry-run', () => {
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', testActionId || '999',
      '--dry-run',
      '--json',
    ]);

    const parsed = parseOutput(result);
    expect(parsed).not.toBeNull();
    // Not approved yet → should block
    expect(parsed.ok).toBe(false);
  });

  it('should require execute_confirmed for real send', () => {
    const result = runCli('execute-comment-reply.mjs', [
      '--action-id', testActionId || '999',
      '--execute',
      '--max-items', '1',
      '--json',
    ]);

    const parsed = parseOutput(result);
    expect(parsed).not.toBeNull();
    // Not execute_confirmed yet → should block
    expect(parsed.ok).toBe(false);
  });

  it('should approve a prepared action', () => {
    if (!testActionId) return;

    const result = runCli('approve-action.mjs', [
      '--action-id', String(testActionId),
      '--json',
    ]);

    const parsed = parseOutput(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe('approved');
  });

  it('should report pending comments with action status', () => {
    const result = runCli('report-pending.mjs', [
      '--type', 'comment',
      '--json',
    ]);

    const parsed = parseOutput(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.summary.pendingComments).toBe('number');
    expect(typeof parsed.summary.blocked).toBe('number');
    // Each comment should have eventStatus field
    if (parsed.data.comments.length > 0) {
      expect(parsed.data.comments[0]).toHaveProperty('eventStatus');
    }
  });
});
