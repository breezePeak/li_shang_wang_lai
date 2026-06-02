// 清空所有表数据
// 用法: npm run db:reset

import Database from 'better-sqlite3';
import { resolve } from 'path';

const DB_PATH = process.env.LISHANGWANGLAI_DB_PATH || resolve(import.meta.dirname, '../../data/lishangwanglai.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all();

if (tables.length === 0) {
  console.log('[db:reset] 没有用户表。');
  db.close();
  process.exit(0);
}

let total = 0;
for (const { name } of tables) {
  try {
    const r = db.prepare(`DELETE FROM "${name}"`).run();
    console.log(`  ${name}: ${r.changes} 条`);
    total += r.changes;
  } catch (err) {
    console.log(`  ${name}: 失败 - ${err.message}`);
  }
}

db.pragma('foreign_keys = ON');
console.log(`[db:reset] 完成，共清除 ${total} 条记录。`);
db.close();
