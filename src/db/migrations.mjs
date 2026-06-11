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
      event_type TEXT NOT NULL CHECK (event_type IN ('comment', 'like', 'reply', 'follow')),
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
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','replied','succeeded','blocked','planned')),
      scanned_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      plan_id INTEGER,
      action_type TEXT NOT NULL CHECK (action_type IN ('reply_comment', 'like_work', 'skip')),
      target_url TEXT,
      target_title TEXT,
      action_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned','prepared','running','succeeded','failed','blocked','skipped','sent_unverified')),
      reason TEXT,
      evidence_json TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      executed_at TEXT,
      FOREIGN KEY(event_id) REFERENCES interaction_events(id)
    );
  `);

  // Migrate existing databases that may have old constraint sets or missing columns
  const checkActions = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'"
  ).get();

  const actionsSql = checkActions ? (checkActions.sql || '') : '';
  const desiredActionStatusSql = "status IN ('planned','prepared','running','succeeded','failed','blocked','skipped','sent_unverified')";
  const needsActionsMigration =
    actionsSql &&
    !actionsSql.includes(desiredActionStatusSql);

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
        status TEXT NOT NULL CHECK (status IN ('planned','prepared','running','succeeded','failed','blocked','skipped','sent_unverified')),
        reason TEXT,
        evidence_json TEXT,
        screenshot_path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        executed_at TEXT,
        FOREIGN KEY(event_id) REFERENCES interaction_events(id)
      );
      INSERT INTO actions_new
      SELECT
        id, event_id, plan_id, action_type, target_url, target_title, action_text,
        CASE
          WHEN status NOT IN ('planned','prepared','running','succeeded','failed','blocked','skipped','sent_unverified') THEN 'prepared'
          ELSE status
        END as status,
        reason, evidence_json, screenshot_path, created_at, executed_at
      FROM actions;
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
      AND status = 'prepared';
  `);

  // ---- New tables for live workflow ----

  db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin',
      work_id TEXT,
      modal_id TEXT,
      work_url TEXT,
      work_title TEXT,
      work_type TEXT,
      thumbnail_key TEXT,
      thumbnail_src TEXT,
      author_name TEXT,
      author_profile_url TEXT,
      author_profile_key TEXT,
      raw_context_json TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      published_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_work_id
    ON works(work_id)
    WHERE work_id IS NOT NULL AND work_id != '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_modal_id
    ON works(modal_id)
    WHERE modal_id IS NOT NULL AND modal_id != '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_thumbnail_key
    ON works(thumbnail_key)
    WHERE thumbnail_key IS NOT NULL AND thumbnail_key != '';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT,
      work_url TEXT,
      modal_id TEXT,
      actor_name TEXT,
      actor_profile_url TEXT,
      actor_profile_key TEXT,
      comment_text TEXT NOT NULL,
      event_time_text TEXT,
      comment_key TEXT NOT NULL,
      source_event_id INTEGER,
      source_notification_key TEXT,
      reply_status TEXT NOT NULL DEFAULT 'pending' CHECK (reply_status IN ('pending','prepared','succeeded','sent_unverified','blocked','skipped','manually_replied')),
      reply_text TEXT,
      reply_reason TEXT,
      raw_comment_json TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      replied_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_comments_unique
    ON work_comments(work_id, comment_key)
    WHERE work_id IS NOT NULL AND work_id != '';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS revisit_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_name TEXT,
      actor_profile_url TEXT,
      actor_profile_key TEXT,
      revisit_key TEXT NOT NULL UNIQUE,
      reasons_json TEXT NOT NULL,
      event_ids_json TEXT,
      comments_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','skipped','blocked')),
      last_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      visited_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS return_visit_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL UNIQUE,
      identity_key TEXT NOT NULL UNIQUE,
      user_id TEXT,
      user_name TEXT NOT NULL,
      user_profile_url TEXT,
      source_type TEXT NOT NULL DEFAULT 'other',
      source_types_json TEXT,
      source_event_ids_json TEXT,
      source_platform_event_ids_json TEXT,
      action_type TEXT NOT NULL DEFAULT 'like_and_comment'
        CHECK (action_type IN ('like_and_comment')),
      status TEXT NOT NULL DEFAULT 'pending_visit'
        CHECK (status IN (
          'pending_visit',
          'collecting_content',
          'content_collected',
          'comment_generated',
          'pending_execute',
          'executing',
          'done',
          'skipped_no_work',
          'skipped_private',
          'skipped_no_suitable_work',
          'failed_collect',
          'failed_generate_comment',
          'failed_like',
          'failed_comment',
          'failed'
        )),
      target_work_id TEXT,
      target_work_url TEXT,
      target_work_title TEXT,
      target_work_text TEXT,
      target_work_summary TEXT,
      target_work_publish_time TEXT,
      reference_comments_json TEXT,
      generated_comment TEXT,
      like_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (like_status IN ('pending','already_liked','liked','failed')),
      comment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (comment_status IN ('pending','generated','posted','failed')),
      collected_at TEXT,
      generated_at TEXT,
      executed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_return_visit_status_updated
      ON return_visit_tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_return_visit_retry
      ON return_visit_tasks(retry_count);
  `);

  const checkReturnVisit = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='return_visit_tasks'"
  ).get();
  const returnVisitSql = checkReturnVisit ? (checkReturnVisit.sql || '') : '';
  if (returnVisitSql && !returnVisitSql.includes('source_platform_event_ids_json')) {
    console.error('[db:init] 旧版 return_visit_tasks 缺少 source_platform_event_ids_json 列，迁移中...');
    db.exec('ALTER TABLE return_visit_tasks ADD COLUMN source_platform_event_ids_json TEXT');
    console.error('[db:init] source_platform_event_ids_json 列已添加');
  }

  // Migrate: add published_at column to works
  const checkWorks = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='works'").get();
  const worksSql = checkWorks ? (checkWorks.sql || '') : '';
  if (worksSql && !worksSql.includes('published_at')) {
    console.error('[db:init] 旧版 works 缺少 published_at 列，迁移中...');
    db.exec('ALTER TABLE works ADD COLUMN published_at TEXT');
    console.error('[db:init] published_at 列已添加');
  }

  // Migrate: add work_desc column to works
  if (worksSql && !worksSql.includes('work_desc')) {
    console.error('[db:init] 旧版 works 缺少 work_desc 列，迁移中...');
    db.exec('ALTER TABLE works ADD COLUMN work_desc TEXT');
    console.error('[db:init] work_desc 列已添加');
  }

  // Migrate: rebuild interaction_events to add reply/follow to event_type CHECK constraint
  const checkEventsConstraint = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='interaction_events'"
  ).get();
  const eventsConstraintSql = checkEventsConstraint ? (checkEventsConstraint.sql || '') : '';
  const needsEventsConstraintMigration =
    eventsConstraintSql &&
    eventsConstraintSql.includes("event_type") &&
    !eventsConstraintSql.includes("'reply'");

  if (needsEventsConstraintMigration) {
    console.error('[db:init] 检测到旧版 interaction_events event_type 约束（缺少 reply/follow），重建中...');

    const oldCols = db.prepare("PRAGMA table_info(interaction_events)").all();
    const hasScannedAt = oldCols.some(c => c.name === 'scanned_at');

    let newTableDef = `
      CREATE TABLE IF NOT EXISTS interaction_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'douyin',
        event_type TEXT NOT NULL CHECK (event_type IN ('comment', 'like', 'reply', 'follow')),
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
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','replied','succeeded','blocked','planned')),
        scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    db.exec(newTableDef);

    let insertSql;
    if (hasScannedAt) {
      insertSql = `
        INSERT INTO interaction_events_new
          (id, platform, event_type, actor_name, actor_profile_key, actor_profile_url,
            relation, my_work_title, comment_text, event_time_text, platform_event_id,
            notification_item_key, fingerprint, raw_payload_json, target_work_id,
            target_work_url, dedup_confidence, profile_resolution_status, status,
            scanned_at, created_at, updated_at)
          SELECT id, platform, event_type, actor_name, actor_profile_key, actor_profile_url,
            relation, my_work_title, comment_text, event_time_text, platform_event_id,
            notification_item_key, fingerprint, raw_payload_json, target_work_id,
            target_work_url, dedup_confidence, profile_resolution_status, status,
            scanned_at, created_at, updated_at
          FROM interaction_events ORDER BY id`;
    } else {
      insertSql = `
        INSERT INTO interaction_events_new
          (id, platform, event_type, actor_name, actor_profile_key, actor_profile_url,
            relation, my_work_title, comment_text, event_time_text, platform_event_id,
            notification_item_key, fingerprint, raw_payload_json, target_work_id,
            target_work_url, dedup_confidence, profile_resolution_status, status,
            created_at, updated_at)
          SELECT id, platform, event_type, actor_name, actor_profile_key, actor_profile_url,
            relation, my_work_title, comment_text, event_time_text, platform_event_id,
            notification_item_key, fingerprint, raw_payload_json, target_work_id,
            target_work_url, dedup_confidence, profile_resolution_status, status,
            created_at, updated_at
          FROM interaction_events ORDER BY id`;
    }
    db.exec(insertSql);

    db.exec(`DROP TABLE interaction_events`);
    db.exec(`ALTER TABLE interaction_events_new RENAME TO interaction_events`);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_fingerprint ON interaction_events(fingerprint)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_event_type_status ON interaction_events(event_type, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_event_actor ON interaction_events(actor_profile_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_event_time ON interaction_events(event_time_text)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_event_platform_event_id ON interaction_events(platform_event_id) WHERE platform_event_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_event_notification_item_key ON interaction_events(notification_item_key) WHERE notification_item_key IS NOT NULL`);

    console.error('[db:init] interaction_events 表已重建（event_type 约束已更新）');
  }
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

  // Migrate: rebuild work_comments to add manually_replied to reply_status CHECK constraint
  const checkWcConstraint = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='work_comments'"
  ).get();
  const wcConstraintSql = checkWcConstraint ? (checkWcConstraint.sql || '') : '';
  const needsWcConstraintMigration =
    wcConstraintSql &&
    wcConstraintSql.includes("reply_status") &&
    !wcConstraintSql.includes("'manually_replied'");

  if (needsWcConstraintMigration) {
    console.error('[db:init] 检测到旧版 work_comments reply_status 约束（缺少 manually_replied），重建中...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS work_comments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT,
        work_url TEXT,
        modal_id TEXT,
        actor_name TEXT,
        actor_profile_url TEXT,
        actor_profile_key TEXT,
        comment_text TEXT NOT NULL,
        event_time_text TEXT,
        comment_key TEXT NOT NULL,
        source_event_id INTEGER,
        source_notification_key TEXT,
        reply_status TEXT NOT NULL DEFAULT 'pending' CHECK (reply_status IN ('pending','prepared','succeeded','sent_unverified','blocked','skipped','manually_replied')),
        reply_text TEXT,
        reply_reason TEXT,
        raw_comment_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        replied_at TEXT
      )
    `);

    db.exec(`
      INSERT INTO work_comments_new
        (id, work_id, work_url, modal_id, actor_name, actor_profile_url, actor_profile_key,
          comment_text, event_time_text, comment_key, source_event_id, source_notification_key,
          reply_status, reply_text, reply_reason, raw_comment_json, first_seen_at, last_seen_at, replied_at)
        SELECT id, work_id, work_url, modal_id, actor_name, actor_profile_url, actor_profile_key,
          comment_text, event_time_text, comment_key, source_event_id, source_notification_key,
          reply_status, reply_text, reply_reason, raw_comment_json, first_seen_at, last_seen_at, replied_at
        FROM work_comments ORDER BY id
    `);

    db.exec('DROP TABLE work_comments');
    db.exec('ALTER TABLE work_comments_new RENAME TO work_comments');

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_comments_unique ON work_comments(work_id, comment_key) WHERE work_id IS NOT NULL AND work_id != ''`);

    console.error('[db:init] work_comments 表已重建（reply_status 约束已更新）');
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
