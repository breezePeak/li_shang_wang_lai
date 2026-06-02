// 清空数据库表数据工具
// 用法:
//   npm run db:reset                    → 交互模式，列出所有表并选择
//   npm run db:reset -- --all           → 列出所有表，确认后全部清空
//   npm run db:reset -- --all --force   → 跳过确认，直接全部清空

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { createInterface } from 'readline';

const DB_PATH = process.env.LISHANGWANGLAI_DB_PATH || resolve(import.meta.dirname, '../../data/lishangwanglai.db');

function parseArgs(argv) {
  const args = { all: false, force: false };
  for (const a of argv) {
    if (a === '--all') args.all = true;
    if (a === '--force') args.force = true;
  }
  return args;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// 列出所有用户表及行数
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(t => ({
  name: t.name,
  count: db.prepare(`SELECT count(*) as c FROM "${t.name}"`).get().c,
}));

if (tables.length === 0) {
  console.log('数据库中没有用户表。');
  db.close();
  process.exit(0);
}

console.log('\n数据库表：');
const pad = Math.max(...tables.map(t => t.name.length));
tables.forEach((t, i) => {
  console.log(`  [${i + 1}] ${t.name.padEnd(pad + 2)} ${t.count} 条`);
});

const args = parseArgs(process.argv.slice(2));

let selected = [];

if (args.all) {
  selected = tables.map(t => t.name);
  const total = tables.reduce((s, t) => s + t.count, 0);
  console.log(`\n已选择全部 ${tables.length} 张表（共 ${total} 条记录）。`);
} else {
  const input = await ask('\n输入要清空的表序号（逗号分隔，如 1,3,5），输入 all 清空全部: ');
  if (input.toLowerCase() === 'all') {
    selected = tables.map(t => t.name);
  } else {
    const indices = input.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= tables.length);
    if (indices.length === 0) {
      console.log('未选择任何表。退出。');
      db.close();
      process.exit(0);
    }
    selected = indices.map(i => tables[i - 1].name);
  }
}

const totalRows = tables.filter(t => selected.includes(t.name)).reduce((s, t) => s + t.count, 0);
console.log(`\n将清空: ${selected.join(', ')}（共约 ${totalRows} 条记录）`);

if (!args.force) {
  const confirm = await ask('确认清空？输入 y 继续: ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('已取消。');
    db.close();
    process.exit(0);
  }
}

db.pragma('foreign_keys = OFF');
let cleared = 0;

for (const name of selected) {
  try {
    const r = db.prepare(`DELETE FROM "${name}"`).run();
    console.log(`  ${name}: ${r.changes} 条已清除`);
    cleared += r.changes;
  } catch (err) {
    console.log(`  ${name}: 清除失败 - ${err.message}`);
  }
}

db.pragma('foreign_keys = ON');
console.log(`\n完成。共清除 ${cleared} 条记录。`);
db.close();
