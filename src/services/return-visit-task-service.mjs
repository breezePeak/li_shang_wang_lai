import { createHash } from 'crypto';
import { getDb } from '../db/database.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';

export const RETURN_VISIT_STATUS = Object.freeze({
  PENDING_VISIT: 'pending_visit',
  COLLECTING_CONTENT: 'collecting_content',
  CONTENT_COLLECTED: 'content_collected',
  COMMENT_GENERATED: 'comment_generated',
  PENDING_EXECUTE: 'pending_execute',
  EXECUTING: 'executing',
  DONE: 'done',
  SKIPPED_NO_WORK: 'skipped_no_work',
  SKIPPED_PRIVATE: 'skipped_private',
  SKIPPED_NO_SUITABLE_WORK: 'skipped_no_suitable_work',
  FAILED_COLLECT: 'failed_collect',
  FAILED_GENERATE_COMMENT: 'failed_generate_comment',
  FAILED_LIKE: 'failed_like',
  FAILED_COMMENT: 'failed_comment',
  FAILED: 'failed',
});

export const RETURN_VISIT_TERMINAL_STATUS = new Set([
  RETURN_VISIT_STATUS.DONE,
  RETURN_VISIT_STATUS.SKIPPED_NO_WORK,
  RETURN_VISIT_STATUS.SKIPPED_PRIVATE,
  RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
  RETURN_VISIT_STATUS.FAILED,
]);

export const RETURN_VISIT_PREPARE_RETRY_STATUS = [
  RETURN_VISIT_STATUS.PENDING_VISIT,
  RETURN_VISIT_STATUS.COLLECTING_CONTENT,
  RETURN_VISIT_STATUS.CONTENT_COLLECTED,
  RETURN_VISIT_STATUS.COMMENT_GENERATED,
  RETURN_VISIT_STATUS.FAILED_COLLECT,
  RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
];

export const RETURN_VISIT_EXECUTE_RETRY_STATUS = [
  RETURN_VISIT_STATUS.PENDING_EXECUTE,
  RETURN_VISIT_STATUS.EXECUTING,
  RETURN_VISIT_STATUS.FAILED_COLLECT,
  RETURN_VISIT_STATUS.FAILED_LIKE,
  RETURN_VISIT_STATUS.FAILED_COMMENT,
];

const SOURCE_PRIORITY = {
  other: 1,
  follow: 2,
  reply: 3,
  comment: 3,
  like: 3,
};

const VALID_LIKE_STATUS = new Set(['pending', 'already_liked', 'liked', 'failed']);
const VALID_COMMENT_STATUS = new Set(['pending', 'generated', 'posted', 'failed']);

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toUniqueArray(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values || []) {
    if (value === null || value === undefined || value === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function normalizeEventSourceType(eventType) {
  const v = String(eventType || '').toLowerCase();
  if (v === 'like') return 'like';
  if (v === 'comment') return 'comment';
  if (v === 'reply') return 'reply';
  if (v === 'follow') return 'follow';
  return 'other';
}

function mergeSourceType(existing, incoming) {
  const a = SOURCE_PRIORITY[existing] || 0;
  const b = SOURCE_PRIORITY[incoming] || 0;
  return b > a ? incoming : existing;
}

function sanitizeLikeStatus(value) {
  return VALID_LIKE_STATUS.has(value) ? value : 'pending';
}

function sanitizeCommentStatus(value) {
  return VALID_COMMENT_STATUS.has(value) ? value : 'pending';
}

export function buildIdentityKey({ userId, userProfileUrl, userName }) {
  const id = String(userId || '').trim();
  if (id) return `uid:${id}`;

  const normalizedUrl = normalizeDouyinUrl(userProfileUrl || '');
  if (normalizedUrl) return `url:${normalizedUrl}`;

  const name = String(userName || '').trim();
  if (name) return `name:${name}`;
  return null;
}

export function buildTaskId(identityKey) {
  const hash = createHash('sha1').update(String(identityKey || '')).digest('hex').slice(0, 16);
  return `return_visit_${hash}`;
}

export function canMarkDone({ likeStatus, commentStatus }) {
  return (likeStatus === 'liked' || likeStatus === 'already_liked') && commentStatus === 'posted';
}

function mapRowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    identityKey: row.identity_key,
    userId: row.user_id,
    userName: row.user_name,
    userProfileUrl: row.user_profile_url,
    sourceType: row.source_type,
    sourceTypes: parseJsonArray(row.source_types_json),
    sourceEventIds: parseJsonArray(row.source_event_ids_json),
    actionType: row.action_type,
    status: row.status,
    targetWork: {
      workId: row.target_work_id,
      workUrl: row.target_work_url,
      workTitle: row.target_work_title,
      workText: row.target_work_text,
      contentSummary: row.target_work_summary,
      publishTime: row.target_work_publish_time,
    },
    referenceComments: parseJsonArray(row.reference_comments_json),
    generatedComment: row.generated_comment,
    likeStatus: row.like_status,
    commentStatus: row.comment_status,
    collectedAt: row.collected_at,
    generatedAt: row.generated_at,
    executedAt: row.executed_at,
    retryCount: Number(row.retry_count || 0),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTaskRowByTaskId(taskId) {
  const db = getDb();
  return db.prepare('SELECT * FROM return_visit_tasks WHERE task_id = ?').get(taskId);
}

function getSourceEvents({ limit = 500, status = 'new', days = null } = {}) {
  const db = getDb();
  const params = [];
  let sql = "SELECT * FROM interaction_events WHERE event_type IN ('like','comment')";
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (Number(days) > 0) {
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    sql += ' AND scanned_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function createOrUpdateReturnVisitTasksFromEvents(options = {}) {
  const {
    limit = 500,
    status = 'new',
    days = null,
  } = options;

  const db = getDb();
  const now = new Date().toISOString();
  const events = getSourceEvents({ limit, status, days });
  let inserted = 0;
  let enriched = 0;
  let skipped = 0;

  const selectStmt = db.prepare('SELECT * FROM return_visit_tasks WHERE identity_key = ?');
  const insertStmt = db.prepare(`
    INSERT INTO return_visit_tasks (
      task_id, identity_key, user_id, user_name, user_profile_url,
      source_type, source_types_json, source_event_ids_json,
      action_type, status, like_status, comment_status,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      'like_and_comment', ?, 'pending', 'pending',
      ?, ?
    )
  `);

  for (const event of events) {
    const relation = String(event.relation || '').trim().toLowerCase();
    if (relation !== 'friend' && relation !== 'mutual') {
      skipped++;
      continue;
    }

    const userId = String(event.actor_profile_key || '').trim() || null;
    const userProfileUrl = normalizeDouyinUrl(event.actor_profile_url || '') || null;
    const userName = String(event.actor_name || '').trim();
    const identityKey = buildIdentityKey({ userId, userProfileUrl, userName });
    if (!identityKey) {
      skipped++;
      continue;
    }

    const sourceType = normalizeEventSourceType(event.event_type);
    const existing = selectStmt.get(identityKey);

    if (!existing) {
      const taskId = buildTaskId(identityKey);
      insertStmt.run(
        taskId,
        identityKey,
        userId,
        userName || '(unknown)',
        userProfileUrl,
        sourceType,
        JSON.stringify([sourceType]),
        JSON.stringify([event.id]),
        RETURN_VISIT_STATUS.PENDING_VISIT,
        now,
        now
      );
      inserted++;
      continue;
    }

    const mergedSourceTypes = toUniqueArray([
      ...parseJsonArray(existing.source_types_json),
      sourceType,
    ]);
    const mergedSourceEventIds = toUniqueArray([
      ...parseJsonArray(existing.source_event_ids_json),
      event.id,
    ]);
    const nextSourceType = mergeSourceType(existing.source_type || 'other', sourceType);

    const updateCols = [];
    const params = [];

    updateCols.push('source_type = ?');
    params.push(nextSourceType);
    updateCols.push('source_types_json = ?');
    params.push(JSON.stringify(mergedSourceTypes));
    updateCols.push('source_event_ids_json = ?');
    params.push(JSON.stringify(mergedSourceEventIds));

    if (userId && !existing.user_id) {
      updateCols.push('user_id = ?');
      params.push(userId);
    }
    if (userProfileUrl && !existing.user_profile_url) {
      updateCols.push('user_profile_url = ?');
      params.push(userProfileUrl);
    }
    if (userName && (!existing.user_name || existing.user_name === '(unknown)')) {
      updateCols.push('user_name = ?');
      params.push(userName);
    }

    updateCols.push('updated_at = ?');
    params.push(now);
    params.push(existing.id);

    db.prepare(`UPDATE return_visit_tasks SET ${updateCols.join(', ')} WHERE id = ?`).run(...params);
    enriched++;
  }

  return {
    totalEvents: events.length,
    inserted,
    enriched,
    skipped,
  };
}

export function createOrUpdateReturnVisitTasksFromItems(items = []) {
  const db = getDb();
  const now = new Date().toISOString();
  let inserted = 0;
  let enriched = 0;
  let skipped = 0;

  const selectStmt = db.prepare('SELECT * FROM return_visit_tasks WHERE identity_key = ?');
  const insertStmt = db.prepare(`
    INSERT INTO return_visit_tasks (
      task_id, identity_key, user_id, user_name, user_profile_url,
      source_type, source_types_json, source_event_ids_json,
      action_type, status, like_status, comment_status,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      'like_and_comment', ?, 'pending', 'pending',
      ?, ?
    )
  `);

  for (const item of items || []) {
    const relation = String(item.relation || '').trim().toLowerCase();
    if (relation && relation !== 'friend' && relation !== 'mutual') {
      skipped++;
      continue;
    }

    const userId = String(item.actor_profile_key || item.user_id || '').trim() || null;
    const userProfileUrl = normalizeDouyinUrl(item.actor_profile_url || item.user_profile_url || '') || null;
    const userName = String(item.actor_name || item.user_name || '').trim();
    const identityKey = buildIdentityKey({ userId, userProfileUrl, userName });
    if (!identityKey) {
      skipped++;
      continue;
    }

    const sourceType = normalizeEventSourceType(item.source_type || item.event_type);
    const sourceEventId = item.source_event_id || item.event_id || null;
    const existing = selectStmt.get(identityKey);

    if (!existing) {
      const taskId = buildTaskId(identityKey);
      insertStmt.run(
        taskId,
        identityKey,
        userId,
        userName || '(unknown)',
        userProfileUrl,
        sourceType,
        JSON.stringify([sourceType]),
        JSON.stringify(sourceEventId ? [sourceEventId] : []),
        RETURN_VISIT_STATUS.PENDING_VISIT,
        now,
        now
      );
      inserted++;
      continue;
    }

    const mergedSourceTypes = toUniqueArray([
      ...parseJsonArray(existing.source_types_json),
      sourceType,
    ]);
    const mergedSourceEventIds = toUniqueArray([
      ...parseJsonArray(existing.source_event_ids_json),
      ...(sourceEventId ? [sourceEventId] : []),
    ]);
    const nextSourceType = mergeSourceType(existing.source_type || 'other', sourceType);
    const updateCols = [
      'source_type = ?',
      'source_types_json = ?',
      'source_event_ids_json = ?',
      'updated_at = ?',
    ];
    const params = [
      nextSourceType,
      JSON.stringify(mergedSourceTypes),
      JSON.stringify(mergedSourceEventIds),
      now,
    ];
    if (userId && !existing.user_id) {
      updateCols.push('user_id = ?');
      params.push(userId);
    }
    if (userProfileUrl && !existing.user_profile_url) {
      updateCols.push('user_profile_url = ?');
      params.push(userProfileUrl);
    }
    if (userName && (!existing.user_name || existing.user_name === '(unknown)')) {
      updateCols.push('user_name = ?');
      params.push(userName);
    }
    params.push(existing.id);
    db.prepare(`UPDATE return_visit_tasks SET ${updateCols.join(', ')} WHERE id = ?`).run(...params);
    enriched++;
  }

  return {
    totalItems: items.length,
    inserted,
    enriched,
    skipped,
  };
}

function listTasksByStatuses(statuses, { limit = 20, maxRetryCount = 2, days = null } = {}) {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(',');
  const params = [...statuses, maxRetryCount];
  let sql = `
    SELECT * FROM return_visit_tasks
    WHERE status IN (${placeholders})
      AND retry_count <= ?
  `;
  if (Number(days) > 0) {
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    sql += ' AND updated_at >= ?';
    params.push(since);
  }
  sql += ' ORDER BY updated_at ASC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapRowToTask);
}

export function listReturnVisitPrepareTasks(options = {}) {
  return listTasksByStatuses(RETURN_VISIT_PREPARE_RETRY_STATUS, options);
}

export function listReturnVisitExecuteTasks(options = {}) {
  return listTasksByStatuses(RETURN_VISIT_EXECUTE_RETRY_STATUS, options);
}

export function getReturnVisitTask(taskId) {
  return mapRowToTask(getTaskRowByTaskId(taskId));
}

export function updateReturnVisitTask(taskId, patch = {}) {
  const db = getDb();
  const updates = [];
  const params = [];

  const setCol = (col, value) => {
    updates.push(`${col} = ?`);
    params.push(value);
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) setCol('status', patch.status);
  if (Object.prototype.hasOwnProperty.call(patch, 'userId')) setCol('user_id', patch.userId || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'userName')) setCol('user_name', patch.userName || '(unknown)');
  if (Object.prototype.hasOwnProperty.call(patch, 'userProfileUrl')) setCol('user_profile_url', normalizeDouyinUrl(patch.userProfileUrl || '') || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceType')) setCol('source_type', patch.sourceType || 'other');
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceTypes')) setCol('source_types_json', JSON.stringify(toUniqueArray(patch.sourceTypes)));
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceEventIds')) setCol('source_event_ids_json', JSON.stringify(toUniqueArray(patch.sourceEventIds)));
  if (Object.prototype.hasOwnProperty.call(patch, 'generatedComment')) setCol('generated_comment', patch.generatedComment || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'likeStatus')) setCol('like_status', sanitizeLikeStatus(patch.likeStatus));
  if (Object.prototype.hasOwnProperty.call(patch, 'commentStatus')) setCol('comment_status', sanitizeCommentStatus(patch.commentStatus));
  if (Object.prototype.hasOwnProperty.call(patch, 'collectedAt')) setCol('collected_at', patch.collectedAt || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'generatedAt')) setCol('generated_at', patch.generatedAt || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'executedAt')) setCol('executed_at', patch.executedAt || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'retryCount')) setCol('retry_count', Number(patch.retryCount || 0));
  if (Object.prototype.hasOwnProperty.call(patch, 'lastError')) setCol('last_error', patch.lastError || null);
  if (Object.prototype.hasOwnProperty.call(patch, 'referenceComments')) {
    setCol('reference_comments_json', JSON.stringify(toUniqueArray(patch.referenceComments)));
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'targetWork')) {
    const targetWork = patch.targetWork || {};
    if (Object.prototype.hasOwnProperty.call(targetWork, 'workId')) setCol('target_work_id', targetWork.workId || null);
    if (Object.prototype.hasOwnProperty.call(targetWork, 'workUrl')) setCol('target_work_url', targetWork.workUrl || null);
    if (Object.prototype.hasOwnProperty.call(targetWork, 'workTitle')) setCol('target_work_title', targetWork.workTitle || null);
    if (Object.prototype.hasOwnProperty.call(targetWork, 'workText')) setCol('target_work_text', targetWork.workText || null);
    if (Object.prototype.hasOwnProperty.call(targetWork, 'contentSummary')) setCol('target_work_summary', targetWork.contentSummary || null);
    if (Object.prototype.hasOwnProperty.call(targetWork, 'publishTime')) setCol('target_work_publish_time', targetWork.publishTime || null);
  }

  if (updates.length === 0) {
    return getReturnVisitTask(taskId);
  }

  setCol('updated_at', new Date().toISOString());
  params.push(taskId);
  db.prepare(`UPDATE return_visit_tasks SET ${updates.join(', ')} WHERE task_id = ?`).run(...params);
  return getReturnVisitTask(taskId);
}

export function markReturnVisitFailure(task, { status, error, likeStatus, commentStatus } = {}) {
  const retryCount = Number(task.retryCount || 0) + 1;
  const finalStatus = retryCount > 2 ? RETURN_VISIT_STATUS.FAILED : (status || RETURN_VISIT_STATUS.FAILED);
  return updateReturnVisitTask(task.taskId, {
    status: finalStatus,
    retryCount,
    lastError: error || 'unknown_error',
    likeStatus: likeStatus || task.likeStatus,
    commentStatus: commentStatus || task.commentStatus,
  });
}

export function markReturnVisitDone(task, { likeStatus, commentStatus } = {}) {
  const finalLike = likeStatus || task.likeStatus;
  const finalComment = commentStatus || task.commentStatus;
  if (!canMarkDone({ likeStatus: finalLike, commentStatus: finalComment })) {
    return updateReturnVisitTask(task.taskId, {
      status: RETURN_VISIT_STATUS.FAILED,
      lastError: 'done_condition_not_met',
      likeStatus: finalLike,
      commentStatus: finalComment,
    });
  }
  return updateReturnVisitTask(task.taskId, {
    status: RETURN_VISIT_STATUS.DONE,
    likeStatus: finalLike,
    commentStatus: finalComment,
    executedAt: new Date().toISOString(),
    lastError: null,
  });
}
