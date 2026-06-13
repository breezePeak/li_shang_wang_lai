import { getDb } from './database.mjs';
import { resolveTimeWindowSinceIso } from '../utils/time-window.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

const KEY_FIELD_MAP = [
  { dbCol: 'actor_profile_url', inKey: 'actorProfileUrl' },
  { dbCol: 'actor_profile_key', inKey: 'actorProfileKey' },
  { dbCol: 'platform_event_id', inKey: 'platformEventId' },
  { dbCol: 'relation', inKey: 'relation' },
  { dbCol: 'target_work_id', inKey: 'targetWorkId' },
  { dbCol: 'target_work_url', inKey: 'targetWorkUrl' },
  { dbCol: 'dedup_confidence', inKey: 'dedupConfidence' },
  { dbCol: 'profile_resolution_status', inKey: 'profileResolutionStatus' },
  { dbCol: 'my_work_title', inKey: 'myWorkTitle' },
];

function _isRelationUpgrade(existingRelation, newRelation) {
  if (!newRelation) return false;
  if (existingRelation === 'unknown' && (newRelation === 'friend' || newRelation === 'mutual')) return true;
  if (existingRelation === 'friend' && newRelation === 'mutual') return true;
  return false;
}

const CONFIDENCE_ORDER = { weak: 1, medium: 2, strong: 3 };

function _isConfidenceUpgrade(existingConfidence, newConfidence) {
  const existingLevel = CONFIDENCE_ORDER[existingConfidence] || 0;
  const newLevel = CONFIDENCE_ORDER[newConfidence] || 0;
  return newLevel > existingLevel;
}

function _isKeyFieldEnrichment(existing, incoming) {
  for (const { dbCol, inKey } of KEY_FIELD_MAP) {
    if (dbCol === 'relation') {
      if (_isRelationUpgrade(existing.relation, incoming.relation)) return true;
    } else if (dbCol === 'dedup_confidence') {
      if (incoming[inKey] && _isConfidenceUpgrade(existing[dbCol], incoming[inKey])) return true;
    } else {
      if (incoming[inKey] && !existing[dbCol]) return true;
    }
  }
  return false;
}

/**
 * Unified upsert for notification events. Handles:
 * 1. platformEventId match → exact match → enrich or duplicate
 * 2. fingerprint match → enrich or duplicate
 * 3. partial match (only with workId) → enrich, ambiguous, or skip
 *    — platformEventId is for exact match only (step 1); new events with
 *      platformEventId but no workId that miss step 1 are inserted as new.
 *    — weak events (no platformEventId and no workId) MUST NOT auto-merge.
 * 4. No match → insert
 *
 * Returns { action: 'inserted'|'enriched'|'duplicate'|'ambiguous', eventId, error? }
 */
export function upsertNotificationEvent({
  eventType, actorName, actorProfileKey, actorProfileUrl, relation,
  commentText, eventTimeText, eventCreatedAt, fingerprint, dedupConfidence,
  platformEventId, notificationItemKey, workId, workUrl,
  action, content, rawPayloadJson,
  targetWorkId, targetWorkUrl, profileResolutionStatus,
  myWorkTitle,
}) {
  const db = getDb();
  const scannedAt = new Date().toISOString();

  // Normalize incoming URLs to clean form before writing
  const normalizedActorUrl = normalizeDouyinUrl(actorProfileUrl);
  const normalizedWorkUrl = normalizeDouyinUrl(workUrl);
  const normalizedTargetUrl = normalizeDouyinUrl(targetWorkUrl);

  const incoming = {
    actorProfileUrl: normalizedActorUrl,
    actorProfileKey, platformEventId, fingerprint,
    relation: relation || 'unknown',
    targetWorkId: targetWorkId || (workId || null),
    targetWorkUrl: normalizedTargetUrl || normalizedWorkUrl || null,
    dedupConfidence, profileResolutionStatus,
    myWorkTitle,
  };

  // ---- Step 1: Match by platformEventId ----
  if (platformEventId) {
    const byPid = db.prepare(
      'SELECT * FROM interaction_events WHERE platform_event_id = ?'
    ).get(platformEventId);
    if (byPid) {
      if (!_isKeyFieldEnrichment(byPid, incoming)) {
        return { action: 'duplicate', eventId: byPid.id };
      }
      _applyEnrich(byPid, { ...incoming, rawPayloadJson });
      return { action: 'enriched', eventId: byPid.id };
    }
  }

  // ---- Step 2: Match by fingerprint ----
  const byFp = db.prepare(
    'SELECT * FROM interaction_events WHERE fingerprint = ?'
  ).get(fingerprint);
  if (byFp) {
    if (!_isKeyFieldEnrichment(byFp, incoming)) {
      return { action: 'duplicate', eventId: byFp.id };
    }
    _applyEnrich(byFp, { ...incoming, rawPayloadJson });
    return { action: 'enriched', eventId: byFp.id };
  }

  // ---- Step 3: Partial match — ONLY when workId provides a unique discriminator ----
  // platformEventId is for exact match only (Step 1); it must NOT be used to guess-match old events.
  // New events with platformEventId but no workId that can't find exact match are inserted as new.
  const hasWorkId = !!(workId || '').trim();

  if (hasWorkId) {
    const params = [];
    let sql = 'SELECT * FROM interaction_events WHERE event_type = ?';
    params.push(eventType);
    sql += ' AND actor_name = ?';
    params.push(actorName);
    sql += ' AND (actor_profile_url IS NULL OR actor_profile_url = \'\')';
    sql += ' AND target_work_id = ?';
    params.push(workId);
    if (eventType === 'comment' && commentText) {
      sql += ' AND comment_text = ?';
      params.push(commentText);
    }

    sql += ' ORDER BY created_at DESC';
    const partialMatches = db.prepare(sql).all(...params);

    if (partialMatches.length === 1) {
      const old = partialMatches[0];
      if (_isKeyFieldEnrichment(old, incoming)) {
        _applyEnrich(old, { ...incoming, rawPayloadJson, fingerprint });
        return { action: 'enriched', eventId: old.id };
      }
      return { action: 'duplicate', eventId: old.id };
    }
    if (partialMatches.length > 1) {
      return { action: 'ambiguous', eventId: null, error: `partial match returned ${partialMatches.length} results` };
    }
  }

  // ---- Step 4: Insert new event ----
  const stmt = db.prepare(`
    INSERT INTO interaction_events
      (event_type, actor_name, actor_profile_key, actor_profile_url, relation, my_work_title, comment_text, event_time_text,
       platform_event_id, fingerprint, notification_item_key,
       target_work_id, target_work_url, dedup_confidence, profile_resolution_status,
       raw_payload_json, created_at, scanned_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    eventType, actorName,
    actorProfileKey || null, normalizedActorUrl || null, relation || 'unknown',
    myWorkTitle || null,
    commentText || null, eventTimeText || null,
    platformEventId || null, fingerprint, notificationItemKey || null,
    incoming.targetWorkId, incoming.targetWorkUrl,
    dedupConfidence || null, profileResolutionStatus || null,
    rawPayloadJson || null, eventCreatedAt || scannedAt, scannedAt, 'new',
  );
  if (result.changes > 0) {
    return { action: 'inserted', eventId: result.lastInsertRowid };
  }
  return { action: 'duplicate', eventId: null, error: 'INSERT returned 0 changes' };
}

/**
 * Apply enrichment to an existing event: update missing key fields + metadata.
 * Only updates fields that are actually new or upgraded.
 */
function _applyEnrich(existing, { actorProfileUrl, actorProfileKey, platformEventId, fingerprint,
  rawPayloadJson, relation, targetWorkId, targetWorkUrl, dedupConfidence, profileResolutionStatus,
  myWorkTitle }) {
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
  if (_isRelationUpgrade(existing.relation, relation)) {
    updates.push('relation = ?');
    params.push(relation);
  }
  if (targetWorkId && !existing.target_work_id) {
    updates.push('target_work_id = ?');
    params.push(targetWorkId);
  }
  if (targetWorkUrl && !existing.target_work_url) {
    updates.push('target_work_url = ?');
    params.push(targetWorkUrl);
  }
  if (myWorkTitle && !existing.my_work_title) {
    updates.push('my_work_title = ?');
    params.push(myWorkTitle);
  }
  if (dedupConfidence && _isConfidenceUpgrade(existing.dedup_confidence, dedupConfidence)) {
    updates.push('dedup_confidence = ?');
    params.push(dedupConfidence);
  }
  if (profileResolutionStatus && profileResolutionStatus !== 'unresolved' &&
      (!existing.profile_resolution_status || existing.profile_resolution_status === 'unresolved')) {
    updates.push('profile_resolution_status = ?');
    params.push(profileResolutionStatus);
  }
  if (rawPayloadJson) {
    updates.push('raw_payload_json = ?');
    params.push(rawPayloadJson);
  }

  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(existing.id);

  db.prepare(
    `UPDATE interaction_events SET ${updates.join(', ')} WHERE id = ?`
  ).run(...params);
  return true;
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

export function listEventsForDedupe(options = {}) {
  const db = getDb();
  const { limit = 2000 } = options;
  const params = [];
  let sql = `
    SELECT id, event_type, actor_name, actor_profile_key, actor_profile_url,
      comment_text, event_time_text, platform_event_id, notification_item_key,
      fingerprint, target_work_id, target_work_url, scanned_at
    FROM interaction_events
    WHERE 1=1
  `;
  const since = resolveTimeWindowSinceIso(options);
  if (since) {
    sql += ' AND scanned_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY scanned_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function enrichEvent({ fingerprint, actorProfileUrl, actorProfileKey, rawPayloadJson, username, action, content, workId }) {
  const db = getDb();
  let existing = db.prepare('SELECT * FROM interaction_events WHERE fingerprint = ?').get(fingerprint);
  if (!existing && username) {
    let sql = 'SELECT * FROM interaction_events WHERE event_type IS NOT NULL';
    const params = [];
    sql += ' AND actor_name = ?'; params.push(username);
    sql += ' AND (actor_profile_url IS NULL OR actor_profile_url = \'\')';
    if (workId) { sql += ' AND target_work_id = ?'; params.push(workId); }
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
