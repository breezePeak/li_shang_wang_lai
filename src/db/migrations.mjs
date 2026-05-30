import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LISHANGWANGLAI_DB_PATH || resolve(__dirname, '../../data/lishangwanglai.db');

export function runMigrations(dbPath = DB_PATH) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Initial schema — uses latest constraint set for new installs
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
      platform_event_id TEXT,
      notification_item_key TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      raw_payload_json TEXT,
      target_work_id TEXT,
      target_work_url TEXT,
      dedup_confidence TEXT,
      profile_resolution_status TEXT,
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
      status TEXT NOT NULL CHECK (status IN ('planned','prepared','approved','dry_run_ok','execute_confirmed','running','succeeded','failed','blocked','skipped','sent_unverified')),
      reason TEXT,
      evidence_json TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      executed_at TEXT,
      FOREIGN KEY(event_id) REFERENCES interaction_events(id),
      FOREIGN KEY(plan_id) REFERENCES action_plans(id)
    );
  `);

  // Migrate existing databases that may have old constraint sets or missing columns
  const checkActions = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'"
  ).get();

  const actionsSql = checkActions ? (checkActions.sql || '') : '';
  const needsActionsMigration =
    !actionsSql.includes("execute_confirmed") ||
    !actionsSql.includes("sent_unverified");

  if (needsActionsMigration && actionsSql) {
    console.error('[db:init] 检测到旧版 actions 表约束，重建中...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        plan_id INTEGER,
        action_type TEXT NOT NULL CHECK (action_type IN ('reply_comment', 'like_work', 'skip')),
        target_url TEXT,
        target_title TEXT,
        action_text TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned','prepared','approved','dry_run_ok','execute_confirmed','running','succeeded','failed','blocked','skipped','sent_unverified')),
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
    console.error('[db:init] actions 表已重建');
  }

  // Migrate: add platform_event_id column to existing interaction_events tables
  const checkPlatformId = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='interaction_events'"
  ).get();
  const eventsSql = checkPlatformId ? (checkPlatformId.sql || '') : '';
  if (eventsSql && !eventsSql.includes('platform_event_id')) {
    console.error('[db:init] 旧版 interaction_events 缺少 platform_event_id 列，迁移中...');
    db.exec('ALTER TABLE interaction_events ADD COLUMN platform_event_id TEXT');
    console.error('[db:init] platform_event_id 列已添加');
  }

  if (eventsSql && !eventsSql.includes('notification_item_key')) {
    console.error('[db:init] 旧版 interaction_events 缺少 notification_item_key 列，迁移中...');
    db.exec('ALTER TABLE interaction_events ADD COLUMN notification_item_key TEXT');
    console.error('[db:init] notification_item_key 列已添加');
  }

  // Index for platform_event_id lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_platform_event_id
    ON interaction_events(platform_event_id)
    WHERE platform_event_id IS NOT NULL;
  `);

  // unique index for like_work dedup
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_success_like_target
    ON actions(action_type, target_url)
    WHERE action_type = 'like_work' AND status = 'succeeded';
  `);

  // unique index for active reply_comment dedup
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_reply_action
    ON actions(event_id, action_type)
    WHERE action_type = 'reply_comment'
      AND status IN ('prepared','approved','dry_run_ok','execute_confirmed');
  `);

  // Migrate: add target_work_id, target_work_url, dedup_confidence, profile_resolution_status
  const newColumns = [
    { col: 'target_work_id', check: 'target_work_id' },
    { col: 'target_work_url', check: 'target_work_url' },
    { col: 'dedup_confidence', check: 'dedup_confidence' },
    { col: 'profile_resolution_status', check: 'profile_resolution_status' },
  ];
  const currentEventsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='interaction_events'").get();
  const eventsSqlCurrent = currentEventsSql ? (currentEventsSql.sql || '') : '';
  for (const { col, check } of newColumns) {
    if (eventsSqlCurrent && !eventsSqlCurrent.includes(check)) {
      console.error(`[db:init] 旧版 interaction_events 缺少 ${col} 列，迁移中...`);
      db.exec(`ALTER TABLE interaction_events ADD COLUMN ${col} TEXT`);
      console.error(`[db:init] ${col} 列已添加`);
    }
  }

  // Migrate: backfill relation=friend for events where rawText shows 在线 after username
  backfillOnlineRelation(db);

  // Migrate: normalize historical dirty URLs (double-domain, query params, etc.)
  backfillNormalizeUrls(db);

  console.error('[db:init] 数据库初始化完成:', dbPath);
  db.close();
}

function parseRelationLine(line) {
  if (!line) return null;
  if (line === '朋友') return 'friend';
  if (line === '互相关注') return 'mutual';
  if (line.includes('在线')) return 'friend';
  return null;
}

/**
 * Conservative backfill: upgrade relation=unknown → friend for events
 * where the rawText shows "在线" in the line immediately after the username.
 *
 * - Only upgrades from unknown → friend; never downgrades mutual/friend.
 * - Only processes events with actor_profile_key or actor_profile_url (avoid test noise).
 * - Does NOT modify status.
 */
function backfillOnlineRelation(db) {
  const rows = db.prepare(`
    SELECT id, actor_name, raw_payload_json
    FROM interaction_events
    WHERE relation = 'unknown'
      AND raw_payload_json IS NOT NULL
      AND (actor_profile_key IS NOT NULL OR actor_profile_url IS NOT NULL)
  `).all();

  if (rows.length === 0) return;

  let upgraded = 0;
  const updateStmt = db.prepare(
    "UPDATE interaction_events SET relation = 'friend', updated_at = ? WHERE id = ?"
  );

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.raw_payload_json);
      const rawText = payload.rawText || '';
      const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
      // Username is lines[0], relation/status line is lines[1]
      if (lines.length >= 2 && parseRelationLine(lines[1]) === 'friend') {
        updateStmt.run(new Date().toISOString(), row.id);
        upgraded++;
      }
    } catch {
      // skip malformed JSON
    }
  }

  if (upgraded > 0) {
    console.error(`[db:init] 在线关系回填: ${upgraded} 条 unknown → friend`);
  }
}

/**
 * Backfill: normalize dirty historical URLs (double-domain, query params, etc.)
 * Only UPDATES when the normalized value differs from the stored value.
 * Does NOT modify status, relation, or delete events.
 */
function backfillNormalizeUrls(db) {
  let actorCount = 0;
  let targetCount = 0;

  const updateActor = db.prepare(
    "UPDATE interaction_events SET actor_profile_url = ?, updated_at = ? WHERE id = ?"
  );
  const updateTarget = db.prepare(
    "UPDATE interaction_events SET target_work_url = ?, updated_at = ? WHERE id = ?"
  );

  const rows = db.prepare(
    "SELECT id, actor_profile_url, target_work_url FROM interaction_events"
  ).all();

  const now = new Date().toISOString();

  for (const row of rows) {
    if (row.actor_profile_url) {
      const normalized = normalizeDouyinUrl(row.actor_profile_url);
      if (normalized && normalized !== row.actor_profile_url) {
        updateActor.run(normalized, now, row.id);
        actorCount++;
      }
    }
    if (row.target_work_url) {
      const normalized = normalizeDouyinUrl(row.target_work_url);
      if (normalized && normalized !== row.target_work_url) {
        updateTarget.run(normalized, now, row.id);
        targetCount++;
      }
    }
  }

  if (actorCount > 0 || targetCount > 0) {
    console.error(`[db:init] URL 归一化回填: actor_profile_url ${actorCount} 条, target_work_url ${targetCount} 条`);
  }
}

// Direct execution
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runMigrations();
}
