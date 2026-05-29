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
    UPDATE actions SET status = 'approved', executed_at = ? WHERE id = ? AND status = 'prepared'
  `).run(new Date().toISOString(), actionId);

  return result.changes > 0;
}

/**
 * 更新动作状态（dry_run_ok, succeeded, blocked, skipped 等）
 */
export function updateActionStatus(actionId, status, reason = null, evidenceJson = null, screenshotPath = null) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE actions SET status = ?, reason = ?, evidence_json = ?, screenshot_path = ?, executed_at = ?
    WHERE id = ?
  `).run(status, reason, evidenceJson, screenshotPath, new Date().toISOString(), actionId);

  return result.changes > 0;
}

/**
 * 查询单条动作
 */
export function getAction(actionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
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
