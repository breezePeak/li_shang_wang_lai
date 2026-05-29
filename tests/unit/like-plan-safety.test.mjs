import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(args = []) {
  return spawnSync('node', [resolve(CLI_DIR, 'plan-likes.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

describe('P0-2: likes:plan preview-only safety', () => {
  it('likes:plan --json stdout must parse as single JSON', () => {
    const result = runCli(['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('likes:plan');
  });

  it('all candidates must have previewOnly:true and executeAllowed:false', () => {
    const result = runCli(['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();

    const candidates = parsed.data?.candidates || [];
    for (const c of candidates) {
      expect(c.previewOnly).toBe(true);
      expect(c.executeAllowed).toBe(false);
    }
  });

  it('likes:plan must not suggest executing likes:reciprocate', () => {
    const result = runCli(['--json']);
    const stderr = result.stderr || '';
    // Must not contain execute hints
    expect(stderr).not.toMatch(/likes:reciprocate --execute/);
    expect(stderr).not.toMatch(/npm run likes:reciprocate.*--execute/);
  });
});
