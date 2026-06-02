// 清空互动数据，保留配置和任务表
// 用法: npm run db:reset

import { runMigrations } from '../db/migrations.mjs';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const DB_PATH = process.env.LISHANGWANGLAI_DB_PATH || resolve(import.meta.dirname, '../../data/lishangwanglai.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

const tables = [
  'work_comments',
  'interaction_events',
  'work_contexts',
];

console.log('[db:reset] 清空互动数据表...');
for (const t of tables) {
  try {
    const r = db.prepare(`DELETE FROM ${t}`).run();
    console.log(`  ${t}: ${r.changes} 条`);
  } catch {
    console.log(`  ${t}: 表不存在，跳过`);
  }
}

db.pragma('foreign_keys = ON');
console.log('[db:reset] 完成。配置、任务表未受影响。');
db.close();
