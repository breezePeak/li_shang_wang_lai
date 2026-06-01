// 动作请求数据层 — 统一管理 actions 表的 CRUD。

import { getDb } from './database.mjs';

/**
 * 创建一条待处理动作（状态为 'prepared'）
 * @returns {number} actionId
 */
export function createAction({ eventId, actionType, targetTitle, targetUrl = null, actionText = '', evidenceJson = null }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO actions (event_id, action_type, target_title, target_url, action_text, evidence_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)
  `).run(eventId, actionType, targetTitle, targetUrl, actionText, evidenceJson, new Date().toISOString());

  return result.lastInsertRowid;
}

/**
 * 更新动作状态（succeeded, blocked, skipped 等）
 * Preserves existing evidence_json when none provided; merges runtime audit fields.
 */
export function updateActionStatus(actionId, status, reason = null, evidenceJson = null, screenshotPath = null) {
  const db = getDb();
  const now = new Date().toISOString();

  // Merge with existing evidence_json: preserve policy audit fields
  let mergedEvidence = evidenceJson;
  if (!evidenceJson) {
    // Keep existing evidence_json to preserve policyDecision audit trail
    const existing = db.prepare('SELECT evidence_json FROM actions WHERE id = ?').get(actionId);
    if (existing && existing.evidence_json) {
      mergedEvidence = existing.evidence_json;
    }
  } else {
    // Merge new runtime fields into existing policy audit
    const existing = db.prepare('SELECT evidence_json FROM actions WHERE id = ?').get(actionId);
    if (existing && existing.evidence_json) {
      try {
        const oldAudit = JSON.parse(existing.evidence_json);
        const newAudit = JSON.parse(evidenceJson);
        mergedEvidence = JSON.stringify({ ...oldAudit, ...newAudit });
      } catch {
        mergedEvidence = evidenceJson;
      }
    }
  }

  // Append audit timeline timestamp for specific state transitions.
  // CRITICAL: must merge into mergedEvidence (not re-read from DB) to preserve
  // the policy+runtime fields that were already merged above.
  if (status === 'succeeded') {
    const audit = mergedEvidence ? JSON.parse(mergedEvidence) : {};
    audit.executedAt = now;
    mergedEvidence = JSON.stringify(audit);
  }

  if (status === 'succeeded') {
    const result = db.prepare(`
      UPDATE actions SET status = ?, reason = ?, evidence_json = ?, screenshot_path = ?, executed_at = ?
      WHERE id = ?
    `).run(status, reason, mergedEvidence, screenshotPath, now, actionId);
    return result.changes > 0;
  }

  const result = db.prepare(`
    UPDATE actions SET status = ?, reason = ?, evidence_json = ?, screenshot_path = ?
    WHERE id = ?
  `).run(status, reason, mergedEvidence, screenshotPath, actionId);
  return result.changes > 0;
}

/**
 * 查询单条动作（基本字段，不关联 events）
 */
export function getAction(actionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
}

/**
 * 查询单条动作（关联原始事件数据）
 * 返回 { id, eventId, actionType, targetTitle, actionText, status,
 *         commentText, actorName, workTitle, eventStatus }
 */
export function getActionWithEvent(actionId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      a.id as actionId,
      a.event_id as eventId,
      a.action_type as actionType,
      a.target_title as targetTitle,
      a.action_text as actionText,
      a.status,
      e.comment_text as commentText,
      e.actor_name as actorName,
      e.my_work_title as workTitle,
      e.event_time_text as eventTimeText,
      e.status as eventStatus
    FROM actions a
    LEFT JOIN interaction_events e ON a.event_id = e.id
    WHERE a.id = ?
  `).get(actionId);
}

/**
 * 检查某事件是否已有活跃的同类动作（prepared）
 */
export function hasActiveAction(eventId, actionType) {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM actions
     WHERE event_id = ? AND action_type = ?
       AND status = 'prepared'
     LIMIT 1`
  ).get(eventId, actionType);
  return !!row;
}

/**
 * 查询指定状态的 actions
 */
export function getActionsByStatus(status, limit = 50) {
  const db = getDb();
  return db.prepare('SELECT * FROM actions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
}

/**
 * 检查某事件是否已有成功的同类动作
 */
export function hasSucceededAction(eventId, actionType) {
  const db = getDb();
  const row = db.prepare(
    "SELECT id FROM actions WHERE event_id = ? AND action_type = ? AND status = 'succeeded'"
  ).get(eventId, actionType);
  return !!row;
}
