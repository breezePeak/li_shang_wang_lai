import { getDb } from './database.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

export function getRevisitKey(candidate) {
  const key = candidate.actorProfileKey || normalizeDouyinUrl(candidate.actorProfileUrl) || candidate.actorName;
  return key || null;
}

export function upsertRevisitCandidate(candidate) {
  const db = getDb();
  const now = new Date().toISOString();

  const revisitKey = getRevisitKey(candidate);
  if (!revisitKey) return { action: 'skipped', reason: 'no_key' };

  const reason = candidate.reason || 'unknown';
  if (reason !== 'comment_on_my_work' && reason !== 'like_received') {
    return { action: 'skipped', reason: 'disallowed_reason' };
  }

  const existing = db.prepare('SELECT * FROM revisit_candidates WHERE revisit_key = ?').get(revisitKey);

  if (existing) {
    if (existing.status === 'succeeded') {
      return { action: 'duplicate', id: existing.id };
    }

    const updates = [];
    const params = [];

    let reasons = [];
    try { reasons = JSON.parse(existing.reasons_json || '[]'); } catch {}
    if (!reasons.includes(reason)) { reasons.push(reason); }
    updates.push('reasons_json = ?');
    params.push(JSON.stringify(reasons));

    if (candidate.eventId) {
      let eventIds = [];
      try { eventIds = JSON.parse(existing.event_ids_json || '[]'); } catch {}
      if (!eventIds.includes(candidate.eventId)) { eventIds.push(candidate.eventId); }
      updates.push('event_ids_json = ?');
      params.push(JSON.stringify(eventIds));
    }

    if (candidate.rawText) {
      let comments = [];
      try { comments = JSON.parse(existing.comments_json || '[]'); } catch {}
      if (!comments.includes(candidate.rawText)) { comments.push(candidate.rawText); }
      updates.push('comments_json = ?');
      params.push(JSON.stringify(comments));
    }

    if (candidate.actorName && !existing.actor_name) { updates.push('actor_name = ?'); params.push(candidate.actorName); }
    if (candidate.actorProfileUrl && !existing.actor_profile_url) { updates.push('actor_profile_url = ?'); params.push(candidate.actorProfileUrl); }
    if (candidate.actorProfileKey && !existing.actor_profile_key) { updates.push('actor_profile_key = ?'); params.push(candidate.actorProfileKey); }

    updates.push('updated_at = ?');
    params.push(now);
    params.push(existing.id);
    db.prepare(`UPDATE revisit_candidates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return { action: 'enriched', id: existing.id };
  }

  const stmt = db.prepare(`
    INSERT INTO revisit_candidates (actor_name, actor_profile_url, actor_profile_key, revisit_key,
      reasons_json, event_ids_json, comments_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const result = stmt.run(
    candidate.actorName || null,
    candidate.actorProfileUrl || null,
    candidate.actorProfileKey || null,
    revisitKey,
    JSON.stringify([reason]),
    candidate.eventId ? JSON.stringify([candidate.eventId]) : null,
    candidate.rawText ? JSON.stringify([candidate.rawText]) : null,
    now, now,
  );
  return { action: 'inserted', id: result.lastInsertRowid };
}

export function listPendingRevisitCandidates(options = {}) {
  const db = getDb();
  const { limit = 20 } = options;
  return db.prepare(
    "SELECT * FROM revisit_candidates WHERE status = 'pending' ORDER BY updated_at ASC LIMIT ?"
  ).all(limit);
}

export function markRevisitDone(candidateId) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE revisit_candidates SET status = 'succeeded', visited_at = ?, updated_at = ? WHERE id = ?"
  ).run(now, now, candidateId);
}

export function markRevisitSkipped(candidateId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE revisit_candidates SET status = 'skipped', last_reason = ?, updated_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), candidateId);
}

export function markRevisitBlocked(candidateId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE revisit_candidates SET status = 'blocked', last_reason = ?, updated_at = ? WHERE id = ?"
  ).run(reason || null, new Date().toISOString(), candidateId);
}