import { getDb } from './database.mjs';

export function upsertWorkComment(comment) {
  const db = getDb();
  const now = new Date().toISOString();

  const {
    workId, workUrl, modalId,
    actorName, actorProfileUrl, actorProfileKey,
    commentText, eventTimeText, commentKey,
    sourceEventId, sourceNotificationKey,
    rawCommentJson,
  } = comment;

  if (workId && commentKey) {
    const existing = db.prepare(
      'SELECT * FROM work_comments WHERE work_id = ? AND comment_key = ?'
    ).get(workId, commentKey);

    if (existing) {
      if (existing.reply_status === 'succeeded') {
        return { action: 'duplicate', id: existing.id };
      }
      const updates = [];
      const params = [];
      if (actorProfileUrl && !existing.actor_profile_url) { updates.push('actor_profile_url = ?'); params.push(actorProfileUrl); }
      if (actorProfileKey && !existing.actor_profile_key) { updates.push('actor_profile_key = ?'); params.push(actorProfileKey); }
      if (rawCommentJson) { updates.push('raw_comment_json = ?'); params.push(rawCommentJson); }
      updates.push('last_seen_at = ?');
      params.push(now);
      params.push(existing.id);
      db.prepare(`UPDATE work_comments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { action: 'enriched', id: existing.id };
    }
  }

  const stmt = db.prepare(`
    INSERT INTO work_comments (work_id, work_url, modal_id, actor_name, actor_profile_url, actor_profile_key,
      comment_text, event_time_text, comment_key, source_event_id, source_notification_key,
      reply_status, raw_comment_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);
  const result = stmt.run(
    workId || null, workUrl || null, modalId || null,
    actorName || null, actorProfileUrl || null, actorProfileKey || null,
    commentText, eventTimeText || null, commentKey,
    sourceEventId || null, sourceNotificationKey || null,
    rawCommentJson || null, now, now,
  );
  return { action: 'inserted', id: result.lastInsertRowid };
}

export function listPendingCommentsGroupedByWork(options = {}) {
  const db = getDb();
  const { limit = 100, days = null } = options;
  const params = [];
  let sql = "SELECT * FROM work_comments WHERE reply_status = 'pending'";
  if (Number(days) > 0) {
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    sql += ' AND last_seen_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY first_seen_at ASC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);

  const groups = new Map();
  for (const row of rows) {
    const key = row.work_id || row.modal_id || '__unknown__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function listPreparedComments(options = {}) {
  const db = getDb();
  const { limit = 100, days } = options;
  if (days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare(
      `SELECT wc.* FROM work_comments wc
       LEFT JOIN works w ON wc.work_id = w.work_id
       WHERE wc.reply_status = 'prepared'
         AND (w.published_at >= ? OR (w.published_at IS NULL AND wc.first_seen_at >= ?))
       ORDER BY COALESCE(w.published_at, wc.first_seen_at) ASC LIMIT ?`
    ).all(since, since, limit);
  }
  return db.prepare(
    "SELECT * FROM work_comments WHERE reply_status = 'prepared' ORDER BY first_seen_at ASC LIMIT ?"
  ).all(limit);
}

export function markCommentReplyPrepared(commentId, replyText, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'prepared', reply_text = ?, reply_reason = ?, last_seen_at = ? WHERE id = ?"
  ).run(replyText, reason || null, new Date().toISOString(), commentId);
}

export function getWorkComment(commentId) {
  const db = getDb();
  return db.prepare('SELECT * FROM work_comments WHERE id = ?').get(commentId);
}

export function markCommentReplied(commentId) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'succeeded', replied_at = ?, last_seen_at = ? WHERE id = ?"
  ).run(now, now, commentId);
}

export function markCommentSentUnverified(commentId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'sent_unverified', reply_reason = ?, last_seen_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), commentId);
}

export function markCommentBlocked(commentId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'blocked', reply_reason = ?, last_seen_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), commentId);
}

export function markCommentSkipped(commentId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'skipped', reply_reason = ?, last_seen_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), commentId);
}

export function findCommentByActorAndText(actorName, commentTextPrefix) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM work_comments WHERE actor_name = ? AND comment_text LIKE ? LIMIT 1"
  ).get(actorName, `${commentTextPrefix}%`);
}

export function listReplyTrackedCommentKeysForWork({ workId, modalId } = {}) {
  const db = getDb();
  const params = [];
  const clauses = [];
  if (workId) {
    clauses.push('work_id = ?');
    params.push(workId);
  }
  if (modalId) {
    clauses.push('modal_id = ?');
    params.push(modalId);
  }
  if (clauses.length === 0) return [];

  return db.prepare(`
    SELECT actor_name, comment_text, comment_key
    FROM work_comments
    WHERE (${clauses.join(' OR ')})
      AND reply_status IN ('prepared','succeeded','sent_unverified')
  `).all(...params).map(row => row.comment_key || `${row.actor_name || ''}::${String(row.comment_text || '').slice(0, 60)}`);
}

export function hasCommentsForWork({ workId, modalId } = {}) {
  const db = getDb();
  const params = [];
  const clauses = [];
  if (workId) {
    clauses.push('work_id = ?');
    params.push(workId);
  }
  if (modalId) {
    clauses.push('modal_id = ?');
    params.push(modalId);
  }
  if (clauses.length === 0) return false;
  const row = db.prepare(`SELECT id FROM work_comments WHERE ${clauses.join(' OR ')} LIMIT 1`).get(...params);
  return !!row;
}

export function listCommentsForDedupe(options = {}) {
  const db = getDb();
  const { days = null, limit = 5000 } = options;
  const params = [];
  let sql = `
    SELECT id, work_id, modal_id, actor_name, actor_profile_key, actor_profile_url,
      comment_text, event_time_text, comment_key, reply_status, first_seen_at, last_seen_at
    FROM work_comments
    WHERE 1=1
  `;
  if (Number(days) > 0) {
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    sql += ' AND last_seen_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY last_seen_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
