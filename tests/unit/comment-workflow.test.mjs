import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

const TEST_DB_DIR = resolve(tmpdir(), `lishangwanglai-test-${Date.now()}`);
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'test.db');

function runCli(script, args = []) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: TEST_DB_PATH },
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

beforeAll(() => {
  if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'douyin',
      event_type TEXT NOT NULL CHECK (event_type IN ('comment', 'like')),
      actor_name TEXT NOT NULL, actor_profile_key TEXT, actor_profile_url TEXT,
      relation TEXT NOT NULL DEFAULT 'unknown', my_work_title TEXT,
      comment_text TEXT, event_time_text TEXT, fingerprint TEXT NOT NULL UNIQUE,
      raw_payload_json TEXT, status TEXT NOT NULL DEFAULT 'new',
      scanned_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, plan_id INTEGER,
      action_type TEXT NOT NULL CHECK (action_type IN ('reply_comment','like_work','skip')),
      target_url TEXT, target_title TEXT, action_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned','prepared','approved','dry_run_ok','execute_confirmed','running','succeeded','failed','blocked','skipped')),
      reason TEXT, evidence_json TEXT, screenshot_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, executed_at TEXT,
      FOREIGN KEY(event_id) REFERENCES interaction_events(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_reply_action
    ON actions(event_id, action_type)
    WHERE action_type='reply_comment' AND status IN ('prepared','approved','dry_run_ok','execute_confirmed');
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO interaction_events (event_type, actor_name, relation, my_work_title, comment_text, event_time_text, fingerprint, scanned_at)
    VALUES ('comment','测试用户A','unknown','测试作品','写得不错','05-29 10:00','fp-test-001',?)`).run(now);
  db.prepare(`INSERT INTO interaction_events (event_type, actor_name, relation, my_work_title, comment_text, event_time_text, fingerprint, scanned_at)
    VALUES ('comment','测试用户B','unknown','测试作品2','我也觉得','05-29 11:00','fp-test-002',?)`).run(now);
  db.close();
});

afterAll(() => {
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('comment workflow state machine', () => {
  it('rejects prepare with invalid event-id', () => {
    const r = runCli('prepare-comment-reply.mjs', ['--event-id','99999','--reply-text','test','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
  });

  it('rejects prepare with empty reply text', () => {
    const r = runCli('prepare-comment-reply.mjs', ['--event-id','1','--reply-text','','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
    expect(p.code).toBe('EMPTY_REPLY_TEXT');
  });

  it('rejects approve of non-existent action', () => {
    const r = runCli('approve-action.mjs', ['--action-id','99999','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
  });

  it('rejects confirm-execute of non-existent action', () => {
    const r = runCli('confirm-execute.mjs', ['--action-id','99999','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
  });

  it('rejects dry-run without approved status', () => {
    const r = runCli('execute-comment-reply.mjs', ['--action-id','99999','--dry-run','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
  });

  it('rejects execute without execute_confirmed status', () => {
    const r = runCli('execute-comment-reply.mjs', ['--action-id','99999','--execute','--max-items','1','--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(false);
  });

  it('actions:pending --json returns valid structure with blocked array', () => {
    const r = runCli('report-pending.mjs', ['--json']);
    const p = parseStdout(r);
    expect(p).not.toBeNull();
    expect(p.ok).toBe(true);
    expect(Array.isArray(p.data.comments)).toBe(true);
    expect(Array.isArray(p.data.likes)).toBe(true);
    expect(Array.isArray(p.data.blocked)).toBe(true);
    expect(typeof p.summary.pendingComments).toBe('number');
    expect(typeof p.summary.blocked).toBe('number');
  });

  it('all --json stdout must be single-line parseable JSON', () => {
    const commands = [
      ['report-pending.mjs', ['--json']],
      ['approve-action.mjs', ['--action-id','999','--json']],
      ['confirm-execute.mjs', ['--action-id','999','--json']],
      ['execute-comment-reply.mjs', ['--action-id','999','--dry-run','--json']],
      ['prepare-comment-reply.mjs', ['--event-id','999','--reply-text','x','--json']],
    ];
    for (const [script, args] of commands) {
      const r = runCli(script, args);
      const stdout = (r.stdout || '').trim();
      expect(() => JSON.parse(stdout)).not.toThrow();
      const p = JSON.parse(stdout);
      expect(typeof p.ok).toBe('boolean');
      expect(p.command).toBeDefined();
    }
  });
});
