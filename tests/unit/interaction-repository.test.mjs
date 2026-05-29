import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

function fp(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS interaction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'douyin',
    event_type TEXT NOT NULL CHECK (event_type IN ('comment', 'like')),
    actor_name TEXT NOT NULL,
    actor_profile_key TEXT,
    actor_profile_url TEXT,
    relation TEXT NOT NULL DEFAULT 'unknown',
    my_work_title TEXT,
    comment_text TEXT,
    event_time_text TEXT,
    platform_event_id TEXT,
    notification_item_key TEXT,
    fingerprint TEXT NOT NULL UNIQUE,
    raw_payload_json TEXT,
    target_work_id TEXT,
    target_work_url TEXT,
    dedup_confidence TEXT,
    profile_resolution_status TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    scanned_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

let upsertNotificationEvent;
let getEvent;
let getEvents;

describe('interaction-repository — upsert + enrich + dedup', () => {
  beforeEach(async () => {
    const { resetDb, getDb } = await import('../../src/db/database.mjs');
    resetDb();
    const appDb = getDb(':memory:');
    appDb.pragma('journal_mode = WAL');
    appDb.exec(SCHEMA);

    const mod = await import('../../src/db/interaction-repository.mjs');
    upsertNotificationEvent = mod.upsertNotificationEvent;
    getEvent = mod.getEvent;
    getEvents = mod.getEvents;
  });

  afterEach(async () => {
    const { resetDb } = await import('../../src/db/database.mjs');
    resetDb();
  });

  it('首次无主页、二次有主页 → enriched，仅一条记录', async () => {
    const fp1 = 'fp-first-scan-like';
    const r1 = upsertNotificationEvent({
      eventType: 'like', actorName: '张三',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'friend', commentText: null, eventTimeText: '10:30',
      fingerprint: fp1, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-1',
      workId: 'video-100', workUrl: 'https://douyin.com/video/100',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"rawText":"张三\\n朋友\\n赞了你的作品\\n10:30"}',
      targetWorkId: 'video-100', targetWorkUrl: 'https://douyin.com/video/100',
      profileResolutionStatus: 'unresolved',
    });
    expect(r1.action).toBe('inserted');

    const r2 = upsertNotificationEvent({
      eventType: 'like', actorName: '张三',
      actorProfileKey: 'user_key_zs', actorProfileUrl: 'https://douyin.com/user/user_key_zs',
      relation: 'friend', commentText: null, eventTimeText: '10:30',
      fingerprint: fp1, dedupConfidence: 'strong',
      platformEventId: 'pid-001', notificationItemKey: 'ni-1',
      workId: 'video-100', workUrl: 'https://douyin.com/video/100',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"rawText":"张三\\n朋友\\n赞了你的作品\\n10:30","profileResolveMethod":"dom_href"}',
      targetWorkId: 'video-100', targetWorkUrl: 'https://douyin.com/video/100',
      profileResolutionStatus: 'dom_href',
    });
    expect(r2.action).toBe('enriched');

    const events = getEvents({ limit: 10 });
    expect(events.length).toBe(1);
    expect(events[0].actor_profile_url).toBe('https://douyin.com/user/user_key_zs');
    expect(events[0].actor_profile_key).toBe('user_key_zs');
    expect(events[0].platform_event_id).toBe('pid-001');
  });

  it('重复扫描同一完整事件 → duplicate', () => {
    const fp = 'fp-same-complete-event';

    const r1 = upsertNotificationEvent({
      eventType: 'like', actorName: '李四',
      actorProfileKey: 'key_ls', actorProfileUrl: 'https://douyin.com/user/key_ls',
      relation: 'mutual', commentText: null, eventTimeText: '11:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-002', notificationItemKey: 'ni-2',
      workId: 'video-200', workUrl: 'https://douyin.com/video/200',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"rawText":"...first..."}',
      targetWorkId: 'video-200', targetWorkUrl: 'https://douyin.com/video/200',
      profileResolutionStatus: 'dom_href',
    });
    expect(r1.action).toBe('inserted');

    const r2 = upsertNotificationEvent({
      eventType: 'like', actorName: '李四',
      actorProfileKey: 'key_ls', actorProfileUrl: 'https://douyin.com/user/key_ls',
      relation: 'mutual', commentText: null, eventTimeText: '11:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-002', notificationItemKey: 'ni-2',
      workId: 'video-200', workUrl: 'https://douyin.com/video/200',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"rawText":"...rescan same event..."}',
      targetWorkId: 'video-200', targetWorkUrl: 'https://douyin.com/video/200',
      profileResolutionStatus: 'dom_href',
    });
    expect(r2.action).toBe('duplicate');

    expect(getEvents({ limit: 10 }).length).toBe(1);
  });

  it('unknown 关系后续识别为 friend → 原记录更新', () => {
    const fp = 'fp-relation-upgrade';

    const r1 = upsertNotificationEvent({
      eventType: 'like', actorName: '王五',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: null, eventTimeText: '12:00',
      fingerprint: fp, dedupConfidence: 'medium',
      platformEventId: 'pid-003', notificationItemKey: 'ni-3',
      workId: 'video-300', workUrl: 'https://douyin.com/video/300',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":1}',
      targetWorkId: 'video-300', targetWorkUrl: 'https://douyin.com/video/300',
      profileResolutionStatus: 'unresolved',
    });
    expect(r1.action).toBe('inserted');

    const r2 = upsertNotificationEvent({
      eventType: 'like', actorName: '王五',
      actorProfileKey: 'key_ww', actorProfileUrl: 'https://douyin.com/user/key_ww',
      relation: 'friend', commentText: null, eventTimeText: '12:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-003', notificationItemKey: 'ni-3',
      workId: 'video-300', workUrl: 'https://douyin.com/video/300',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":2}',
      targetWorkId: 'video-300', targetWorkUrl: 'https://douyin.com/video/300',
      profileResolutionStatus: 'dom_href',
    });
    expect(r2.action).toBe('enriched');

    const ev = getEvent(r1.eventId);
    expect(ev.relation).toBe('friend');
    expect(ev.actor_profile_url).toBe('https://douyin.com/user/key_ww');
  });

  it('无 workId 的 weak like 不得错误合并', () => {
    const fp1 = 'fp-weak-like-a';
    const fp2 = 'fp-weak-like-b';

    const r1 = upsertNotificationEvent({
      eventType: 'like', actorName: '赵六',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: null, eventTimeText: '13:00',
      fingerprint: fp1, dedupConfidence: 'weak',
      platformEventId: null, notificationItemKey: 'ni-4',
      workId: null, workUrl: null,
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":1}',
      targetWorkId: null, targetWorkUrl: null,
      profileResolutionStatus: 'unresolved',
    });
    expect(r1.action).toBe('inserted');

    const r2 = upsertNotificationEvent({
      eventType: 'like', actorName: '赵六',
      actorProfileKey: 'key_zl', actorProfileUrl: 'https://douyin.com/user/key_zl',
      relation: 'friend', commentText: null, eventTimeText: '13:05',
      fingerprint: fp2, dedupConfidence: 'weak',
      platformEventId: null, notificationItemKey: 'ni-5',
      workId: null, workUrl: null,
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":2}',
      targetWorkId: null, targetWorkUrl: null,
      profileResolutionStatus: 'dom_href',
    });
    expect(r2.action).toBe('inserted');

    expect(getEvents({ limit: 10 }).length).toBe(2);
  });

  it('partial match 多条候选 → ambiguous', () => {
    const fp1 = 'fp-ambig-a';
    const fp2 = 'fp-ambig-b';
    const fp3 = 'fp-ambig-c';

    upsertNotificationEvent({
      eventType: 'comment', actorName: '钱七',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: '你好', eventTimeText: '14:00',
      fingerprint: fp1, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-6',
      workId: 'video-400', workUrl: 'https://douyin.com/video/400',
      action: '评论了你的作品', content: '你好',
      rawPayloadJson: '{}',
      targetWorkId: 'video-400', targetWorkUrl: 'https://douyin.com/video/400',
      profileResolutionStatus: 'unresolved',
    });

    upsertNotificationEvent({
      eventType: 'comment', actorName: '钱七',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: '再见', eventTimeText: '14:05',
      fingerprint: fp2, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-7',
      workId: 'video-400', workUrl: 'https://douyin.com/video/400',
      action: '评论了你的作品', content: '再见',
      rawPayloadJson: '{}',
      targetWorkId: 'video-400', targetWorkUrl: 'https://douyin.com/video/400',
      profileResolutionStatus: 'unresolved',
    });

    const r3 = upsertNotificationEvent({
      eventType: 'comment', actorName: '钱七',
      actorProfileKey: 'key_qq', actorProfileUrl: 'https://douyin.com/user/key_qq',
      relation: 'friend', commentText: null, eventTimeText: '14:10',
      fingerprint: fp3, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-8',
      workId: 'video-400', workUrl: 'https://douyin.com/video/400',
      action: '评论了你的作品', content: null,
      rawPayloadJson: '{"v":3}',
      targetWorkId: 'video-400', targetWorkUrl: 'https://douyin.com/video/400',
      profileResolutionStatus: 'dom_href',
    });
    expect(r3.action).toBe('ambiguous');
  });

  it('target_work_id / dedup_confidence / profile_resolution_status 可持久化读取', () => {
    const fp = 'fp-persistence-test';

    const r = upsertNotificationEvent({
      eventType: 'like', actorName: '孙八',
      actorProfileKey: 'key_sb', actorProfileUrl: 'https://douyin.com/user/key_sb',
      relation: 'mutual', commentText: null, eventTimeText: '15:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-004', notificationItemKey: 'ni-9',
      workId: 'video-500', workUrl: 'https://douyin.com/video/500',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":1}',
      targetWorkId: 'video-500', targetWorkUrl: 'https://douyin.com/video/500',
      profileResolutionStatus: 'dom_href',
    });
    expect(r.action).toBe('inserted');

    const ev = getEvent(r.eventId);
    expect(ev.target_work_id).toBe('video-500');
    expect(ev.target_work_url).toBe('https://douyin.com/video/500');
    expect(ev.dedup_confidence).toBe('strong');
    expect(ev.profile_resolution_status).toBe('dom_href');
  });
});