import { getDb } from './database.mjs';

/**
 * Insert a new interaction event. Returns the inserted row id.
 * Skips if fingerprint already exists (duplicate).
 */
export function insertEvent({ eventType, actorName, actorProfileKey, actorProfileUrl, relation, myWorkTitle, commentText, eventTimeText, fingerprint, rawPayloadJson, platformEventId, notificationItemKey, status = 'new' }) {
  const db = getDb();
  const scannedAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO interaction_events
      (event_type, actor_name, actor_profile_key, actor_profile_url, relation, my_work_title, comment_text, event_time_text, platform_event_id, fingerprint, raw_payload_json, notification_item_key, scanned_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(eventType, actorName, actorProfileKey || null, actorProfileUrl || null, relation || 'unknown', myWorkTitle || null, commentText || null, eventTimeText || null, platformEventId || null, fingerprint, rawPayloadJson || null, notificationItemKey || null, scannedAt, status);
  return result.changes > 0 ? result.lastInsertRowid : null;
}

/**
 * Get all events of a given type (or all types).
 */
export function getEvents(options = {}) {
  const db = getDb();
  const { eventType, status, limit = 100 } = options;

  let sql = 'SELECT * FROM interaction_events WHERE 1=1';
  const params = [];

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get count of events by type.
 */
export function getEventCounts() {
  const db = getDb();
  return db.prepare('SELECT event_type, status, COUNT(*) as count FROM interaction_events GROUP BY event_type, status').all();
}

/**
 * 更新事件状态（同步 actions 表的状态变化）
 */
export function updateEventStatus(eventId, status) {
  const db = getDb();
  const result = db.prepare(
    'UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, new Date().toISOString(), eventId);
  return result.changes > 0;
}

/**
 * 查询单条事件
 */
export function getEvent(eventId) {
  const db = getDb();
  return db.prepare('SELECT * FROM interaction_events WHERE id = ?').get(eventId);
}

/**
 * Update an existing event with previously-missing profile information.
 * Called when a new scan finds actorProfileUrl/actorProfileKey that was absent before.
 * Returns true if the event was updated.
 */
export function enrichEvent({ fingerprint, actorProfileUrl, actorProfileKey, rawPayloadJson }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM interaction_events WHERE fingerprint = ?').get(fingerprint);
  if (!existing) return false;

  const updates = [];
  const params = [];
  if (actorProfileUrl && !existing.actor_profile_url) {
    updates.push('actor_profile_url = ?');
    params.push(actorProfileUrl);
  }
  if (actorProfileKey && !existing.actor_profile_key) {
    updates.push('actor_profile_key = ?');
    params.push(actorProfileKey);
  }
  if (rawPayloadJson) {
    updates.push('raw_payload_json = ?');
    params.push(rawPayloadJson);
  }
  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(existing.id);

  const result = db.prepare(`UPDATE interaction_events SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0 ? existing.id : false;
}
export function promoteUnstableEvent(id, newFingerprint, newTimeText, newPlatformEventId) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE interaction_events
    SET status = 'new', event_time_text = ?, fingerprint = ?,
        platform_event_id = COALESCE(platform_event_id, ?),
        updated_at = ?
    WHERE id = ? AND status = 'unstable'
  `).run(newTimeText || null, newFingerprint, newPlatformEventId || null, new Date().toISOString(), id);
  return result.changes > 0;
}

/**
 * Find an unstable event matching the given fingerprint (without time).
 */
export function findUnstableEvent(fingerprint) {
  const db = getDb();
  return db.prepare("SELECT * FROM interaction_events WHERE fingerprint = ? AND status = 'unstable'")
    .get(fingerprint);
}
