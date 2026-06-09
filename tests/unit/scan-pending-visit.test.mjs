import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { getDb, resetDb } from '../../src/db/database.mjs';
import { runMigrations } from '../../src/db/migrations.mjs';
import { upsertWorkComment } from '../../src/db/work-comment-repository.mjs';
import { upsertWorkContext } from '../../src/db/work-repository.mjs';
import {
  buildIdentityKey,
  buildTaskId,
  listReturnVisitScanTasks,
  RETURN_VISIT_STATUS,
  updateReturnVisitTask,
} from '../../src/services/return-visit-task-service.mjs';
import { summarizePendingReplies, preparePendingVisitTasks } from '../../src/cli/scan-interactions.mjs';

const TEST_DB = resolve('data', 'test-scan-pending-visit.db');

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

describe('summarizePendingReplies', () => {
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

  it('按主页和作品统计待回评 DB 数据，并过滤缺少 author_profile_url 的作品', () => {
    upsertWorkContext({
      workId: 'work-recent',
      modalId: 'work-recent',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-recent',
      workTitle: '最近作品一',
      workType: 'video',
      thumbnailKey: 'thumb-recent',
      thumbnailSrc: 'https://p3.douyinpic.com/thumb-recent.jpeg',
      authorName: '作者A',
      authorProfileUrl: 'https://www.douyin.com/user/author-a',
      authorProfileKey: 'author-a',
      publishedAt: '2026-06-01T10:00:00.000Z',
    });
    upsertWorkContext({
      workId: 'work-recent-2',
      modalId: 'work-recent-2',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-recent-2',
      workTitle: '最近作品二',
      authorName: '作者A',
      authorProfileUrl: 'https://www.douyin.com/user/author-a',
      authorProfileKey: 'author-a',
    });
    upsertWorkContext({
      workId: 'work-old',
      modalId: 'work-old',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-old',
      authorName: '作者B',
      authorProfileUrl: '',
      authorProfileKey: '',
    });
    upsertWorkContext({
      workId: 'work-missing-homepage',
      modalId: 'work-missing-homepage',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-missing-homepage',
      authorName: '作者C',
      authorProfileUrl: '',
      authorProfileKey: '',
    });

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
      rawCommentJson: JSON.stringify({ comment: { comment: { cid: 'cid-recent-1' } } }),
    });
    upsertWorkComment({
      workId: 'work-recent',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-recent',
      modalId: 'work-recent',
      actorName: '最近评论2',
      actorProfileUrl: 'https://www.douyin.com/user/recent-2',
      actorProfileKey: 'recent-2',
      commentText: '最近评论内容2',
      eventTimeText: '2小时前',
      commentKey: 'recent-key-2',
      sourceEventId: 3,
      sourceNotificationKey: 'recent-notice-2',
    });
    upsertWorkComment({
      workId: 'work-recent-2',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-recent-2',
      modalId: 'work-recent-2',
      actorName: '另一作品评论',
      actorProfileUrl: 'https://www.douyin.com/user/recent-3',
      actorProfileKey: 'recent-3',
      commentText: '另一作品评论内容',
      eventTimeText: '3小时前',
      commentKey: 'recent-key-3',
      sourceEventId: 4,
      sourceNotificationKey: 'recent-notice-3',
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
    upsertWorkComment({
      workId: 'work-missing-homepage',
      workUrl: 'https://www.douyin.com/jingxuan?modal_id=work-missing-homepage',
      modalId: 'work-missing-homepage',
      actorName: '缺主页评论',
      actorProfileUrl: 'https://www.douyin.com/user/missing-homepage-comment',
      actorProfileKey: 'missing-homepage-comment',
      commentText: '不应该进入待回评摘要',
      eventTimeText: '刚刚',
      commentKey: 'missing-homepage-key',
      sourceEventId: 5,
      sourceNotificationKey: 'missing-homepage-notice',
    });

    const db = getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    db.prepare('UPDATE work_comments SET first_seen_at = ? WHERE reply_status = ? AND id != ?').run(twoDaysAgo, 'pending', old.id);

    const summary = summarizePendingReplies({ days: 1, maxCount: 10 });

    expect(summary.homepageCount).toBe(1);
    expect(summary.workCount).toBe(2);
    expect(summary.totalComments).toBe(3);
    expect(summary.skippedMissingHomepageWorkCount).toBe(1);
    expect(summary.nextStep).toContain('comments:execute');
    expect(recent.action).toBe('inserted');
    expect(old.action).toBe('inserted');
  });
});

describe('preparePendingVisitTasks', () => {
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
    const result = preparePendingVisitTasks([
      makeEvent({ actorName: '重复好友', actorProfileKey: 'dup-user', actorProfileUrl: 'https://www.douyin.com/user/dup-user', relation: 'friend', dbAction: 'duplicate' }),
      makeEvent({ actorName: '新增好友', actorProfileKey: 'insert-user', actorProfileUrl: 'https://www.douyin.com/user/insert-user', relation: 'friend', dbAction: 'inserted', eventId: 101 }),
      makeEvent({ actorName: '补全互关', actorProfileKey: 'enrich-user', actorProfileUrl: 'https://www.douyin.com/user/enrich-user', relation: 'mutual', dbAction: 'enriched', eventId: 102 }),
      makeEvent({ actorName: '歧义用户', actorProfileKey: 'amb-user', actorProfileUrl: 'https://www.douyin.com/user/amb-user', relation: 'friend', dbAction: 'ambiguous' }),
    ], { maxCount: 10 });

    expect(result.tasks.map(task => ({ id: task.taskId, homepage_url: task.userProfileUrl }))).toEqual([
      {
        id: taskIdFor('insert-user', 'https://www.douyin.com/user/insert-user', '新增好友'),
        homepage_url: 'https://www.douyin.com/user/insert-user',
      },
      {
        id: taskIdFor('enrich-user', 'https://www.douyin.com/user/enrich-user', '补全互关'),
        homepage_url: 'https://www.douyin.com/user/enrich-user',
      },
    ]);
  });

  it('merges same-identity sources into one return_visit_task', () => {
    const result = preparePendingVisitTasks([
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

    expect(result.tasks).toHaveLength(1);
    expect({ id: result.tasks[0].taskId, homepage_url: result.tasks[0].userProfileUrl }).toEqual({
      id: taskIdFor('same-user', 'https://www.douyin.com/user/same-user', '同一用户'),
      homepage_url: 'https://www.douyin.com/user/same-user',
    });

    const row = getDb().prepare('SELECT * FROM return_visit_tasks WHERE identity_key = ?').get('uid:same-user');
    expect(row).toBeTruthy();
    expect(JSON.parse(row.source_types_json)).toEqual(['like', 'comment']);
    expect(JSON.parse(row.source_event_ids_json)).toEqual([201, 202]);
    expect(row.source_type).toBe('like');
  });

  it('persists target work from interaction events into return_visit_task', () => {
    const result = preparePendingVisitTasks([
      makeEvent({
        eventId: 301,
        eventType: 'reply',
        actorName: '有目标作品',
        actorProfileKey: 'target-user',
        actorProfileUrl: 'https://www.douyin.com/user/target-user',
        relation: 'friend',
        dbAction: 'inserted',
        notificationAction: 'reply_to_my_comment',
        targetWorkId: '7646778420181104228',
        targetWorkUrl: 'https://www.douyin.com/jingxuan?modal_id=7646778420181104228',
      }),
    ], { maxCount: 10 });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].targetWork.workId).toBe('7646778420181104228');
    expect(result.tasks[0].targetWork.workUrl).toBe('https://www.douyin.com/jingxuan?modal_id=7646778420181104228');
  });

  it('does not use received-like work as return visit target', () => {
    const result = preparePendingVisitTasks([
      makeEvent({
        eventId: 302,
        eventType: 'like',
        actorName: '点赞我的作品',
        actorProfileKey: 'like-target-user',
        actorProfileUrl: 'https://www.douyin.com/user/like-target-user',
        relation: 'friend',
        dbAction: 'inserted',
        notificationAction: 'like_received',
        targetWorkId: 'my-work-001',
        targetWorkUrl: 'https://www.douyin.com/jingxuan?modal_id=my-work-001',
      }),
    ], { maxCount: 10 });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].targetWork.workId).toBeNull();
    expect(result.tasks[0].targetWork.workUrl).toBeNull();
  });

  it('uses db task status instead of current grouped items when listing pending visits', () => {
    const event = makeEvent({
      actorName: '状态已推进',
      actorProfileKey: 'status-user',
      actorProfileUrl: 'https://www.douyin.com/user/status-user',
      relation: 'friend',
      dbAction: 'inserted',
      eventId: 401,
    });

    preparePendingVisitTasks([event], { maxCount: 10 });

    const taskId = taskIdFor('status-user', 'https://www.douyin.com/user/status-user', '状态已推进');
    updateReturnVisitTask(taskId, { status: RETURN_VISIT_STATUS.CONTENT_COLLECTED });

    const second = preparePendingVisitTasks([
      { ...event, dbAction: 'enriched', eventId: 402 },
    ], { maxCount: 10 });

    expect(second.tasks).toEqual([]);
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
      preparePendingVisitTasks([event], { maxCount: 10 });
      updateReturnVisitTask(taskIdFor(userId, event.actorProfileUrl, event.actorName), { status });
    }

    const second = preparePendingVisitTasks(cases.map((status, index) => makeEvent({
      actorName: `用户${index}`,
      actorProfileKey: `status-filter-${index}`,
      actorProfileUrl: `https://www.douyin.com/user/status-filter-${index}`,
      dbAction: 'enriched',
      eventId: 600 + index,
      notificationAction: 'comment_on_my_work',
      eventType: 'comment',
    })), { maxCount: 10 });

    expect(second.tasks).toEqual([]);
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

    preparePendingVisitTasks([recentEvent, oldEvent], { maxCount: 10 });

    const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    getDb().prepare('UPDATE return_visit_tasks SET updated_at = ? WHERE task_id = ?').run(
      oldUpdatedAt,
      taskIdFor('old-visit', 'https://www.douyin.com/user/old-visit', '旧互动'),
    );

    const result = preparePendingVisitTasks([
      { ...recentEvent, dbAction: 'enriched', eventId: 703 },
      { ...oldEvent, dbAction: 'enriched', eventId: 704 },
    ], { days: 1, maxCount: 10 });

    expect(result.tasks.map(task => ({ id: task.taskId, homepage_url: task.userProfileUrl }))).toEqual([
      {
        id: taskIdFor('recent-visit', 'https://www.douyin.com/user/recent-visit', '最近互动'),
        homepage_url: 'https://www.douyin.com/user/recent-visit',
      },
      {
        id: taskIdFor('old-visit', 'https://www.douyin.com/user/old-visit', '旧互动'),
        homepage_url: 'https://www.douyin.com/user/old-visit',
      },
    ]);
  });

  it('limits final tasks by maxCount from db query results', () => {
    const events = [
      makeEvent({ actorName: '用户A', actorProfileKey: 'user-a', actorProfileUrl: 'https://www.douyin.com/user/user-a', eventId: 801 }),
      makeEvent({ actorName: '用户B', actorProfileKey: 'user-b', actorProfileUrl: 'https://www.douyin.com/user/user-b', eventId: 802 }),
      makeEvent({ actorName: '用户C', actorProfileKey: 'user-c', actorProfileUrl: 'https://www.douyin.com/user/user-c', eventId: 803 }),
    ];

    const result = preparePendingVisitTasks(events, { maxCount: 2 });
    const users = result.tasks.map(task => ({ id: task.taskId, homepage_url: task.userProfileUrl }));

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
  });

  it('counts no-profile, relation-unknown, duplicate-db-action, seen-identity, and db filters in logs', () => {
    const logs = [];
    const originalError = console.error;
    console.error = (message) => logs.push(String(message));

    try {
      preparePendingVisitTasks([
        makeEvent({ actorName: 'DB状态过滤', actorProfileKey: 'db-status', actorProfileUrl: 'https://www.douyin.com/user/db-status', dbAction: 'inserted', eventId: 901 }),
        makeEvent({ actorName: 'DB时间过滤', actorProfileKey: 'db-days', actorProfileUrl: 'https://www.douyin.com/user/db-days', dbAction: 'inserted', eventId: 902 }),
      ], { maxCount: 10 });

      updateReturnVisitTask(taskIdFor('db-status', 'https://www.douyin.com/user/db-status', 'DB状态过滤'), {
        status: RETURN_VISIT_STATUS.CONTENT_COLLECTED,
      });
      const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
      getDb().prepare('UPDATE return_visit_tasks SET updated_at = ? WHERE task_id = ?').run(
        oldUpdatedAt,
        taskIdFor('db-days', 'https://www.douyin.com/user/db-days', 'DB时间过滤'),
      );

      preparePendingVisitTasks([
        makeEvent({ actorName: '重复通知', actorProfileKey: 'dup-log', actorProfileUrl: 'https://www.douyin.com/user/dup-log', dbAction: 'duplicate' }),
        makeEvent({ actorName: '失败通知', actorProfileKey: 'failed-log', actorProfileUrl: 'https://www.douyin.com/user/failed-log', dbAction: 'failed' }),
        makeEvent({ actorName: '无主页', actorProfileKey: 'no-url', actorProfileUrl: '', dbAction: 'inserted' }),
        makeEvent({ actorName: '关系未知', actorProfileKey: 'unknown-rel', actorProfileUrl: 'https://www.douyin.com/user/unknown-rel', relation: 'unknown', dbAction: 'inserted' }),
        makeEvent({ actorName: '同人来源1', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'inserted', eventId: 903 }),
        makeEvent({ actorName: '同人来源2', actorProfileKey: 'same-log', actorProfileUrl: 'https://www.douyin.com/user/same-log', relation: 'friend', dbAction: 'enriched', eventId: 904, notificationAction: 'comment_on_my_work', eventType: 'comment' }),
        makeEvent({ actorName: 'DB状态过滤', actorProfileKey: 'db-status', actorProfileUrl: 'https://www.douyin.com/user/db-status', dbAction: 'enriched', eventId: 905 }),
        makeEvent({ actorName: 'DB时间过滤', actorProfileKey: 'db-days', actorProfileUrl: 'https://www.douyin.com/user/db-days', dbAction: 'enriched', eventId: 906 }),
      ], { maxCount: 10, days: 1 });
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

describe('listReturnVisitScanTasks', () => {
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
    preparePendingVisitTasks([event], { maxCount: 10 });

    const oldUpdatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    getDb().prepare('UPDATE return_visit_tasks SET updated_at = ?').run(oldUpdatedAt);

    const result = listReturnVisitScanTasks({ days: 1, limit: 10 });
    expect(result.candidateCount).toBe(1);
    expect(result.filteredStatusCount).toBe(0);
    expect(result.filteredDaysCount).toBe(1);
    expect(result.tasks).toEqual([]);
  });

  it('returns pending tasks even when current scan has no events', () => {
    // 直接通过 DB 创建任务（模拟之前扫描已入库）
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = taskIdFor('legacy-user', 'https://www.douyin.com/user/legacy-user', '遗留用户');
    db.prepare(`
      INSERT INTO return_visit_tasks (
        task_id, identity_key, user_id, user_name, user_profile_url,
        source_type, source_types_json, source_event_ids_json,
        action_type, status, like_status, comment_status,
        retry_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        'like', '["like"]', '[]',
        'like_and_comment', ?, 'pending', 'pending',
        0, ?, ?
      )
    `).run(taskId, 'legacy-key', 'legacy-user', '遗留用户',
      'https://www.douyin.com/user/legacy-user',
      RETURN_VISIT_STATUS.PENDING_VISIT, now, now);

    // 空 events 也应该能查到 DB 中已有任务
    const result = listReturnVisitScanTasks({ limit: 10 });
    expect(result.candidateCount).toBe(1);
    expect(result.filteredStatusCount).toBe(0);
    expect(result.filteredDaysCount).toBe(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(taskId);
  });

  it('returns failed_collect tasks for re-prepare', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const taskId = taskIdFor('failed-collect-user', 'https://www.douyin.com/user/fc-user', '失败采集');
    db.prepare(`
      INSERT INTO return_visit_tasks (
        task_id, identity_key, user_id, user_name, user_profile_url,
        source_type, source_types_json, source_event_ids_json,
        action_type, status, like_status, comment_status,
        retry_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        'like', '["like"]', '[]',
        'like_and_comment', ?, 'pending', 'pending',
        0, ?, ?
      )
    `).run(taskId, 'fc-key', 'failed-collect-user', '失败采集',
      'https://www.douyin.com/user/fc-user',
      RETURN_VISIT_STATUS.FAILED_COLLECT, now, now);

    const result = listReturnVisitScanTasks({ limit: 10 });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(taskId);
  });

  it('excludes content_collected / comment_generated / pending_execute / done / skipped', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const undesiredStatuses = [
      RETURN_VISIT_STATUS.CONTENT_COLLECTED,
      RETURN_VISIT_STATUS.COMMENT_GENERATED,
      RETURN_VISIT_STATUS.PENDING_EXECUTE,
      RETURN_VISIT_STATUS.DONE,
      RETURN_VISIT_STATUS.SKIPPED_NO_WORK,
      RETURN_VISIT_STATUS.SKIPPED_PRIVATE,
      RETURN_VISIT_STATUS.SKIPPED_NO_SUITABLE_WORK,
      RETURN_VISIT_STATUS.EXECUTING,
      RETURN_VISIT_STATUS.FAILED_LIKE,
      RETURN_VISIT_STATUS.FAILED_COMMENT,
      RETURN_VISIT_STATUS.FAILED,
    ];
    let idx = 0;
    for (const status of undesiredStatuses) {
      const taskId = taskIdFor(`unwanted-${idx}`, `https://www.douyin.com/user/unwanted-${idx}`, `排除用户${idx}`);
      db.prepare(`
        INSERT INTO return_visit_tasks (
          task_id, identity_key, user_id, user_name, user_profile_url,
          source_type, source_types_json, source_event_ids_json,
          action_type, status, like_status, comment_status,
          retry_count, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          'like', '["like"]', '[]',
          'like_and_comment', ?, 'pending', 'pending',
          0, ?, ?
        )
      `).run(taskId, `key-${idx}`, `unwanted-${idx}`, `排除用户${idx}`,
        `https://www.douyin.com/user/unwanted-${idx}`,
        status, now, now);
      idx++;
    }

    const result = listReturnVisitScanTasks({ limit: 100 });
    expect(result.tasks).toHaveLength(0);
    expect(result.filteredStatusCount).toBe(undesiredStatuses.length);
  });

  it('respects days filter', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 3 * 86400000).toISOString();

    const recentTaskId = taskIdFor('recent-user', 'https://www.douyin.com/user/recent-user', '最近用户');
    db.prepare(`
      INSERT INTO return_visit_tasks (
        task_id, identity_key, user_id, user_name, user_profile_url,
        source_type, source_types_json, source_event_ids_json,
        action_type, status, like_status, comment_status,
        retry_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        'like', '["like"]', '[]',
        'like_and_comment', ?, 'pending', 'pending',
        0, ?, ?
      )
    `).run(recentTaskId, 'recent-key', 'recent-user', '最近用户',
      'https://www.douyin.com/user/recent-user',
      RETURN_VISIT_STATUS.PENDING_VISIT, now, now);

    const oldTaskId = taskIdFor('old-user', 'https://www.douyin.com/user/old-user', '旧用户');
    db.prepare(`
      INSERT INTO return_visit_tasks (
        task_id, identity_key, user_id, user_name, user_profile_url,
        source_type, source_types_json, source_event_ids_json,
        action_type, status, like_status, comment_status,
        retry_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        'like', '["like"]', '[]',
        'like_and_comment', ?, 'pending', 'pending',
        0, ?, ?
      )
    `).run(oldTaskId, 'old-key', 'old-user', '旧用户',
      'https://www.douyin.com/user/old-user',
      RETURN_VISIT_STATUS.PENDING_VISIT, oldDate, oldDate);

    const result = listReturnVisitScanTasks({ days: 1, limit: 10 });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(recentTaskId);
    expect(result.filteredDaysCount).toBe(1);
  });

  it('respects maxCount limit', () => {
    const db = getDb();
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      const taskId = taskIdFor(`limit-user-${i}`, `https://www.douyin.com/user/limit-${i}`, `限制用户${i}`);
      db.prepare(`
        INSERT INTO return_visit_tasks (
          task_id, identity_key, user_id, user_name, user_profile_url,
          source_type, source_types_json, source_event_ids_json,
          action_type, status, like_status, comment_status,
          retry_count, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          'like', '["like"]', '[]',
          'like_and_comment', ?, 'pending', 'pending',
          0, ?, ?
        )
      `).run(taskId, `key-${i}`, `limit-user-${i}`, `限制用户${i}`,
        `https://www.douyin.com/user/limit-${i}`,
        RETURN_VISIT_STATUS.PENDING_VISIT, now, now);
    }

    const result = listReturnVisitScanTasks({ limit: 3 });
    expect(result.tasks).toHaveLength(3);
    expect(result.candidateCount).toBe(5);
  });
});
