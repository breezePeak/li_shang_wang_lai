import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const CLI_DIR = resolve(ROOT_DIR, 'src/cli');
const DB_SCRIPT = resolve(ROOT_DIR, 'src/db/migrations.mjs');
const TEST_DIR = resolve(tmpdir(), `lishangwanglai-apply-${Date.now()}`);
const TEST_DB_PATH = resolve(TEST_DIR, 'test.db');

function runNode(entry, args = []) {
  return spawnSync('node', [entry, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: ROOT_DIR,
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: TEST_DB_PATH },
  });
}

function runCli(script, args = []) {
  return runNode(resolve(CLI_DIR, script), args);
}

function seedPendingComment({ workId, modalId, actorName, commentText, commentKey }) {
  const db = new Database(TEST_DB_PATH);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO works (work_id, modal_id, work_title, work_url, work_type, raw_context_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'video', '{}', ?, ?)`)
    .run(workId, modalId, `作品-${workId}`, `https://www.douyin.com/video/${workId}`, now, now);
  const result = db.prepare(`INSERT INTO work_comments (
      work_id, work_url, modal_id, actor_name, comment_text, event_time_text,
      comment_key, reply_status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, '05-29 12:00', ?, 'pending', ?, ?)`)
    .run(workId, `https://www.douyin.com/video/${workId}`, modalId, actorName, commentText, commentKey, now, now);
  db.close();
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  try { rmSync(TEST_DB_PATH, { force: true }); } catch {}
  const result = runNode(DB_SCRIPT);
  if (result.status !== 0) {
    throw new Error(`runMigrations failed: ${result.stderr || result.stdout}`);
  }
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('apply-prepared-replies', () => {
  it('deletes input file after successful --commit', () => {
    const commentId = seedPendingComment({
      workId: 'work-apply-001',
      modalId: 'modal-apply-001',
      actorName: '评论用户1',
      commentText: '第一条待回复',
      commentKey: 'ck-apply-001',
    });
    const inputPath = resolve(TEST_DIR, 'prepared-replies-commit.json');
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: 'reply-result-v1',
      replies: [
        {
          commentId,
          commentKey: 'ck-apply-001',
          action: 'reply',
          replyText: '感谢留言',
          reason: '正常回复',
        },
      ],
    }), 'utf8');

    const result = runCli('apply-prepared-replies.mjs', ['--input', inputPath, '--commit']);
    expect(result.status).toBe(0);
    expect(existsSync(inputPath)).toBe(false);

    const db = new Database(TEST_DB_PATH);
    const row = db.prepare('SELECT reply_status, reply_text, reply_reason FROM work_comments WHERE id = ?').get(commentId);
    db.close();
    expect(row.reply_status).toBe('prepared');
    expect(row.reply_text).toBe('感谢留言');
    expect(row.reply_reason).toBe('正常回复');
  });

  it('keeps input file during --dry-run and does not update database', () => {
    const commentId = seedPendingComment({
      workId: 'work-apply-002',
      modalId: 'modal-apply-002',
      actorName: '评论用户2',
      commentText: '第二条待回复',
      commentKey: 'ck-apply-002',
    });
    const inputPath = resolve(TEST_DIR, 'prepared-replies-dry-run.json');
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: 'reply-result-v1',
      replies: [
        {
          commentId,
          commentKey: 'ck-apply-002',
          action: 'reply',
          replyText: '收到',
          reason: '预演',
        },
      ],
    }), 'utf8');

    const result = runCli('apply-prepared-replies.mjs', ['--input', inputPath, '--dry-run']);
    expect(result.status).toBe(0);
    expect(existsSync(inputPath)).toBe(true);

    const db = new Database(TEST_DB_PATH);
    const row = db.prepare('SELECT reply_status, reply_text, reply_reason FROM work_comments WHERE id = ?').get(commentId);
    db.close();
    expect(row.reply_status).toBe('pending');
    expect(row.reply_text).toBeNull();
    expect(row.reply_reason).toBeNull();
  });
});
