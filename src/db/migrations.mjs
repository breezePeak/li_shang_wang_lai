import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data/lishangwanglai.db');

export function runMigrations(dbPath = DB_PATH) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin',
      event_type TEXT NOT NULL CHECK (event_type IN ('comment', 'like')),
      actor_name TEXT NOT NULL,
      actor_profile_key TEXT,
      actor_profile_url TEXT,
      relation TEXT NOT NULL DEFAULT 'unknown',
      my_work_title TEXT,
      comment_text TEXT,
      event_time_text TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      raw_payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      scanned_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS action_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_type TEXT NOT NULL CHECK (plan_type IN ('comment_reply', 'reciprocal_like')),
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'auto')),
      status TEXT NOT NULL DEFAULT 'draft',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      executed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      plan_id INTEGER,
      action_type TEXT NOT NULL CHECK (action_type IN ('reply_comment', 'like_work', 'skip')),
      target_url TEXT,
      target_title TEXT,
      action_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned', 'approved', 'running', 'succeeded', 'failed', 'blocked', 'skipped')),
      reason TEXT,
      evidence_json TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      executed_at TEXT,
      FOREIGN KEY(event_id) REFERENCES interaction_events(id),
      FOREIGN KEY(plan_id) REFERENCES action_plans(id)
    );
  `);

  // Fix: if actions table was created with old constraint (missing 'blocked'), recreate it
  const checkResult = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'"
  ).get();
  if (checkResult && checkResult.sql && !checkResult.sql.includes("'blocked'")) {
    console.log('[db:init] 检测到旧版 actions 表约束(缺 blocked)，重建中...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        plan_id INTEGER,
        action_type TEXT NOT NULL CHECK (action_type IN ('reply_comment', 'like_work', 'skip')),
        target_url TEXT,
        target_title TEXT,
        action_text TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'approved', 'running', 'succeeded', 'failed', 'blocked', 'skipped')),
        reason TEXT,
        evidence_json TEXT,
        screenshot_path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        executed_at TEXT,
        FOREIGN KEY(event_id) REFERENCES interaction_events(id),
        FOREIGN KEY(plan_id) REFERENCES action_plans(id)
      );
      INSERT INTO actions_new SELECT * FROM actions;
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
    console.log('[db:init] actions 表已重建');
  }

  // unique index for like_work dedup
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_success_like_target
    ON actions(action_type, target_url)
    WHERE action_type = 'like_work' AND status = 'succeeded';
  `);

  console.log('[db:init] 数据库初始化完成:', dbPath);
  db.close();
}

// 直接运行时执行迁移
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runMigrations();
}
