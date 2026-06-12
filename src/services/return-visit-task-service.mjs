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
  RETURN_VISIT_STATUS.COMMENT_GENERATED,
  RETURN_VISIT_STATUS.FAILED_COLLECT,
  RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
];

export const RETURN_VISIT_EXECUTE_RETRY_STATUS = [
  RETURN_VISIT_STATUS.PENDING_VISIT,
  RETURN_VISIT_STATUS.PENDING_EXECUTE,
  RETURN_VISIT_STATUS.EXECUTING,
  RETURN_VISIT_STATUS.FAILED_COLLECT,
  RETURN_VISIT_STATUS.FAILED_GENERATE_COMMENT,
  RETURN_VISIT_STATUS.FAILED_LIKE,
  RETURN_VISIT_STATUS.FAILED_COMMENT,
];

export const RETURN_VISIT_SCAN_STATUS = [
  RETURN_VISIT_STATUS.PENDING_VISIT,
  RETURN_VISIT_STATUS.FAILED_COLLECT,
];

export const RETURN_VISIT_REOPEN_WINDOW_MS = 4 * 60 * 60 * 1000;

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

function parseJsonObject(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseTargetWorkSummary(raw) {
  const meta = parseJsonObject(raw);
  if (!meta || meta.metaVersion !== 1) {
    return {
      contentSummary: raw || null,
      meta: {},
    };
  }
  return {
    contentSummary: meta.contentSummary || null,
    meta,
  };
}

function buildTargetWorkSummaryValue(targetWork = {}) {
  const metadata = {
    metaVersion: 1,
    contentSummary: targetWork.contentSummary || null,
    shareUrl: targetWork.shareUrl || null,
    desc: targetWork.desc || null,
    itemTitle: targetWork.itemTitle || null,
    createTime: targetWork.createTime || null,
    isTop: targetWork.isTop ?? null,
    userDigged: targetWork.userDigged ?? null,
    diggCount: targetWork.diggCount ?? null,
    commentCount: targetWork.commentCount ?? null,
    awemeType: targetWork.awemeType ?? null,
    mediaType: targetWork.mediaType ?? null,
    isMultiContent: targetWork.isMultiContent ?? null,
  };
  return JSON.stringify(metadata);
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

function getTaskVisitAnchorMs(taskOrRow) {
  const executedAtMs = Date.parse(taskOrRow?.executed_at || taskOrRow?.executedAt || '');
  if (Number.isFinite(executedAtMs)) return executedAtMs;
  const updatedAtMs = Date.parse(taskOrRow?.updated_at || taskOrRow?.updatedAt || '');
  if (Number.isFinite(updatedAtMs)) return updatedAtMs;
  return 0;
}

function shouldResetTaskForNewInteraction(taskOrRow, nowMs = Date.now()) {
  if (!RETURN_VISIT_TERMINAL_STATUS.has(taskOrRow?.status)) return true;
  const anchorMs = getTaskVisitAnchorMs(taskOrRow);
  if (!(anchorMs > 0)) return true;
  return nowMs - anchorMs >= RETURN_VISIT_REOPEN_WINDOW_MS;
}

function buildSourcePlatformEventIdIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    for (const platformId of parseJsonArray(row.source_platform_event_ids_json)) {
      const key = String(platformId || '').trim();
      if (!key || index.has(key)) continue;
      index.set(key, row);
    }
  }
  return index;
}

function prepareTaskSource(source = {}) {
  const relation = String(source.relation || '').trim().toLowerCase();
  const userId = String(source.userId || source.user_id || source.actor_profile_key || source.targetUserId || '').trim() || null;
  const userProfileUrl = normalizeDouyinUrl(
    source.userProfileUrl || source.user_profile_url || source.actor_profile_url || source.profileUrl || source.homepage_url || ''
  ) || null;
  const userName = String(source.userName || source.user_name || source.actor_name || source.nickname || '').trim();
  const identityKey = buildIdentityKey({ userId, userProfileUrl, userName });
  const sourceType = normalizeEventSourceType(source.sourceType || source.source_type || source.eventType || source.event_type || source.interactionType);
  const sourceEventId = source.sourceEventId ?? source.source_event_id ?? source.event_id ?? source.eventId ?? source.interactionId ?? null;
  const sourcePlatformEventId = String(
    source.sourcePlatformEventId ??
    source.source_platform_event_id ??
    source.platformEventId ??
    source.platform_event_id ??
    ''
  ).trim() || null;
  const canUseSourceTargetWork = sourceType === 'reply';
  const targetWorkId = canUseSourceTargetWork
    ? String(source.targetWorkId || source.target_work_id || source.workId || source.work_id || '').trim() || null
    : null;
  const targetWorkUrl = canUseSourceTargetWork
    ? normalizeDouyinUrl(source.targetWorkUrl || source.target_work_url || source.workUrl || source.work_url || '') || null
    : null;

  return {
    relation,
    userId,
    userProfileUrl,
    userName,
    identityKey,
    sourceType,
    sourceEventId,
    sourcePlatformEventId,
    targetWorkId,
    targetWorkUrl,
  };
}

function createOrUpdateReturnVisitTasksFromSources(rawSources = []) {
  const db = getDb();
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  let inserted = 0;
  let enriched = 0;
  let skipped = 0;
  let skippedPlatformDuplicate = 0;
  let skippedWindow = 0;
  let reopened = 0;

  const existingRows = db.prepare('SELECT * FROM return_visit_tasks').all();
  const rowsByIdentity = new Map(existingRows.map(row => [row.identity_key, row]));
  const sourcePlatformEventIdIndex = buildSourcePlatformEventIdIndex(existingRows);
  const insertStmt = db.prepare(`
    INSERT INTO return_visit_tasks (
      task_id, identity_key, user_id, user_name, user_profile_url,
      source_type, source_types_json, source_event_ids_json, source_platform_event_ids_json,
      action_type, status, target_work_id, target_work_url, like_status, comment_status,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      'like_and_comment', ?, ?, ?, 'pending', 'pending',
      ?, ?
    )
  `);

  for (const rawSource of rawSources || []) {
    const source = prepareTaskSource(rawSource);
    if (source.relation && source.relation !== 'friend' && source.relation !== 'mutual') {
      skipped++;
      continue;
    }
    if (!source.identityKey) {
      skipped++;
      continue;
    }

    if (source.sourcePlatformEventId && sourcePlatformEventIdIndex.has(source.sourcePlatformEventId)) {
      skipped++;
      skippedPlatformDuplicate++;
      continue;
    }

    const existing = rowsByIdentity.get(source.identityKey) || null;
    if (!existing) {
      const taskId = buildTaskId(source.identityKey);
      const insertedRow = {
        id: null,
        task_id: taskId,
        identity_key: source.identityKey,
        user_id: source.userId,
        user_name: source.userName || '(unknown)',
        user_profile_url: source.userProfileUrl,
        source_type: source.sourceType,
        source_types_json: JSON.stringify([source.sourceType]),
        source_event_ids_json: JSON.stringify(source.sourceEventId != null ? [source.sourceEventId] : []),
        source_platform_event_ids_json: JSON.stringify(source.sourcePlatformEventId ? [source.sourcePlatformEventId] : []),
        action_type: 'like_and_comment',
        status: RETURN_VISIT_STATUS.PENDING_VISIT,
        target_work_id: source.targetWorkId,
        target_work_url: source.targetWorkUrl,
        like_status: 'pending',
        comment_status: 'pending',
        created_at: now,
        updated_at: now,
      };
      const insertResult = insertStmt.run(
        insertedRow.task_id,
        insertedRow.identity_key,
        insertedRow.user_id,
        insertedRow.user_name,
        insertedRow.user_profile_url,
        insertedRow.source_type,
        insertedRow.source_types_json,
        insertedRow.source_event_ids_json,
        insertedRow.source_platform_event_ids_json,
        insertedRow.status,
        insertedRow.target_work_id,
        insertedRow.target_work_url,
        insertedRow.created_at,
        insertedRow.updated_at
      );
      insertedRow.id = insertResult.lastInsertRowid;
      rowsByIdentity.set(source.identityKey, insertedRow);
      if (source.sourcePlatformEventId) {
        sourcePlatformEventIdIndex.set(source.sourcePlatformEventId, insertedRow);
      }
      inserted++;
      continue;
    }

    const mergedSourceTypes = toUniqueArray([
      ...parseJsonArray(existing.source_types_json),
      source.sourceType,
    ]);
    const mergedSourceEventIds = toUniqueArray([
      ...parseJsonArray(existing.source_event_ids_json),
      ...(source.sourceEventId != null ? [source.sourceEventId] : []),
    ]);
    const mergedSourcePlatformEventIds = toUniqueArray([
      ...parseJsonArray(existing.source_platform_event_ids_json),
      ...(source.sourcePlatformEventId ? [source.sourcePlatformEventId] : []),
    ]);
    const nextSourceType = mergeSourceType(existing.source_type || 'other', source.sourceType);
    const updateCols = [
      'source_type = ?',
      'source_types_json = ?',
      'source_event_ids_json = ?',
      'source_platform_event_ids_json = ?',
      'updated_at = ?',
    ];
    const params = [
      nextSourceType,
      JSON.stringify(mergedSourceTypes),
      JSON.stringify(mergedSourceEventIds),
      JSON.stringify(mergedSourcePlatformEventIds),
      now,
    ];

    if (source.userId && !existing.user_id) {
      updateCols.push('user_id = ?');
      params.push(source.userId);
      existing.user_id = source.userId;
    }
    if (source.userProfileUrl && !existing.user_profile_url) {
      updateCols.push('user_profile_url = ?');
      params.push(source.userProfileUrl);
      existing.user_profile_url = source.userProfileUrl;
    }
    if (source.userName && (!existing.user_name || existing.user_name === '(unknown)')) {
      updateCols.push('user_name = ?');
      params.push(source.userName);
      existing.user_name = source.userName;
    }
    if (source.targetWorkId && !existing.target_work_id) {
      updateCols.push('target_work_id = ?');
      params.push(source.targetWorkId);
      existing.target_work_id = source.targetWorkId;
    }
    if (source.targetWorkUrl && !existing.target_work_url) {
      updateCols.push('target_work_url = ?');
      params.push(source.targetWorkUrl);
      existing.target_work_url = source.targetWorkUrl;
    }

    let countedAsReopened = false;
    if (source.sourcePlatformEventId && RETURN_VISIT_TERMINAL_STATUS.has(existing.status)) {
      if (shouldResetTaskForNewInteraction(existing, nowMs)) {
        updateCols.push('status = ?');
        params.push(RETURN_VISIT_STATUS.PENDING_VISIT);
        updateCols.push('target_work_title = NULL');
        updateCols.push('target_work_text = NULL');
        updateCols.push('target_work_summary = NULL');
        updateCols.push('target_work_publish_time = NULL');
        updateCols.push('reference_comments_json = NULL');
        updateCols.push('generated_comment = NULL');
        updateCols.push('like_status = ?');
        params.push('pending');
        updateCols.push('comment_status = ?');
        params.push('pending');
        updateCols.push('collected_at = NULL');
        updateCols.push('generated_at = NULL');
        updateCols.push('executed_at = NULL');
        updateCols.push('last_error = NULL');
        updateCols.push('retry_count = 0');
        existing.status = RETURN_VISIT_STATUS.PENDING_VISIT;
        existing.like_status = 'pending';
        existing.comment_status = 'pending';
        existing.executed_at = null;
        existing.collected_at = null;
        existing.generated_at = null;
        existing.last_error = null;
        existing.retry_count = 0;
        countedAsReopened = true;
        reopened++;
      } else {
        const skipUpdateCols = [
          'source_type = ?',
          'source_types_json = ?',
          'source_event_ids_json = ?',
          'source_platform_event_ids_json = ?',
        ];
        const skipParams = [
          nextSourceType,
          JSON.stringify(mergedSourceTypes),
          JSON.stringify(mergedSourceEventIds),
          JSON.stringify(mergedSourcePlatformEventIds),
        ];
        if (source.userId && !existing.user_id) {
          skipUpdateCols.push('user_id = ?');
          skipParams.push(source.userId);
          existing.user_id = source.userId;
        }
        if (source.userProfileUrl && !existing.user_profile_url) {
          skipUpdateCols.push('user_profile_url = ?');
          skipParams.push(source.userProfileUrl);
          existing.user_profile_url = source.userProfileUrl;
        }
        if (source.userName && (!existing.user_name || existing.user_name === '(unknown)')) {
          skipUpdateCols.push('user_name = ?');
          skipParams.push(source.userName);
          existing.user_name = source.userName;
        }
        if (source.targetWorkId && !existing.target_work_id) {
          skipUpdateCols.push('target_work_id = ?');
          skipParams.push(source.targetWorkId);
          existing.target_work_id = source.targetWorkId;
        }
        if (source.targetWorkUrl && !existing.target_work_url) {
          skipUpdateCols.push('target_work_url = ?');
          skipParams.push(source.targetWorkUrl);
          existing.target_work_url = source.targetWorkUrl;
        }
        skipParams.push(existing.id);
        db.prepare(`UPDATE return_visit_tasks SET ${skipUpdateCols.join(', ')} WHERE id = ?`).run(...skipParams);
        existing.source_type = nextSourceType;
        existing.source_types_json = JSON.stringify(mergedSourceTypes);
        existing.source_event_ids_json = JSON.stringify(mergedSourceEventIds);
        existing.source_platform_event_ids_json = JSON.stringify(mergedSourcePlatformEventIds);
        rowsByIdentity.set(source.identityKey, existing);
        sourcePlatformEventIdIndex.set(source.sourcePlatformEventId, existing);
        skipped++;
        skippedWindow++;
        continue;
      }
    }

    params.push(existing.id);
    db.prepare(`UPDATE return_visit_tasks SET ${updateCols.join(', ')} WHERE id = ?`).run(...params);

    existing.source_type = nextSourceType;
    existing.source_types_json = JSON.stringify(mergedSourceTypes);
    existing.source_event_ids_json = JSON.stringify(mergedSourceEventIds);
    existing.source_platform_event_ids_json = JSON.stringify(mergedSourcePlatformEventIds);
    existing.updated_at = now;
    rowsByIdentity.set(source.identityKey, existing);
    if (source.sourcePlatformEventId) {
      sourcePlatformEventIdIndex.set(source.sourcePlatformEventId, existing);
    }
    enriched++;
    if (countedAsReopened) {
      existing.updated_at = now;
    }
  }

  return {
    inserted,
    enriched,
    skipped,
    reopened,
    skippedPlatformDuplicate,
    skippedWindow,
  };
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
  const targetSummary = parseTargetWorkSummary(row.target_work_summary);
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
    sourcePlatformEventIds: parseJsonArray(row.source_platform_event_ids_json),
    actionType: row.action_type,
    status: row.status,
    targetWork: {
      workId: row.target_work_id,
      workUrl: row.target_work_url,
      workTitle: row.target_work_title,
      workText: row.target_work_text,
      contentSummary: targetSummary.contentSummary,
      publishTime: row.target_work_publish_time,
      shareUrl: targetSummary.meta.shareUrl || null,
      desc: targetSummary.meta.desc || row.target_work_text || null,
      itemTitle: targetSummary.meta.itemTitle || row.target_work_title || null,
      createTime: targetSummary.meta.createTime || null,
      isTop: targetSummary.meta.isTop ?? null,
      userDigged: targetSummary.meta.userDigged ?? null,

      diggCount: targetSummary.meta.diggCount ?? null,
      commentCount: targetSummary.meta.commentCount ?? null,
      awemeType: targetSummary.meta.awemeType ?? null,
      mediaType: targetSummary.meta.mediaType ?? null,
      isMultiContent: targetSummary.meta.isMultiContent ?? null,
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

function getSourceEvents({ status = 'new' } = {}) {
  const db = getDb();
  const params = [];
  let sql = "SELECT * FROM interaction_events WHERE event_type IN ('like','comment')";
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

export function createOrUpdateReturnVisitTasksFromEvents(options = {}) {
  const {
    status = 'new',
  } = options;

  const events = getSourceEvents({ status });
  const summary = createOrUpdateReturnVisitTasksFromSources(events.map(event => ({
    relation: event.relation,
    actor_profile_key: event.actor_profile_key,
    actor_profile_url: event.actor_profile_url,
    actor_name: event.actor_name,
    event_type: event.event_type,
    source_event_id: event.id,
    source_platform_event_id: event.platform_event_id,
    target_work_id: event.target_work_id,
    target_work_url: event.target_work_url,
  })));
  return {
    totalEvents: events.length,
    ...summary,
  };
}

export function createOrUpdateReturnVisitTasksFromItems(items = []) {
  return {
    totalItems: items.length,
    ...createOrUpdateReturnVisitTasksFromSources(items),
  };
}

function listTasksByStatuses(statuses, { maxRetryCount = 2 } = {}) {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(',');
  const params = [...statuses, maxRetryCount];
  const sql = `
    SELECT * FROM return_visit_tasks
    WHERE status IN (${placeholders})
      AND retry_count <= ?
    ORDER BY updated_at ASC, id ASC
  `;
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

export function listReturnVisitTasksByIds(taskIds = []) {
  const ids = Array.from(new Set((taskIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM return_visit_tasks WHERE task_id IN (${placeholders})`).all(...ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows
    .map(mapRowToTask)
    .sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
}

export function listReturnVisitPendingPrepareTasksByIds(taskIds = [], {
  days = null,
  limit = null,
  maxRetryCount = 2,
} = {}) {
  const ids = Array.from(new Set((taskIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (ids.length === 0) {
    return {
      tasks: [],
      candidateCount: 0,
      filteredStatusCount: 0,
      filteredDaysCount: 0,
    };
  }

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT *
    FROM return_visit_tasks
    WHERE task_id IN (${placeholders})
      AND retry_count <= ?
      AND user_profile_url IS NOT NULL
      AND TRIM(user_profile_url) != ''
    ORDER BY updated_at ASC, id ASC
  `).all(...ids, maxRetryCount);

  const statusSet = new Set(RETURN_VISIT_SCAN_STATUS);
  const nowMs = Date.now();
  const minUpdatedAtMs = Number(days || 0) > 0 ? nowMs - Number(days) * 86400000 : null;
  let filteredStatusCount = 0;
  let filteredDaysCount = 0;
  const tasks = [];

  for (const row of rows) {
    if (!statusSet.has(row.status)) {
      filteredStatusCount++;
      continue;
    }

    if (minUpdatedAtMs !== null) {
      const updatedAtMs = Date.parse(row.updated_at || '');
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < minUpdatedAtMs) {
        filteredDaysCount++;
        continue;
      }
    }

    tasks.push(mapRowToTask(row));
    if (Number(limit) > 0 && tasks.length >= limit) break;
  }

  return {
    tasks,
    candidateCount: rows.length,
    filteredStatusCount,
    filteredDaysCount,
  };
}

/**
 * 从数据库全量查询待回访任务（不限定本轮 taskIds）。
 *
 * 状态过滤：只输出 pending_visit / failed_collect。
 * 不输出 content_collected / comment_generated / pending_execute 等后续阶段状态，
 * 也不输出 done / skipped_* / failed_like / failed_comment 等终态。
 *
 * @param {Object} options
 * @param {number|null} options.days - 时间窗口（天），基于 updated_at，>0 生效
 * @param {number} options.limit - 最大输出条数
 * @param {number} options.maxRetryCount - 最大重试次数
 * @returns {{ tasks: Array, candidateCount: number, filteredStatusCount: number, filteredDaysCount: number }}
 */
export function listReturnVisitScanTasks({
  days = null,
  limit = null,
  maxRetryCount = 2,
} = {}) {
  const db = getDb();
  const statusSet = new Set(RETURN_VISIT_SCAN_STATUS);
  const nowMs = Date.now();
  const minUpdatedAtMs = Number(days || 0) > 0 ? nowMs - Number(days) * 86400000 : null;

  const allRows = db.prepare(`
    SELECT *
    FROM return_visit_tasks
    WHERE retry_count <= ?
      AND user_profile_url IS NOT NULL
      AND TRIM(user_profile_url) != ''
    ORDER BY updated_at ASC, id ASC
  `).all(maxRetryCount);

  const candidateCount = allRows.length;
  let filteredStatusCount = 0;
  let filteredDaysCount = 0;
  const tasks = [];

  for (const row of allRows) {
    if (!statusSet.has(row.status)) {
      filteredStatusCount++;
      continue;
    }

    if (minUpdatedAtMs !== null) {
      const updatedAtMs = Date.parse(row.updated_at || '');
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < minUpdatedAtMs) {
        filteredDaysCount++;
        continue;
      }
    }

    tasks.push(mapRowToTask(row));
    if (Number(limit) > 0 && tasks.length >= limit) break;
  }

  return {
    tasks,
    candidateCount,
    filteredStatusCount,
    filteredDaysCount,
  };
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
  if (Object.prototype.hasOwnProperty.call(patch, 'sourcePlatformEventIds')) {
    setCol('source_platform_event_ids_json', JSON.stringify(toUniqueArray(patch.sourcePlatformEventIds)));
  }
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
    const needsMetaSummary = [
      'contentSummary', 'shareUrl', 'desc', 'itemTitle', 'createTime', 'isTop',
      'userDigged', 'diggCount', 'commentCount', 'awemeType',
      'mediaType', 'isMultiContent',
    ].some(key => Object.prototype.hasOwnProperty.call(targetWork, key));
    if (needsMetaSummary) setCol('target_work_summary', buildTargetWorkSummaryValue(targetWork));
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
