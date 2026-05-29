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

  it('ambiguous 不统计为 duplicate，返回 ambiguous 事件信息', () => {
    const fp1 = 'fp-ambig-dup-a';
    const fp2 = 'fp-ambig-dup-b';
    const fp3 = 'fp-ambig-dup-c';

    upsertNotificationEvent({
      eventType: 'comment', actorName: '孙九',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: '你好啊', eventTimeText: '16:00',
      fingerprint: fp1, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-10',
      workId: 'video-600', workUrl: 'https://douyin.com/video/600',
      action: '评论了你的作品', content: '你好啊',
      rawPayloadJson: '{}',
      targetWorkId: 'video-600', targetWorkUrl: 'https://douyin.com/video/600',
      profileResolutionStatus: 'unresolved',
    });

    upsertNotificationEvent({
      eventType: 'comment', actorName: '孙九',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: '再来一条', eventTimeText: '16:05',
      fingerprint: fp2, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-11',
      workId: 'video-600', workUrl: 'https://douyin.com/video/600',
      action: '评论了你的作品', content: '再来一条',
      rawPayloadJson: '{}',
      targetWorkId: 'video-600', targetWorkUrl: 'https://douyin.com/video/600',
      profileResolutionStatus: 'unresolved',
    });

    const r3 = upsertNotificationEvent({
      eventType: 'comment', actorName: '孙九',
      actorProfileKey: 'key_sj', actorProfileUrl: 'https://douyin.com/user/key_sj',
      relation: 'friend', commentText: null, eventTimeText: '16:10',
      fingerprint: fp3, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-12',
      workId: 'video-600', workUrl: 'https://douyin.com/video/600',
      action: '评论了你的作品', content: null,
      rawPayloadJson: '{"v":3}',
      targetWorkId: 'video-600', targetWorkUrl: 'https://douyin.com/video/600',
      profileResolutionStatus: 'dom_href',
    });

    expect(r3.action).toBe('ambiguous');
    expect(r3.eventId).toBeNull();
    expect(r3.error).toContain('partial match returned 2 results');

    // ambiguous 事件不应被记录为主事件，总记录应为 2 条原始
    const events = getEvents({ limit: 10 });
    expect(events.length).toBe(2);
  });

  it('有 platformEventId 但无 workId 时，不猜测补全旧 unresolved like', () => {
    // 先插入一条无 profile 的旧事件
    const fp1 = 'fp-pid-no-guess-old';
    upsertNotificationEvent({
      eventType: 'like', actorName: '周十',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: null, eventTimeText: '17:00',
      fingerprint: fp1, dedupConfidence: 'weak',
      platformEventId: null, notificationItemKey: 'ni-13',
      workId: null, workUrl: null,
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{}',
      targetWorkId: null, targetWorkUrl: null,
      profileResolutionStatus: 'unresolved',
    });

    // 新事件有 platformEventId 但无 workId，指纹不同，不能按用户名猜测
    const fp2 = 'fp-pid-no-guess-new';
    const r = upsertNotificationEvent({
      eventType: 'like', actorName: '周十',
      actorProfileKey: 'key_zs10', actorProfileUrl: 'https://douyin.com/user/key_zs10',
      relation: 'friend', commentText: null, eventTimeText: '17:05',
      fingerprint: fp2, dedupConfidence: 'strong',
      platformEventId: 'pid-new-100', notificationItemKey: 'ni-14',
      workId: null, workUrl: null,
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":2}',
      targetWorkId: null, targetWorkUrl: null,
      profileResolutionStatus: 'dom_href',
    });

    expect(r.action).toBe('inserted');
    expect(getEvents({ limit: 10 }).length).toBe(2);
  });

  it('weak → medium → strong 可逐级升级', () => {
    const fp = 'fp-confidence-upgrade-chain';

    // 第一轮：weak confidence，无 profile
    const r1 = upsertNotificationEvent({
      eventType: 'like', actorName: '郑十二',
      actorProfileKey: null, actorProfileUrl: null,
      relation: 'unknown', commentText: null, eventTimeText: '19:00',
      fingerprint: fp, dedupConfidence: 'weak',
      platformEventId: null, notificationItemKey: 'ni-16',
      workId: 'video-800', workUrl: 'https://douyin.com/video/800',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":1}',
      targetWorkId: 'video-800', targetWorkUrl: 'https://douyin.com/video/800',
      profileResolutionStatus: 'unresolved',
    });
    expect(r1.action).toBe('inserted');
    let ev = getEvent(r1.eventId);
    expect(ev.dedup_confidence).toBe('weak');
    expect(ev.relation).toBe('unknown');
    expect(ev.actor_profile_url).toBeNull();

    // 第二轮：同一事件重新扫描，指纹相同 → fingerprint match → enriched
    // 拿到了 profile + medium confidence
    const r2 = upsertNotificationEvent({
      eventType: 'like', actorName: '郑十二',
      actorProfileKey: 'key_zse', actorProfileUrl: 'https://douyin.com/user/key_zse',
      relation: 'friend', commentText: null, eventTimeText: '19:00',
      fingerprint: fp, dedupConfidence: 'medium',
      platformEventId: null, notificationItemKey: 'ni-16',
      workId: 'video-800', workUrl: 'https://douyin.com/video/800',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":2}',
      targetWorkId: 'video-800', targetWorkUrl: 'https://douyin.com/video/800',
      profileResolutionStatus: 'dom_href',
    });
    expect(r2.action).toBe('enriched');
    ev = getEvent(r1.eventId);
    expect(ev.dedup_confidence).toBe('medium');
    expect(ev.relation).toBe('friend');
    expect(ev.actor_profile_url).toBe('https://douyin.com/user/key_zse');

    // 第三轮：同一事件第三次扫描 → fingerprint match → enrichment with strong confidence + platformEventId
    const r3 = upsertNotificationEvent({
      eventType: 'like', actorName: '郑十二',
      actorProfileKey: 'key_zse', actorProfileUrl: 'https://douyin.com/user/key_zse',
      relation: 'friend', commentText: null, eventTimeText: '19:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-strong-001', notificationItemKey: 'ni-16',
      workId: 'video-800', workUrl: 'https://douyin.com/video/800',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{"v":3}',
      targetWorkId: 'video-800', targetWorkUrl: 'https://douyin.com/video/800',
      profileResolutionStatus: 'dom_href',
    });
    expect(r3.action).toBe('enriched');
    ev = getEvent(r1.eventId);
    expect(ev.dedup_confidence).toBe('strong');
    expect(ev.platform_event_id).toBe('pid-strong-001');
  });

  it('JSON event 输出包含 platformEventId / targetWorkId / targetWorkUrl', () => {
    const fp = 'fp-json-fields';

    const r = upsertNotificationEvent({
      eventType: 'like', actorName: '何十三',
      actorProfileKey: 'key_hs13', actorProfileUrl: 'https://douyin.com/user/key_hs13',
      relation: 'friend', commentText: null, eventTimeText: '20:00',
      fingerprint: fp, dedupConfidence: 'strong',
      platformEventId: 'pid-json-test', notificationItemKey: 'ni-19',
      workId: 'video-900', workUrl: 'https://douyin.com/video/900',
      action: '赞了你的作品', content: null,
      rawPayloadJson: '{}',
      targetWorkId: 'video-900', targetWorkUrl: 'https://douyin.com/video/900',
      profileResolutionStatus: 'dom_href',
    });
    expect(r.action).toBe('inserted');

    const ev = getEvent(r.eventId);
    expect(ev.platform_event_id).toBe('pid-json-test');
    expect(ev.target_work_id).toBe('video-900');
    expect(ev.target_work_url).toBe('https://douyin.com/video/900');
    expect(ev.dedup_confidence).toBe('strong');
    expect(ev.profile_resolution_status).toBe('dom_href');
  });
});