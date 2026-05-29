// 动作请求数据层 — 统一管理 actions 表的 CRUD
// 替代旧的手工编辑 JSON 计划方式，提供命令式审批流程支持。

import { getDb } from './database.mjs';

/**
 * 创建一条待处理动作（状态为 'prepared'）
 * @returns {number} actionId
 */
export function createAction({ eventId, actionType, targetTitle, targetUrl = null, actionText = '' }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO actions (event_id, action_type, target_title, target_url, action_text, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'prepared', ?)
  `).run(eventId, actionType, targetTitle, targetUrl, actionText, new Date().toISOString());

  return result.lastInsertRowid;
}

/**
 * 审批一条动作（状态改为 'approved'）
 * @returns {boolean} 是否成功
 */
export function approveAction(actionId) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE actions SET status = 'approved' WHERE id = ? AND status = 'prepared'
  `).run(actionId);

  return result.changes > 0;
}

/**
 * 二次确认发送（dry-run 成功后，用户明确说"发送"）
 * 状态从 dry_run_ok 变为 execute_confirmed
 */
export function confirmExecuteAction(actionId) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE actions SET status = 'execute_confirmed' WHERE id = ? AND status = 'dry_run_ok'
  `).run(actionId);

  return result.changes > 0;
}

/**
 * 更新动作状态（dry_run_ok, succeeded, blocked, skipped 等）
 */
export function updateActionStatus(actionId, status, reason = null, evidenceJson = null, screenshotPath = null) {
  const db = getDb();
  const now = new Date().toISOString();

  // Only set executed_at on succeeded — it means "actually sent"
  if (status === 'succeeded') {
    const result = db.prepare(`
      UPDATE actions SET status = ?, reason = ?, evidence_json = ?, screenshot_path = ?, executed_at = ?
      WHERE id = ?
    `).run(status, reason, evidenceJson, screenshotPath, now, actionId);
    return result.changes > 0;
  }

  const result = db.prepare(`
    UPDATE actions SET status = ?, reason = ?, evidence_json = ?, screenshot_path = ?
    WHERE id = ?
  `).run(status, reason, evidenceJson, screenshotPath, actionId);
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
 * 检查某事件是否已有活跃的同类动作（prepared/approved/dry_run_ok/execute_confirmed）
 */
export function hasActiveAction(eventId, actionType) {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM actions
     WHERE event_id = ? AND action_type = ?
       AND status IN ('prepared', 'approved', 'dry_run_ok', 'execute_confirmed')
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
