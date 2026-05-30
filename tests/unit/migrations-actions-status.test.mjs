import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { runMigrations } from '../../src/db/migrations.mjs';
import Database from 'better-sqlite3';

const TEST_DB = '/tmp/test_lishangwanglai_actions_status.db';

afterAll(() => {
  if (existsSync(TEST_DB)) {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  }
});

describe('actions status CHECK constraint', () => {
  it('includes sent_unverified after runMigrations', () => {
    // Clean up any previous test DB
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

    runMigrations(TEST_DB);

    const db = new Database(TEST_DB);
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'"
    ).get();
    db.close();

    expect(row).toBeTruthy();
    expect(row.sql).toContain('sent_unverified');
  });
});
