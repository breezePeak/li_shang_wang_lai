import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../../src/cli/execute-reciprocal-likes.mjs');

function runCli(args = []) {
  return spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('S0.5: reciprocal-like safety gate', () => {
  it('should block --execute by default (FEATURE_DISABLED)', () => {
    const result = runCli(['--execute', '--plan', 'nonexistent.json']);

    // Must exit non-zero
    expect(result.status).not.toBe(0);

    // Must output FEATURE_DISABLED in stderr or stdout
    const output = (result.stderr || '') + (result.stdout || '');
    const parsed = (() => { try { return JSON.parse(result.stderr || result.stdout); } catch { return null; } })();

    if (parsed) {
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('FEATURE_DISABLED');
    } else {
      // Fallback: check output contains key phrases
      expect(output).toMatch(/FEATURE_DISABLED|默认禁用|experimentalExecuteEnabled/);
    }
  });

  it('should NOT block --dry-run (preview only)', () => {
    const result = runCli(['--dry-run', '--plan', 'nonexistent.json']);

    // --dry-run should NOT be blocked by safety gate
    // (will fail later because plan file doesn't exist, but NOT with FEATURE_DISABLED)
    const output = (result.stderr || '') + (result.stdout || '');
    expect(output).not.toMatch(/FEATURE_DISABLED/);
  });
});
