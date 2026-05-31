import { describe, it, expect, beforeAll } from 'vitest';

// ============================================================
// notificationFingerprint — dedup safety tests
// ============================================================
describe('notificationFingerprint — dedup safety (production module)', () => {
  let notificationFingerprint = null;
  let generateNotificationItemKey = null;

  beforeAll(async () => {
    const fingerprintMod = await import('../../src/domain/event-fingerprint.mjs');
    const notificationPageMod = await import('../../src/adapters/notification-page.mjs');
    notificationFingerprint = fingerprintMod.notificationFingerprint;
    generateNotificationItemKey = notificationPageMod.generateNotificationItemKey;
  });

  it('same like notification with different relative times → same fingerprint', () => {
    const r1 = notificationFingerprint({
      eventType: 'like', username: '张三', actorProfileKey: 'key123', action: '赞了你的作品',
      rawText: '张三\n朋友\n赞了你的作品\n3分钟前', timeText: '3分钟前',
    });
    const r2 = notificationFingerprint({
      eventType: 'like', username: '张三', actorProfileKey: 'key123', action: '赞了你的作品',
      rawText: '张三\n朋友\n赞了你的作品\n8分钟前', timeText: '8分钟前',
    });
    // Same actor + same action → same fingerprint (timeText excluded)
    expect(r1.fp).toBe(r2.fp);
    expect(r1.confidence).toBe('weak');
  });

  it('same friend likes two different works → different fingerprints', () => {
    const r1 = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      workId: 'video-12345',
    });
    const r2 = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      workId: 'video-67890',
    });
    expect(r1.fp).not.toBe(r2.fp);
    expect(r1.confidence).toBe('medium');
    expect(r2.confidence).toBe('medium');
  });

  it('same friend comments same text on two different works → different fingerprints', () => {
    const r1 = notificationFingerprint({
      eventType: 'comment', username: '张三', content: '写得不错',
      workId: 'video-111',
    });
    const r2 = notificationFingerprint({
      eventType: 'comment', username: '张三', content: '写得不错',
      workId: 'video-222',
    });
    expect(r1.fp).not.toBe(r2.fp);
    expect(r1.confidence).toBe('medium');
    expect(r2.confidence).toBe('medium');
  });

  it('platformEventId takes highest priority', () => {
    const r1 = notificationFingerprint({
      eventType: 'like', username: '张三',
      platformEventId: 'notif-999',
    });
    const r2 = notificationFingerprint({
      eventType: 'like', username: '张三',
      platformEventId: 'notif-999',
      workId: 'video-123',
    });
    // Same platformEventId → same fingerprint regardless of other fields
    expect(r1.fp).toBe(r2.fp);
    expect(r1.confidence).toBe('strong');
  });

  it('workId gives medium confidence', () => {
    const r = notificationFingerprint({
      eventType: 'comment', username: '张三', content: '你好',
      workId: 'video-456',
    });
    expect(r.confidence).toBe('medium');
  });

  it('workUrl gives medium confidence when workId is missing', () => {
    const r = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      workUrl: 'https://www.douyin.com/video/456',
    });
    expect(r.confidence).toBe('medium');
  });

  it('thumbnailKey gives medium confidence when workId and workUrl are missing', () => {
    const r = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-a',
    });
    expect(r.confidence).toBe('medium');
  });

  it('no stable ID → weak confidence', () => {
    const r = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      workId: '', workUrl: '', thumbnailKey: '',
    });
    expect(r.confidence).toBe('weak');
  });

  it('rawText changes with relative time → same weak-dedup fp', () => {
    // rawText includes "3分钟前" vs "8分钟前" — but fingerprint excludes rawText entirely
    const r1 = notificationFingerprint({
      eventType: 'comment', username: '李四', content: '很棒',
      rawText: '李四\n赞了你的作品\n3分钟前',
    });
    const r2 = notificationFingerprint({
      eventType: 'comment', username: '李四', content: '很棒',
      rawText: '李四\n赞了你的作品\n8分钟前',
    });
    expect(r1.fp).toBe(r2.fp);
  });

  it('relative time changes do not affect fingerprint with thumbnailKey fallback', () => {
    const r1 = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-a',
      rawText: '张三\n赞了你的作品\n3分钟前',
      timeText: '3分钟前',
    });
    const r2 = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-a',
      rawText: '张三\n赞了你的作品\n8分钟前',
      timeText: '8分钟前',
    });
    expect(r1.fp).toBe(r2.fp);
    expect(r1.confidence).toBe('medium');
  });

  it('different users with same action → different fingerprints', () => {
    const r1 = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
    });
    const r2 = notificationFingerprint({
      eventType: 'like', username: '李四', action: '赞了你的作品',
    });
    expect(r1.fp).not.toBe(r2.fp);
  });

  it('same friend, same work, two different comments → two different events', () => {
    const r1 = notificationFingerprint({
      eventType: 'comment', username: '张三', workId: 'video-123', content: '写得不错',
    });
    const r2 = notificationFingerprint({
      eventType: 'comment', username: '张三', workId: 'video-123', content: '这个功能真好',
    });
    // Different content → different fingerprints
    expect(r1.fp).not.toBe(r2.fp);
    expect(r1.confidence).toBe('medium');
  });

  it('same friend, same work, same text, different platformEventId → two different events', () => {
    const r1 = notificationFingerprint({
      eventType: 'comment', username: '张三', platformEventId: 'pid-1', content: '写得不错',
    });
    const r2 = notificationFingerprint({
      eventType: 'comment', username: '张三', platformEventId: 'pid-2', content: '写得不错',
    });
    expect(r1.fp).not.toBe(r2.fp);
    expect(r1.confidence).toBe('strong');
  });

  it('platformEventId overrides workId when both present', () => {
    const r1 = notificationFingerprint({
      eventType: 'comment', username: '张三', platformEventId: 'pid-99', workId: 'video-123',
      content: '很好',
    });
    const r2 = notificationFingerprint({
      eventType: 'comment', username: '张三', platformEventId: 'pid-99', workId: 'video-456',
      content: '不同',
    });
    // Same platformEventId → same fingerprint, workId difference ignored
    expect(r1.fp).toBe(r2.fp);
  });

  it('weak events are valid but not auto-executable', () => {
    const r = notificationFingerprint({
      eventType: 'like', username: '张三', action: '赞了你的作品',
    });
    expect(r.confidence).toBe('weak');
    expect(r.fp).toBeTruthy();
  });

  it('same user/action/thumbnailKey generates same notificationItemKey', () => {
    const base = {
      username: '张三',
      relation: 'friend',
      action: '赞了你的作品',
      content: '',
      actorProfileKey: 'user-1',
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-a',
    };

    expect(generateNotificationItemKey(base)).toBe(generateNotificationItemKey({
      ...base,
      rawText: '张三\n赞了你的作品\n8分钟前',
      timeText: '8分钟前',
    }));
  });

  it('same user/action with different thumbnailKey generates different notificationItemKey', () => {
    const base = {
      username: '张三',
      relation: 'friend',
      action: '赞了你的作品',
      content: '',
      actorProfileKey: 'user-1',
    };

    expect(generateNotificationItemKey({
      ...base,
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-a',
    })).not.toBe(generateNotificationItemKey({
      ...base,
      thumbnailKey: 'p3-sign.douyinpic.com/tos-cn-i/thumb-b',
    }));
  });
});
