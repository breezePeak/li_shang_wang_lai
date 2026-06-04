import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { getDb, resetDb } from '../../src/db/database.mjs';
import { runMigrations } from '../../src/db/migrations.mjs';
import { upsertWorkComment } from '../../src/db/work-comment-repository.mjs';
import {
  buildIdentityKey,
  buildTaskId,
  listReturnVisitPendingPrepareTasksByIds,
  RETURN_VISIT_STATUS,
  updateReturnVisitTask,
} from '../../src/services/return-visit-task-service.mjs';
import { writePendingReplyJson, writePendingVisitJson } from '../../src/cli/scan-interactions.mjs';

const TEST_DB = resolve('data', 'test-scan-pending-visit.db');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function cleanupJson(filePath) {
  if (filePath && existsSync(filePath)) unlinkSync(filePath);
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

function taskIdFor(userId, userProfileUrl, userName) {
  return buildTaskId(buildIdentityKey({ userId, userProfileUrl, userName }));
}

describe('writePendingReplyJson', () => {
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

  it('loads pending replies from db and respects days/maxCount', () => {
    const recent = upsertWorkComment({
      workId: 'work-recent',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-recent',
      modalId: 'work-recent',
      actorName: '最近评论',
      actorProfileUrl: 'https://www.douyin.com/user/recent',
      actorProfileKey: 'recent',
      commentText: '最近评论内容',
      eventTimeText: '1小时前',
      commentKey: 'recent-key',
      sourceEventId: 1,
      sourceNotificationKey: 'recent-notice',
    });
    const old = upsertWorkComment({
      workId: 'work-old',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-old',
      modalId: 'work-old',
      actorName: '旧评论',
      actorProfileUrl: 'https://www.douyin.com/user/old',
      actorProfileKey: 'old',
      commentText: '旧评论内容',
      eventTimeText: '3天前',
      commentKey: 'old-key',
      sourceEventId: 2,
      sourceNotificationKey: 'old-notice',
    });

    const db = getDb();
    const oldSeenAt = new Date(Date.now() - 3 * 86400000).toISOString();
    db.prepare('UPDATE work_comments SET last_seen_at = ? WHERE id = ?').run(oldSeenAt, old.id);

    const file = writePendingReplyJson({ days: 1, maxCount: 1 });
    const works = readJson(file.filePath);

    expect(works).toHaveLength(1);
    expect(works[0].workKey).toBe('work-recent');
    expect(works[0].comments).toHaveLength(1);
    expect(works[0].comments[0].actor_name).toBe('最近评论');

    cleanupJson(file.filePath);
    expect(recent.action).toBe('inserted');
    expect(old.action).toBe('inserted');
  });
});

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
        id: taskIdFor('insert-user', 'https://www.douyin.com/user/insert-user', '新增好友'),
        homepage_url: 'https://www.douyin.com/user/insert-user',
      },
      {
        id: taskIdFor('enrich-user', 'https://www.douyin.com/user/enrich-user', '补全互关'),
        homepage_url: 'https://www.douyin.com/user/enrich-user',
      },
    ]);

    cleanupJson(file.filePath);
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
      id: taskIdFor('same-user', 'https://www.douyin.com/user/same-user', '同一用户'),
      homepage_url: 'https://www.douyin.com/user/same-user',
    });

    const row = getDb().prepare('SELECT * FROM return_visit_tasks WHERE identity_key = ?').get('uid:same-user');
    expect(row).toBeTruthy();
    expect(JSON.parse(row.source_types_json)).toEqual(['like', 'comment']);
    expect(JSON.parse(row.source_event_ids_json)).toEqual([201, 202]);
    expect(row.source_type).toBe('like');

    cleanupJson(file.filePath);
  });

  it('uses db task status instead of groupedItems when building pending visits json', () => {
    const event = makeEvent({
      actorName: '状态已推进',
      actorProfileKey: 'status-user',
      actorProfileUrl: 'https://www.douyin.com/user/status-user',
      relation: 'friend',
      dbAction: 'inserted',
      eventId: 401,
    });

    const first = writePendingVisitJson([event], { maxCount: 10 });
    cleanupJson(first.filePath);

    const taskId = taskIdFor('status-user', 'https://www.douyin.com/user/status-user', '状态已推进');
    updateReturnVisitTask(taskId, { status: RETURN_VISIT_STATUS.CONTENT_COLLECTED });

    const second = writePendingVisitJson([
      { ...event, dbAction: 'enriched', eventId: 402 },
    ], { maxCount: 10 });

    expect(readJson(second.filePath)).toEqual([]);
    cleanupJson(second.filePath);
  });

  it('filters out pending_execute done and skipped tasks even when this round is enriched', () => {
    const cases = [
      RETURN_VISIT_STATUS.PENDING_EXECUTE,
      RETURN_VISIT_STATUS.DONE,
      RETURN_VISIT_STATUS.SKIPPED_NO_WORK,
    ];

    for (const [index, status] of cases.entries()) {
      const userId = `status-filter-${index}`;
      const event = makeEvent({
        actorName: `用户${index}`,
        actorProfileKey: userId,
        actorProfileUrl: `https://www.douyin.com/user/${userId}`,
        dbAction: 'inserted',
        eventId: 500 + index,
      });
      const created = writePendingVisitJson([event], { maxCount: 10 });
      cleanupJson(created.filePath);
      updateReturnVisitTask(taskIdFor(userId, event.actorProfileUrl, event.actorName), { status });
    }

    const second = writePendingVisitJson(cases.map((status, index) => makeEvent({
      actorName: `用户${index}`,
      actorProfileKey: `status-filter-${index}`,
      actorProfileUrl: `https://www.douyin.com/user/status-filter-${index}`,
      dbAction: 'enriched',
      eventId: 600 + index,
      notificationAction: 'comment_on_my_work',
      eventType: 'comment',
    })), { maxCount: 10 });

    expect(readJson(second.filePath)).toEqual([]);
    cleanupJson(second.filePath);
  });

  it('keeps a previously old task when this round refreshes updated_at', () => {
    const recentEvent = makeEvent({
      actorName: '最近互动',
      actorProfileKey: 'recent-visit',
      actorProfileUrl: 'https://www.douyin.com/user/recent-visit',
      eventId: 701,
    });
    const oldEvent = makeEvent({
      actorName: '旧互动',
      actorProfileKey: 'old-visit',
      actorProfileUrl: 'https://www.douyin.com/user/old-visit',
      eventId: 702,
    });

    const initial = writePendingVisitJson([recentEvent, oldEvent], { maxCount: 10 });
    cleanupJson(initial.filePath);

    const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    getDb().prepare('UPDATE return_visit_tasks SET updated_at = ? WHERE task_id = ?').run(
      oldUpdatedAt,
      taskIdFor('old-visit', 'https://www.douyin.com/user/old-visit', '旧互动'),
    );

    const file = writePendingVisitJson([
      { ...recentEvent, dbAction: 'enriched', eventId: 703 },
      { ...oldEvent, dbAction: 'enriched', eventId: 704 },
    ], { days: 1, maxCount: 10 });

    expect(readJson(file.filePath)).toEqual([
      {
        id: taskIdFor('recent-visit', 'https://www.douyin.com/user/recent-visit', '最近互动'),
        homepage_url: 'https://www.douyin.com/user/recent-visit',
      },
      {
        id: taskIdFor('old-visit', 'https://www.douyin.com/user/old-visit', '旧互动'),
        homepage_url: 'https://www.douyin.com/user/old-visit',
      },
    ]);

    cleanupJson(file.filePath);
  });

  it('limits final users by maxCount from db query results', () => {
    const events = [
      makeEvent({ actorName: '用户A', actorProfileKey: 'user-a', actorProfileUrl: 'https://www.douyin.com/user/user-a', eventId: 801 }),
      makeEvent({ actorName: '用户B', actorProfileKey: 'user-b', actorProfileUrl: 'https://www.douyin.com/user/user-b', eventId: 802 }),
      makeEvent({ actorName: '用户C', actorProfileKey: 'user-c', actorProfileUrl: 'https://www.douyin.com/user/user-c', eventId: 803 }),
    ];

    const file = writePendingVisitJson(events, { maxCount: 2 });
    const users = readJson(file.filePath);

    expect(users).toHaveLength(2);
    expect(users).toEqual([
      {
        id: taskIdFor('user-a', 'https://www.douyin.com/user/user-a', '用户A'),
        homepage_url: 'https://www.douyin.com/user/user-a',
      },
      {
        id: taskIdFor('user-b', 'https://www.douyin.com/user/user-b', '用户B'),
        homepage_url: 'https://www.douyin.com/user/user-b',
      },
    ]);

    cleanupJson(file.filePath);
  });

  it('counts no-profile, relation-unknown, duplicate-db-action, seen-identity, and db filters in logs', () => {
    const logs = [];
    const originalError = console.error;
    console.error = (message) => logs.push(String(message));

    try {
      const setup = writePendingVisitJson([
        makeEvent({ actorName: 'DB状态过滤', actorProfileKey: 'db-status', actorProfileUrl: 'https://www.douyin.com/user/db-status', dbAction: 'inserted', eventId: 901 }),
        makeEvent({ actorName: 'DB时间过滤', actorProfileKey: 'db-days', actorProfileUrl: 'https://www.douyin.com/user/db-days', dbAction: 'inserted', eventId: 902 }),
      ], { maxCount: 10 });
      cleanupJson(setup.filePath);

      updateReturnVisitTask(taskIdFor('db-status', 'https://www.douyin.com/user/db-status', 'DB状态过滤'), {
        status: RETURN_VISIT_STATUS.CONTENT_COLLECTED,
      });
      const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
      getDb().prepare('UPDATE return_visit_tasks SET updated_at = ? WHERE task_id = ?').run(
        oldUpdatedAt,
        taskIdFor('db-days', 'https://www.douyin.com/user/db-days', 'DB时间过滤'),
      );

      const file = writePendingVisitJson([
        makeEvent({ actorName: '重复通知', actorProfileKey: 'dup-log', actorProfileUrl: 'https://www.douyin.com/user/dup-log', dbAction: 'duplicate' }),
        makeEvent({ actorName: '失败通知', actorProfileKey: 'failed-log', actorProfileUrl: 'https://www.douyin.com/user/failed-log', dbAction: 'failed' }),
        makeEvent({ actorName: '无主页', actorProfileKey: 'no-url', actorProfileUrl: '', dbAction: 'inserted' }),
        makeEvent({ actorName: '关系未知', actorProfileKey: 'unknown-rel', actorProfileUrl: 'https://www.douyin.com/user/unknown-rel', relation: 'unknown', dbAction: 'inserted' }),
        makeEvent({ actorName: '同人来源1', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'inserted', eventId: 903 }),
        makeEvent({ actorName: '同人来源2', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'enriched', eventId: 904, notificationAction: 'comment_on_my_work', eventType: 'comment' }),
        makeEvent({ actorName: 'DB状态过滤', actorProfileKey: 'db-status', actorProfileUrl: 'https://www.douyin.com/user/db-status', dbAction: 'enriched', eventId: 905 }),
        makeEvent({ actorName: 'DB时间过滤', actorProfileKey: 'db-days', actorProfileUrl: 'https://www.douyin.com/user/db-days', dbAction: 'enriched', eventId: 906 }),
      ], { maxCount: 10, days: 1 });

      cleanupJson(file.filePath);
    } finally {
      console.error = originalError;
    }

    const summary = logs.filter(line => line.includes('pending_visit_skip_db_duplicate=')).at(-1);
    expect(summary).toContain('pending_visit_skip_db_duplicate=1');
    expect(summary).toContain('pending_visit_skip_db_ambiguous=0');
    expect(summary).toContain('pending_visit_skip_db_failed=1');
    expect(summary).toContain('pending_visit_skip_seen_identity=1');
    expect(summary).toContain('pending_visit_skip_relation_unknown=1');
    expect(summary).toContain('pending_visit_skip_no_profile_url=1');
    expect(summary).toContain('pending_visit_added_friend=3');
    expect(summary).toContain('pending_visit_added_mutual=0');
    expect(summary).toContain('pending_visit_db_candidate=3');
    expect(summary).toContain('pending_visit_db_selected=2');
    expect(summary).toContain('pending_visit_db_filtered_status=1');
    expect(summary).toContain('pending_visit_db_filtered_days=0');
  });
});

describe('listReturnVisitPendingPrepareTasksByIds', () => {
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

  it('filters stale tasks by updated_at window', () => {
    const event = makeEvent({
      actorName: '窗口测试',
      actorProfileKey: 'window-user',
      actorProfileUrl: 'https://www.douyin.com/user/window-user',
      eventId: 1001,
    });
    const file = writePendingVisitJson([event], { maxCount: 10 });
    cleanupJson(file.filePath);

    const taskId = taskIdFor('window-user', 'https://www.douyin.com/user/window-user', '窗口测试');
    const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    getDb().prepare('UPDATE return_visit_tasks SET updated_at = ? WHERE task_id = ?').run(oldUpdatedAt, taskId);

    const result = listReturnVisitPendingPrepareTasksByIds([taskId], { days: 1, limit: 10 });
    expect(result.candidateCount).toBe(1);
    expect(result.filteredStatusCount).toBe(0);
    expect(result.filteredDaysCount).toBe(1);
    expect(result.tasks).toEqual([]);
  });
});
