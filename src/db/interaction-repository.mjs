import { getDb } from './database.mjs';

/**
 * Unified upsert for notification events. Handles:
 * 1. platformEventId match → enrich
 * 2. fingerprint match → enrich
 * 3. partial match (old unresolved) → enrich
 * 4. No match → insert
 *
 * Returns { action: 'inserted'|'enriched'|'duplicate'|'ambiguous', eventId, error? }
 */
export function upsertNotificationEvent({
  eventType, actorName, actorProfileKey, actorProfileUrl, relation,
  commentText, eventTimeText, fingerprint, dedupConfidence,
  platformEventId, notificationItemKey, workId, workUrl,
  action, content, rawPayloadJson,
}) {
  const db = getDb();
  const scannedAt = new Date().toISOString();

  // ---- Step 1: Match by platformEventId ----
  if (platformEventId) {
    const byPid = db.prepare(
      'SELECT * FROM interaction_events WHERE platform_event_id = ?'
    ).get(platformEventId);
    if (byPid) {
      const enriched = _applyEnrich(byPid, { actorProfileUrl, actorProfileKey, platformEventId, fingerprint, rawPayloadJson });
      return enriched
        ? { action: 'enriched', eventId: byPid.id }
        : { action: 'duplicate', eventId: byPid.id };
    }
  }

  // ---- Step 2: Match by fingerprint ----
  const byFp = db.prepare(
    'SELECT * FROM interaction_events WHERE fingerprint = ?'
  ).get(fingerprint);
  if (byFp) {
    const enriched = _applyEnrich(byFp, { actorProfileUrl, actorProfileKey, platformEventId, fingerprint, rawPayloadJson });
    return enriched
      ? { action: 'enriched', eventId: byFp.id }
      : { action: 'duplicate', eventId: byFp.id };
  }

  // ---- Step 3: Partial match for old unresolved events ----
  if (actorProfileUrl || actorProfileKey) {
    const params = [];
    let sql = 'SELECT * FROM interaction_events WHERE event_type = ?';
    params.push(eventType);
    sql += ' AND actor_name = ?';
    params.push(actorName);
    sql += ' AND (actor_profile_url IS NULL OR actor_profile_url = \'\')';

    if (workId) {
      sql += ' AND raw_payload_json LIKE ?';
      params.push('%' + workId + '%');
    }
    if (eventType === 'comment' && commentText) {
      sql += ' AND comment_text = ?';
      params.push(commentText);
    }
    if (eventType === 'like' && action) {
      sql += ' AND raw_payload_json LIKE ?';
      params.push('%' + action + '%');
    }

    sql += ' ORDER BY created_at DESC';
    const partialMatches = db.prepare(sql).all(...params);

    if (partialMatches.length === 1) {
      const old = partialMatches[0];
      const enriched = _applyEnrich(old, { actorProfileUrl, actorProfileKey, platformEventId, fingerprint, rawPayloadJson });
      return enriched
        ? { action: 'enriched', eventId: old.id }
        : { action: 'duplicate', eventId: old.id };
    }
    if (partialMatches.length > 1) {
      return { action: 'ambiguous', eventId: null, error: `partial match returned ${partialMatches.length} results` };
    }
  }

  // ---- Step 4: Insert new event ----
  const status = dedupConfidence === 'weak' ? 'new' : 'new';
  const stmt = db.prepare(`
    INSERT INTO interaction_events
      (event_type, actor_name, actor_profile_key, actor_profile_url, relation, comment_text, event_time_text,
       platform_event_id, fingerprint, notification_item_key, raw_payload_json, scanned_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    eventType, actorName,
    actorProfileKey || null, actorProfileUrl || null, relation || 'unknown',
    commentText || null, eventTimeText || null,
    platformEventId || null, fingerprint, notificationItemKey || null,
    rawPayloadJson || null, scannedAt, status,
  );
  if (result.changes > 0) {
    return { action: 'inserted', eventId: result.lastInsertRowid };
  }
  return { action: 'duplicate', eventId: null, error: 'INSERT IGNORE returned 0 changes' };
}

/**
 * Apply enrichment to an existing event: update missing fields.
 * Returns true if any field was updated.
 */
function _applyEnrich(existing, { actorProfileUrl, actorProfileKey, platformEventId, fingerprint, rawPayloadJson }) {
  const db = getDb();
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
  if (platformEventId && !existing.platform_event_id) {
    updates.push('platform_event_id = ?');
    params.push(platformEventId);
  }
  if (fingerprint) {
    updates.push('fingerprint = ?');
    params.push(fingerprint);
  }
  if (rawPayloadJson) {
    updates.push('raw_payload_json = ?');
    params.push(rawPayloadJson);
  }
  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(existing.id);

  const result = db.prepare(
    `UPDATE interaction_events SET ${updates.join(', ')} WHERE id = ?`
  ).run(...params);
  return result.changes > 0;
}

// ---- Legacy functions kept for backward compat ----

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

export { insertEvent as _insertEvent_legacy };

export function getEvents(options = {}) {
  const db = getDb();
  const { eventType, status, limit = 100 } = options;
  let sql = 'SELECT * FROM interaction_events WHERE 1=1';
  const params = [];
  if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getEventCounts() {
  const db = getDb();
  return db.prepare('SELECT event_type, status, COUNT(*) as count FROM interaction_events GROUP BY event_type, status').all();
}

export function updateEventStatus(eventId, status) {
  const db = getDb();
  const result = db.prepare('UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), eventId);
  return result.changes > 0;
}

export function getEvent(eventId) {
  const db = getDb();
  return db.prepare('SELECT * FROM interaction_events WHERE id = ?').get(eventId);
}

export function enrichEvent({ fingerprint, actorProfileUrl, actorProfileKey, rawPayloadJson, username, action, content, workId }) {
  const db = getDb();
  let existing = db.prepare('SELECT * FROM interaction_events WHERE fingerprint = ?').get(fingerprint);
  if (!existing && username) {
    let sql = 'SELECT * FROM interaction_events WHERE event_type IS NOT NULL';
    const params = [];
    sql += ' AND actor_name = ?'; params.push(username);
    sql += ' AND (actor_profile_url IS NULL OR actor_profile_url = \'\')';
    if (workId) { sql += ' AND raw_payload_json LIKE ?'; params.push('%' + workId + '%'); }
    if (action) { sql += ' AND raw_payload_json LIKE ?'; params.push('%' + action + '%'); }
    sql += ' ORDER BY created_at DESC LIMIT 1';
    existing = db.prepare(sql).all(...params)[0];
  }
  if (!existing) return false;
  return _applyEnrich(existing, { actorProfileUrl, actorProfileKey, platformEventId: null, fingerprint, rawPayloadJson })
    ? existing.id : false;
}

export function promoteUnstableEvent(id, newFingerprint, newTimeText, newPlatformEventId) {
  const db = getDb();
  const result = db.prepare(
    'UPDATE interaction_events SET status = \'new\', event_time_text = ?, fingerprint = ?, platform_event_id = COALESCE(platform_event_id, ?), updated_at = ? WHERE id = ? AND status = \'unstable\''
  ).run(newTimeText || null, newFingerprint, newPlatformEventId || null, new Date().toISOString(), id);
  return result.changes > 0;
}

export function findUnstableEvent(fingerprint) {
  const db = getDb();
  return db.prepare("SELECT * FROM interaction_events WHERE fingerprint = ? AND status = 'unstable'").get(fingerprint);
}
