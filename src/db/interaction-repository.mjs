import { getDb } from './database.mjs';

/**
 * Insert a new interaction event. Returns the inserted row id.
 * Skips if fingerprint already exists (duplicate).
 */
export function insertEvent({ eventType, actorName, actorProfileKey, relation, myWorkTitle, commentText, eventTimeText, fingerprint }) {
  const db = getDb();
  const scannedAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO interaction_events
      (event_type, actor_name, actor_profile_key, relation, my_work_title, comment_text, event_time_text, fingerprint, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(eventType, actorName, actorProfileKey || null, relation || 'unknown', myWorkTitle || null, commentText || null, eventTimeText || null, fingerprint, scannedAt);
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
