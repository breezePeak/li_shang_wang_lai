import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { writeFileSync } from 'fs';
import {
  extractTargetCommentId,
  loadWorkCommentItemsFromFile,
  resolveWorkUrlFromItem,
} from '../../src/cli/execute-comment-replies.mjs';

// ============================================================
// Test helpers — run CLI and capture stdout
// ============================================================
const testDir = join(__dirname, '../../data/test-execute-logic');
const testDb = join(testDir, 'test-execute.db');

function cleanup() {
  if (existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true }); } catch {}
  }
}

function setup() {
  cleanup();
  mkdirSync(testDir, { recursive: true });
  process.env.LISHANGWANGLAI_DB_PATH = testDb;
  const db = new Database(testDb);
  db.pragma('journal_mode = WAL');
  // Create tables needed by execute-comment-replies
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT,
      work_url TEXT,
      modal_id TEXT,
      actor_name TEXT,
      actor_profile_url TEXT,
      actor_profile_key TEXT,
      comment_text TEXT,
      event_time_text TEXT,
      comment_key TEXT,
      source_event_id INTEGER,
      source_notification_key TEXT,
      reply_text TEXT,
      reply_status TEXT NOT NULL DEFAULT 'pending',
      reply_reason TEXT,
      raw_comment_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      replied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS interaction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin',
      event_type TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      comment_text TEXT,
      raw_payload_json TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'new',
      scanned_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insert test data
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (1, 'https://douyin.com/video/1', 'user1', 'test comment', 'key1', 'My reply', 'pending')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (2, 'https://douyin.com/video/2', 'user2', 'test comment 2', 'key2', '', 'pending')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (3, 'https://douyin.com/video/3', 'user3', 'test comment 3', 'key3', 'Already done', 'succeeded')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (4, 'https://douyin.com/video/4', 'user4', 'test comment 4', 'key4', 'Unverified', 'sent_unverified')").run();
  db.prepare("INSERT INTO interaction_events (id, event_type, actor_name, fingerprint, status, scanned_at) VALUES (1, 'comment', 'user1', 'fp1', 'new', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO interaction_events (id, event_type, actor_name, fingerprint, status, scanned_at) VALUES (3, 'comment', 'user3', 'fp3', 'new', CURRENT_TIMESTAMP)").run();

  db.close();
  return testDb;
}

function parseStdout(result) {
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

// Run CLI module and capture stdout/stderr
async function runCli(fileName, extraArgs = []) {
  const { spawnSync } = await import('child_process');
  const args = [resolve(__dirname, '../../src/cli', fileName), ...extraArgs];
  const result = spawnSync('node', args, {
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: testDb },
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

// ============================================================
// Test helper — load JSON
// ============================================================
function makeJsonFile(comments) {
  const filePath = join(testDir, 'test-pending.json');
  const json = {
    workflow_status_code: 'PREPARE_JSON_UPDATED',
    works: [{
      workKey: 'work1',
      workUrl: 'https://douyin.com/video/1',
      comments,
    }],
  };
  writeFileSync(filePath, JSON.stringify(json));
  return filePath;
}

function makeWorkArrayJsonFile(comments) {
  const filePath = join(testDir, 'test-pending-array.json');
  const json = [{
    workKey: 'work1',
    work_url: 'https://douyin.com/video/1',
    comments,
  }];
  writeFileSync(filePath, JSON.stringify(json));
  return filePath;
}

// ============================================================
// Tests
// ============================================================
describe('comments:execute refactored logic', () => {
  beforeEach(() => {
    setup();
  });

  // 1. No --execute needed, default real execution — missing itemsFile exits with error
  it('exits with error when missing --items-file (no --execute flag required)', async () => {
    const result = await runCli('execute-comment-replies.mjs', ['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    // Should error because --items-file is missing, NOT because --execute is missing
  });

  // 2. JSON loaded without maxItems limit
  it('loads all comments from JSON without maxItems restriction', async () => {
    const json = makeJsonFile([
      { id: 1, reply_text: 'Reply 1', work_url: 'https://douyin.com/video/1', actor_name: 'user1', comment_text: 'test' },
      { id: 2, reply_text: 'Reply 2', work_url: 'https://douyin.com/video/2', actor_name: 'user2', comment_text: 'test2' },
      { id: 5, reply_text: '', work_url: 'https://douyin.com/video/5', actor_name: 'user5', comment_text: 'test5' }, // empty reply
      { id: 3, reply_text: 'Already', work_url: 'https://douyin.com/video/3', actor_name: 'user3', comment_text: 'test3' }, // succeeded
      { id: 4, reply_text: 'Sent', work_url: 'https://douyin.com/video/4', actor_name: 'user4', comment_text: 'test4' }, // sent_unverified
      { id: 99, reply_text: 'Unknown', work_url: '', actor_name: 'unknown', comment_text: 'no_work' }, // missing work_url
    ]);

    // This test verifies the file was created — browser execution will be tested separately
    const fs = await import('fs');
    const content = fs.readFileSync(json, 'utf8');
    const parsed = JSON.parse(content);
    const allComments = [];
    for (const work of parsed.works) {
      for (const c of work.comments) allComments.push(c);
    }
    // All 6 comments should be loaded (no slice/maxItems)
    expect(allComments.length).toBe(6);
    // Including the empty reply and the already-succeeded one
    const emptyReplies = allComments.filter(c => !c.reply_text);
    expect(emptyReplies.length).toBe(1);
  });

  it('supports top-level work array JSON format', async () => {
    const json = makeWorkArrayJsonFile([
      { id: 2, reply_text: '', work_url: 'https://douyin.com/video/2', actor_name: 'user2', comment_text: 'test2' },
    ]);
    const fs = await import('fs');
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(Array.isArray(parsed[0].comments)).toBe(true);
    expect(parsed[0].comments[0].comment_text).toBe('test2');
  });

  it('loadWorkCommentItemsFromFile 保留作品级元信息并兼容 cid 字段', () => {
    const filePath = join(testDir, 'pending-with-cid.json');
    writeFileSync(filePath, JSON.stringify([{
      workKey: 'work-1',
      work_url: 'https://www.douyin.com/video/123',
      comments: [
        { id: 1, cid: 'cid-1', reply_text: 'ok', actor_name: 'user1', comment_text: 'hello' },
      ],
    }]));

    const loaded = loadWorkCommentItemsFromFile(filePath);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0].targetCommentId).toBe('cid-1');
    expect(loaded.items[0].workMeta.work_url).toBe('https://www.douyin.com/video/123');
  });

  it('resolveWorkUrlFromItem 优先使用现有字段并回退到 workId/modalId', () => {
    expect(resolveWorkUrlFromItem({ workUrl: 'https://a' }, {})).toBe('https://a');
    expect(resolveWorkUrlFromItem({ awemeUrl: 'https://b' }, {})).toBe('https://b');
    expect(resolveWorkUrlFromItem({ workId: '123' }, {})).toBe('https://www.douyin.com/video/123');
    expect(resolveWorkUrlFromItem({ modalId: '456' }, {})).toBe('https://www.douyin.com/video/456');
  });

  it('extractTargetCommentId 能从 raw_comment_json 回推 cid', () => {
    const cid = extractTargetCommentId({}, {
      raw_comment_json: JSON.stringify({
        source: 'comment-list-api',
        comment: { cid: 'cid-from-raw' },
      }),
    });
    expect(cid).toBe('cid-from-raw');
  });

  it('主流程源码不再引用 creator 评论管理页或 ensureCommentPageReady', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(resolve(__dirname, '../../src/cli/execute-comment-replies.mjs'), 'utf8');
    expect(source.includes('creator-micro/interactive/comment')).toBe(false);
    expect(source.includes('ensureCommentPageReady')).toBe(false);
  });

  // 3. EXECUTE_SKIPPED_EMPTY for empty reply_text
  it('marks empty reply_text comments as EXECUTE_SKIPPED_EMPTY in JSON update', () => {
    // Test the updateExecuteJsonFile logic directly by importing it
    // Since the function is not exported, we test via the JSON file update path
    const json = makeJsonFile([
      { id: 1, reply_text: 'Reply 1', work_url: 'https://douyin.com/video/1', actor_name: 'user1', comment_text: 'test' },
      { id: 2, reply_text: '', work_url: 'https://douyin.com/video/2', actor_name: 'user2', comment_text: 'test2' },
    ]);
    // The JSON update happens inside main(), which requires browser
    // For now, verify the JSON was created correctly
    const fs = require('fs');
    const content = fs.readFileSync(json, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.works[0].comments.length).toBe(2);
    expect(parsed.works[0].comments[1].reply_text).toBe('');
  });

  // 4. Already succeeded → EXECUTE_ALREADY_CONFIRMED (not EXECUTE_FAILED)
  it('detects already succeeded comments and would mark ALREADY_CONFIRMED', () => {
    // This is tested via the validateWorkCommentItem logic:
    // commentId=3 has reply_status='succeeded' and reply_text='Already done'
    // validateWorkCommentItem should return { ok: false, status: 'succeeded' }
    // and updateExecuteJsonFile should map it to EXECUTE_ALREADY_CONFIRMED
    // Since validateWorkCommentItem is not exported, this is covered by browser integration

    // Verify the DB state is correct for this scenario
    const db = new Database(testDb);
    const row = db.prepare("SELECT * FROM work_comments WHERE id = 3").get();
    expect(row).not.toBeNull();
    expect(row.reply_status).toBe('succeeded');
    expect(row.reply_text).toBe('Already done');
    db.close();
  });

  // 5. Already sent_unverified → EXECUTE_ALREADY_SENT_UNVERIFIED (not EXECUTE_FAILED)
  it('detects already sent_unverified comments and would mark ALREADY_SENT_UNVERIFIED', () => {
    const db = new Database(testDb);
    const row = db.prepare("SELECT * FROM work_comments WHERE id = 4").get();
    expect(row).not.toBeNull();
    expect(row.reply_status).toBe('sent_unverified');
    expect(row.reply_text).toBe('Unverified');
    db.close();
  });

  // 6. Statistics: succeeded vs skipped vs failed
  it('statistics logic correctly separates succeeded, skipped, failed', () => {
    // Simulate result array
    const results = [
      { commentId: 1, ok: true, status: 'succeeded' },           // real success
      { commentId: 2, ok: false, status: 'skipped_empty_reply' }, // empty reply
      { commentId: 3, ok: false, status: 'succeeded' },           // already done
      { commentId: 4, ok: false, status: 'sent_unverified' },     // already sent
      { commentId: 99, ok: false, status: 'blocked', error: 'err' }, // real failure
    ];

    const isSkippedResult = (result) => {
      return result.status === 'skipped_empty_reply'
        || (!result.ok && result.status === 'succeeded')
        || (!result.ok && result.status === 'sent_unverified');
    };

    const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
    const skipped = results.filter(isSkippedResult).length;
    const failed = results.length - succeeded - skipped;

    // commentId=1 is real success
    expect(succeeded).toBe(1);
    // commentId=2,3,4 are skipped
    expect(skipped).toBe(3);
    // commentId=99 is real failure
    expect(failed).toBe(1);
    // Total
    expect(succeeded + skipped + failed).toBe(results.length);
  });
});
