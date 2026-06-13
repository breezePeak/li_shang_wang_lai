import { getDb } from './database.mjs';
import { resolveTimeWindowSinceIso } from '../utils/time-window.mjs';

export function upsertWorkComment(comment) {
  const db = getDb();
  const now = new Date().toISOString();

  const {
    workId, workUrl, modalId,
    actorName, actorProfileUrl, actorProfileKey,
    commentText, eventTimeText, eventCreatedAt, commentKey,
    sourceEventId, sourceNotificationKey,
    rawCommentJson,
  } = comment;

  if (workId && commentKey) {
    const existing = db.prepare(
      'SELECT * FROM work_comments WHERE work_id = ? AND comment_key = ?'
    ).get(workId, commentKey);

    if (existing) {
      if (existing.reply_status === 'succeeded' || existing.reply_status === 'manually_replied') {
        return { action: 'duplicate', id: existing.id };
      }
      const updates = [];
      const params = [];
      if (existing.reply_status !== 'pending' && existing.reply_status !== 'prepared') {
        updates.push("reply_status = 'pending'");
        updates.push('reply_reason = NULL');
      }
      if (actorProfileUrl && !existing.actor_profile_url) { updates.push('actor_profile_url = ?'); params.push(actorProfileUrl); }
      if (actorProfileKey && !existing.actor_profile_key) { updates.push('actor_profile_key = ?'); params.push(actorProfileKey); }
      if (rawCommentJson) { updates.push('raw_comment_json = ?'); params.push(rawCommentJson); }
      updates.push('last_seen_at = ?');
      params.push(now);
      params.push(existing.id);
      db.prepare(`UPDATE work_comments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { action: existing.reply_status !== 'pending' ? 'reopened' : 'enriched', id: existing.id };
    }
  }

  const firstSeenAt = eventCreatedAt || now;

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
    rawCommentJson || null, firstSeenAt, now,
  );
  return { action: 'inserted', id: result.lastInsertRowid };
}

export function listPendingCommentsGroupedByWork(options = {}) {
  const db = getDb();
  const { limit = null } = options;
  const params = [];
  let sql = "SELECT * FROM work_comments WHERE reply_status = 'pending'";
  const since = resolveTimeWindowSinceIso(options);
  if (since) {
    sql += ' AND COALESCE(first_seen_at, last_seen_at) >= ?';
    params.push(since);
  }
  sql += ' ORDER BY COALESCE(first_seen_at, last_seen_at) DESC, id DESC';
  if (Number(limit) > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
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
  const { limit = null } = options;
  const params = [];
  let sql = `
    SELECT
      wc.*,
      COALESCE(w_by_work.work_id, w_by_modal.work_id, wc.work_id) AS joined_work_id,
      COALESCE(w_by_work.modal_id, w_by_modal.modal_id, wc.modal_id) AS joined_modal_id,
      COALESCE(w_by_work.work_url, w_by_modal.work_url, wc.work_url) AS joined_work_url,
      COALESCE(w_by_work.work_title, w_by_modal.work_title) AS joined_work_title,
      COALESCE(w_by_work.work_desc, w_by_modal.work_desc) AS joined_work_desc,
      COALESCE(w_by_work.work_type, w_by_modal.work_type) AS joined_work_type,
      COALESCE(w_by_work.thumbnail_key, w_by_modal.thumbnail_key) AS joined_thumbnail_key,
      COALESCE(w_by_work.thumbnail_src, w_by_modal.thumbnail_src) AS joined_thumbnail_src,
      COALESCE(w_by_work.author_name, w_by_modal.author_name) AS joined_author_name,
      COALESCE(w_by_work.author_profile_url, w_by_modal.author_profile_url) AS joined_author_profile_url,
      COALESCE(w_by_work.author_profile_key, w_by_modal.author_profile_key) AS joined_author_profile_key,
      COALESCE(w_by_work.published_at, w_by_modal.published_at) AS joined_published_at
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
  `;

  const since = resolveTimeWindowSinceIso(options);
  if (since) {
    sql += ' AND COALESCE(wc.first_seen_at, wc.last_seen_at) >= ?';
    params.push(since);
  }

  sql += `
    ORDER BY
      CASE WHEN wc.reply_reason IS NULL OR wc.reply_reason = '' THEN 0 ELSE 1 END,
      COALESCE(wc.first_seen_at, wc.last_seen_at) DESC,
      wc.id DESC
  `;
  if (Number(limit) > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  return db.prepare(sql).all(...params);
}

export function saveReplyText(commentId, replyText) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_text = ?, reply_reason = NULL, last_seen_at = ? WHERE id = ?"
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
    "UPDATE work_comments SET reply_status = 'succeeded', reply_reason = NULL, replied_at = ?, last_seen_at = ? WHERE id = ?"
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

export function markCommentManuallyReplied(commentId, reason = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.prepare('SELECT * FROM work_comments WHERE id = ?').get(commentId);
  if (!row) return false;

  db.prepare(
    "UPDATE work_comments SET reply_status = 'manually_replied', reply_reason = ?, replied_at = ?, last_seen_at = ? WHERE id = ?"
  ).run(reason || 'author already replied', now, now, commentId);

  if (row.source_event_id) {
    db.prepare(
      "UPDATE interaction_events SET status = 'replied', updated_at = ? WHERE id = ?"
    ).run(now, row.source_event_id);
  }
  return true;
}

export function markCommentPending(commentId, reason = null) {
  const db = getDb();
  db.prepare(
    "UPDATE work_comments SET reply_status = 'pending', reply_reason = ?, last_seen_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), commentId);
}

export function updateCommentReplyState(commentId, { replyStatus = null, replyText = undefined, replyReason = undefined } = {}) {
  const db = getDb();
  const allowedStatuses = new Set(['pending', 'blocked', 'sent_unverified', 'skipped']);
  const updates = ['last_seen_at = ?'];
  const params = [new Date().toISOString()];

  if (replyStatus !== null) {
    const status = String(replyStatus || '').trim();
    if (!allowedStatuses.has(status)) throw new Error(`不支持的 reply_status: ${status}`);
    updates.push('reply_status = ?');
    params.push(status);
  }

  if (replyText !== undefined) {
    updates.push('reply_text = ?');
    params.push(String(replyText || '').trim() || null);
  }

  if (replyReason !== undefined) {
    updates.push('reply_reason = ?');
    params.push(String(replyReason || '').trim() || null);
  } else if (replyStatus === 'pending') {
    updates.push('reply_reason = NULL');
  }

  params.push(commentId);
  const result = db.prepare(`UPDATE work_comments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
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
      AND reply_status IN ('succeeded','sent_unverified','manually_replied')
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
  const { limit = 5000 } = options;
  const params = [];
  let sql = `
    SELECT id, work_id, modal_id, actor_name, actor_profile_key, actor_profile_url,
      comment_text, event_time_text, comment_key, reply_status, first_seen_at, last_seen_at
    FROM work_comments
    WHERE 1=1
  `;
  const since = resolveTimeWindowSinceIso(options);
  if (since) {
    sql += ' AND last_seen_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY last_seen_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
