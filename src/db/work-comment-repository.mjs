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
  let sql = "SELECT * FROM work_comments WHERE reply_status = 'pending' AND (reply_text IS NULL OR reply_text = '')";
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

export function listPendingCommentsGroupedByHomepageAndWork(options = {}) {
  const db = getDb();
  const { limit = 100, days = null } = options;
  const params = [];
  let sql = `
    SELECT
      wc.*,
      COALESCE(w_by_work.work_id, w_by_modal.work_id, wc.work_id) AS joined_work_id,
      COALESCE(w_by_work.modal_id, w_by_modal.modal_id, wc.modal_id) AS joined_modal_id,
      COALESCE(w_by_work.author_name, w_by_modal.author_name) AS joined_author_name,
      COALESCE(w_by_work.author_profile_url, w_by_modal.author_profile_url) AS joined_author_profile_url,
      COALESCE(w_by_work.author_profile_key, w_by_modal.author_profile_key) AS joined_author_profile_key
    FROM work_comments wc
    LEFT JOIN works w_by_work
      ON wc.work_id IS NOT NULL
      AND wc.work_id != ''
      AND w_by_work.work_id = wc.work_id
    LEFT JOIN works w_by_modal
      ON (wc.work_id IS NULL OR wc.work_id = '' OR w_by_work.id IS NULL)
      AND wc.modal_id IS NOT NULL
      AND wc.modal_id != ''
      AND w_by_modal.modal_id = wc.modal_id
    WHERE wc.reply_status = 'pending'
      AND (wc.reply_text IS NULL OR wc.reply_text = '')
  `;

  if (Number(days) > 0) {
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    sql += ' AND wc.last_seen_at >= ?';
    params.push(since);
  }

  sql += ' ORDER BY wc.first_seen_at ASC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function saveReplyText(commentId, replyText) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_text = ?, last_seen_at = ? WHERE id = ?"
  ).run(replyText, new Date().toISOString(), commentId);
}

export function getWorkComment(commentId) {
  const db = getDb();
  return db.prepare('SELECT * FROM work_comments WHERE id = ?').get(commentId);
}

export function markCommentReplied(commentId) {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.prepare('SELECT * FROM work_comments WHERE id = ?').get(commentId);
  if (!row) return false;

  db.prepare(
    "UPDATE work_comments SET reply_status = 'succeeded', replied_at = ?, last_seen_at = ? WHERE id = ?"
  ).run(now, now, commentId);

  if (row.source_event_id) {
    db.prepare(
      "UPDATE interaction_events SET status = 'replied', updated_at = ? WHERE id = ?"
    ).run(now, row.source_event_id);
  }
  return true;
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

export function findCommentByWorkActorAndText({ workId, modalId, actorName, commentText } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (workId) {
    clauses.push('work_id = ?');
    params.push(workId);
  }
  if (modalId) {
    clauses.push('modal_id = ?');
    params.push(modalId);
  }
  if (clauses.length === 0 || !actorName || !commentText) return null;
  return db.prepare(`
    SELECT * FROM work_comments
    WHERE (${clauses.join(' OR ')})
      AND actor_name = ?
      AND comment_text = ?
    LIMIT 1
  `).get(...params, actorName, commentText);
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
      AND reply_status IN ('succeeded','sent_unverified')
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

export function findCollectedCommentForWork({ workId, modalId, actorName, commentText } = {}) {
  const db = getDb();
  const workClauses = [];
  const params = [];
  if (workId) {
    workClauses.push('work_id = ?');
    params.push(workId);
  }
  if (modalId) {
    workClauses.push('modal_id = ?');
    params.push(modalId);
  }
  if (workClauses.length === 0 || !actorName || !commentText) return null;

  return db.prepare(`
    SELECT id, work_id, modal_id, actor_name, comment_text, comment_key, reply_status
    FROM work_comments
    WHERE (${workClauses.join(' OR ')})
      AND actor_name = ?
      AND comment_text = ?
    LIMIT 1
  `).get(...params, actorName, commentText);
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
