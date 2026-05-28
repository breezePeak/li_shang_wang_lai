import { getDb } from './database.mjs';

export function createPlan({ planType, mode = 'manual', payload }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO action_plans (plan_type, mode, status, payload_json, created_at)
    VALUES (?, ?, 'draft', ?, ?)
  `);
  const result = stmt.run(planType, mode, JSON.stringify(payload), new Date().toISOString());
  return result.lastInsertRowid;
}

export function getPlan(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM action_plans WHERE id = ?').get(id);
  if (row) {
    try { row.payload = JSON.parse(row.payload_json); } catch { row.payload = null; }
  }
  return row;
}

export function getPlans({ planType, status, limit = 50 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM action_plans WHERE 1=1';
  const params = [];
  if (planType) { sql += ' AND plan_type = ?'; params.push(planType); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(row => {
    try { row.payload = JSON.parse(row.payload_json); } catch { row.payload = null; }
    return row;
  });
}

export function updatePlanStatus(id, status) {
  const db = getDb();
  const updates = { status };
  if (status === 'approved') updates.approved_at = new Date().toISOString();
  if (status === 'executed') updates.executed_at = new Date().toISOString();
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(id);
  db.prepare(`UPDATE action_plans SET ${sets} WHERE id = ?`).run(...values);
}
