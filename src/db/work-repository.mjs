import { getDb } from './database.mjs';

export function upsertWorkContext(workContext) {
  const db = getDb();
  const now = new Date().toISOString();

  const {
    workId, modalId, workUrl, workTitle, workType,
    thumbnailKey, thumbnailSrc,
    authorName, authorProfileUrl, authorProfileKey,
    rawContextJson,
  } = workContext;

  if (workId) {
    const existing = db.prepare('SELECT * FROM works WHERE work_id = ?').get(workId);
    if (existing) {
      _updateWork(db, existing.id, workContext, now);
      return { action: 'enriched', id: existing.id };
    }
  }

  if (!workId && modalId) {
    const existing = db.prepare('SELECT * FROM works WHERE modal_id = ?').get(modalId);
    if (existing) {
      _updateWork(db, existing.id, workContext, now);
      return { action: 'enriched', id: existing.id };
    }
  }

  if (!workId && !modalId && thumbnailKey) {
    const existing = db.prepare('SELECT * FROM works WHERE thumbnail_key = ?').get(thumbnailKey);
    if (existing) {
      _updateWork(db, existing.id, workContext, now);
      return { action: 'enriched', id: existing.id };
    }
  }

  const stmt = db.prepare(`
    INSERT INTO works (work_id, modal_id, work_url, work_title, work_type, thumbnail_key, thumbnail_src,
      author_name, author_profile_url, author_profile_key, raw_context_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    workId || null, modalId || null, workUrl || null, workTitle || null, workType || null,
    thumbnailKey || null, thumbnailSrc || null,
    authorName || null, authorProfileUrl || null, authorProfileKey || null,
    rawContextJson || null, now, now,
  );
  return { action: 'inserted', id: result.lastInsertRowid };
}

function _updateWork(db, id, ctx, now) {
  const updates = [];
  const params = [];

  if (ctx.workTitle && ctx.workTitle.length > 0) { updates.push('work_title = ?'); params.push(ctx.workTitle); }
  if (ctx.workUrl && ctx.workUrl.length > 0) { updates.push('work_url = ?'); params.push(ctx.workUrl); }
  if (ctx.workType && ctx.workType.length > 0) { updates.push('work_type = ?'); params.push(ctx.workType); }
  if (ctx.authorName && ctx.authorName.length > 0) { updates.push('author_name = ?'); params.push(ctx.authorName); }
  if (ctx.authorProfileUrl && ctx.authorProfileUrl.length > 0) { updates.push('author_profile_url = ?'); params.push(ctx.authorProfileUrl); }
  if (ctx.authorProfileKey && ctx.authorProfileKey.length > 0) { updates.push('author_profile_key = ?'); params.push(ctx.authorProfileKey); }
  if (ctx.rawContextJson) { updates.push('raw_context_json = ?'); params.push(ctx.rawContextJson); }

  if (updates.length === 0) return;
  updates.push('last_seen_at = ?');
  params.push(now);
  params.push(id);
  db.prepare(`UPDATE works SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function findWorkByThumbnailKey(thumbnailKey) {
  const db = getDb();
  return db.prepare('SELECT * FROM works WHERE thumbnail_key = ?').get(thumbnailKey);
}

export function findWorkByModalId(modalId) {
  const db = getDb();
  return db.prepare('SELECT * FROM works WHERE modal_id = ?').get(modalId);
}

export function findWorkByWorkId(workId) {
  const db = getDb();
  return db.prepare('SELECT * FROM works WHERE work_id = ?').get(workId);
}

export function listRecentlySeenWorks(limit = 20) {
  const db = getDb();
  return db.prepare('SELECT * FROM works ORDER BY last_seen_at DESC LIMIT ?').all(limit);
}