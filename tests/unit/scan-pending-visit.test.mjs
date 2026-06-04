import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { getDb, resetDb } from '../../src/db/database.mjs';
import { runMigrations } from '../../src/db/migrations.mjs';
import { buildIdentityKey, buildTaskId } from '../../src/services/return-visit-task-service.mjs';
import { writePendingVisitJson } from '../../src/cli/scan-interactions.mjs';

const TEST_DB = resolve('data', 'test-scan-pending-visit.db');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function makeEvent(overrides = {}) {
  return {
    eventId: null,
    eventType: 'like',
    actorName: '默认用户',
    actorProfileUrl: 'https://www.douyin.com/user/default-user',
    actorProfileKey: 'default-user',
    relation: 'friend',
    notificationAction: 'like_received',
    dbAction: 'inserted',
    ...overrides,
  };
}

describe('writePendingVisitJson', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
    resetDb();
    runMigrations(TEST_DB);
    resetDb();
    getDb(TEST_DB);
  });

  afterEach(() => {
    resetDb();
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
  });

  it('skips duplicate and ambiguous events, but keeps inserted and enriched', () => {
    const file = writePendingVisitJson([
      makeEvent({ actorName: '重复好友', actorProfileKey: 'dup-user', actorProfileUrl: 'https://www.douyin.com/user/dup-user', relation: 'friend', dbAction: 'duplicate' }),
      makeEvent({ actorName: '新增好友', actorProfileKey: 'insert-user', actorProfileUrl: 'https://www.douyin.com/user/insert-user', relation: 'friend', dbAction: 'inserted', eventId: 101 }),
      makeEvent({ actorName: '补全互关', actorProfileKey: 'enrich-user', actorProfileUrl: 'https://www.douyin.com/user/enrich-user', relation: 'mutual', dbAction: 'enriched', eventId: 102 }),
      makeEvent({ actorName: '歧义用户', actorProfileKey: 'amb-user', actorProfileUrl: 'https://www.douyin.com/user/amb-user', relation: 'friend', dbAction: 'ambiguous' }),
    ], { maxCount: 10 });

    const users = readJson(file.filePath);
    expect(users).toEqual([
      {
        id: buildTaskId(buildIdentityKey({ userId: 'insert-user', userProfileUrl: 'https://www.douyin.com/user/insert-user', userName: '新增好友' })),
        homepage_url: 'https://www.douyin.com/user/insert-user',
      },
      {
        id: buildTaskId(buildIdentityKey({ userId: 'enrich-user', userProfileUrl: 'https://www.douyin.com/user/enrich-user', userName: '补全互关' })),
        homepage_url: 'https://www.douyin.com/user/enrich-user',
      },
    ]);

    unlinkSync(file.filePath);
  });

  it('merges same-identity sources into one json item and one return_visit_task', () => {
    const file = writePendingVisitJson([
      makeEvent({
        eventId: 201,
        eventType: 'like',
        actorName: '同一用户',
        actorProfileKey: 'same-user',
        actorProfileUrl: 'https://www.douyin.com/user/same-user',
        relation: 'friend',
        dbAction: 'inserted',
        notificationAction: 'like_received',
      }),
      makeEvent({
        eventId: 202,
        eventType: 'comment',
        actorName: '同一用户',
        actorProfileKey: 'same-user',
        actorProfileUrl: 'https://www.douyin.com/user/same-user',
        relation: 'mutual',
        dbAction: 'enriched',
        notificationAction: 'comment_on_my_work',
      }),
    ], { maxCount: 10 });

    const users = readJson(file.filePath);
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({
      id: buildTaskId(buildIdentityKey({ userId: 'same-user', userProfileUrl: 'https://www.douyin.com/user/same-user', userName: '同一用户' })),
      homepage_url: 'https://www.douyin.com/user/same-user',
    });

    const row = getDb().prepare('SELECT * FROM return_visit_tasks WHERE identity_key = ?').get('uid:same-user');
    expect(row).toBeTruthy();
    expect(JSON.parse(row.source_types_json)).toEqual(['like', 'comment']);
    expect(JSON.parse(row.source_event_ids_json)).toEqual([201, 202]);
    expect(row.source_type).toBe('like');

    unlinkSync(file.filePath);
  });

  it('counts no-profile, relation-unknown, duplicate-db-action, and seen-identity skips in logs', () => {
    const logs = [];
    const originalError = console.error;
    console.error = (message) => logs.push(String(message));

    try {
      const file = writePendingVisitJson([
        makeEvent({ actorName: '重复通知', actorProfileKey: 'dup-log', actorProfileUrl: 'https://www.douyin.com/user/dup-log', dbAction: 'duplicate' }),
        makeEvent({ actorName: '失败通知', actorProfileKey: 'failed-log', actorProfileUrl: 'https://www.douyin.com/user/failed-log', dbAction: 'failed' }),
        makeEvent({ actorName: '无主页', actorProfileKey: 'no-url', actorProfileUrl: '', dbAction: 'inserted' }),
        makeEvent({ actorName: '关系未知', actorProfileKey: 'unknown-rel', actorProfileUrl: 'https://www.douyin.com/user/unknown-rel', relation: 'unknown', dbAction: 'inserted' }),
        makeEvent({ actorName: '同人来源1', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'inserted', eventId: 301 }),
        makeEvent({ actorName: '同人来源2', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'enriched', eventId: 302, notificationAction: 'comment_on_my_work', eventType: 'comment' }),
      ], { maxCount: 10 });

      unlinkSync(file.filePath);
    } finally {
      console.error = originalError;
    }

    const summary = logs.find(line => line.includes('pending_visit_skip_db_duplicate='));
    expect(summary).toContain('pending_visit_skip_db_duplicate=1');
    expect(summary).toContain('pending_visit_skip_db_ambiguous=0');
    expect(summary).toContain('pending_visit_skip_db_failed=1');
    expect(summary).toContain('pending_visit_skip_seen_identity=1');
    expect(summary).toContain('pending_visit_skip_relation_unknown=1');
    expect(summary).toContain('pending_visit_skip_no_profile_url=1');
    expect(summary).toContain('pending_visit_added_friend=1');
    expect(summary).toContain('pending_visit_added_mutual=0');
  });
});
