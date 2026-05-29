// 数据库连接管理 — 占位
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.LISHANGWANGLAI_DB_PATH || resolve(__dirname, '../../data/lishangwanglai.db');

let _db = null;

export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (!_db) {
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

export function resetDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
