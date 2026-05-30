import { describe, it, expect } from 'vitest';
import { normalizeCommentEvent, buildRawPayloadJson } from '../../src/domain/comment-event-normalization.mjs';
import { buildPlanItemFromEvent } from '../../src/domain/reply-template.mjs';

describe('normalizeCommentEvent', () => {
  it('完整字段归一化', () => {
    const result = normalizeCommentEvent({
      actorName: '张三',
      actorProfileUrl: 'https://example.com/user/1',
      commentText: '写得不错',
      eventTimeText: '05-30 12:00',
      workTitle: '我的作品A',
      workId: 'w001',
      workUrl: 'https://example.com/video/1',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.event).toEqual({
      event_type: 'comment',
      actor_name: '张三',
      actor_profile_url: 'https://example.com/user/1',
      comment_text: '写得不错',
      event_time_text: '05-30 12:00',
      my_work_title: '我的作品A',
      target_work_id: 'w001',
      target_work_url: 'https://example.com/video/1',
      status: 'new',
    });
  });

  it('缺 comment_text → 无效', () => {
    const result = normalizeCommentEvent({
      actorName: '张三',
      commentText: '',
      workTitle: '作品',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_comment_text');
  });

  it('缺 comment_text (null) → 无效', () => {
    const result = normalizeCommentEvent({
      actorName: '张三',
      commentText: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_comment_text');
  });

  it('缺 actor_name → 有效但带 warning', () => {
    const result = normalizeCommentEvent({
      actorName: '',
      commentText: '好内容',
      workTitle: '作品',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('missing_actor_name');
    expect(result.event.actor_name).toBe('');
  });

  it('缺 workTitle → 有效但带 warning', () => {
    const result = normalizeCommentEvent({
      actorName: '张三',
      commentText: '好内容',
      workTitle: '',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('missing_work_title');
    expect(result.event.my_work_title).toBe('');
  });

  it('同时缺 actor_name 和 workTitle → 两个 warning', () => {
    const result = normalizeCommentEvent({
      actorName: '',
      commentText: '好内容',
      workTitle: '',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(['missing_actor_name', 'missing_work_title']);
  });

  it('空白 comment_text 视为缺失', () => {
    const result = normalizeCommentEvent({
      actorName: '张三',
      commentText: '   ',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_comment_text');
  });
});

describe('buildRawPayloadJson', () => {
  it('无 warning 时不包含 warnings 字段', () => {
    const json = buildRawPayloadJson({
      rawText: '张三\n评论了你的作品\n好',
      notificationItemKey: 'ni-1',
      workId: 'v-1',
      workUrl: 'https://example.com/video/1',
      workTitle: '作品',
    }, []);
    const parsed = JSON.parse(json);
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.workTitle).toBe('作品');
  });

  it('有 warning 时包含 warnings 字段', () => {
    const json = buildRawPayloadJson({
      rawText: '',
      notificationItemKey: '',
      workId: null,
      workUrl: null,
      workTitle: null,
    }, ['missing_actor_name']);
    const parsed = JSON.parse(json);
    expect(parsed.warnings).toEqual(['missing_actor_name']);
  });
});

describe('采集事件 → plan item 字段链路', () => {
  it('完整采集事件经归一化后可生成完整 plan item', () => {
    const raw = {
      actorName: '张三',
      actorProfileUrl: 'https://example.com/user/1',
      commentText: '写得不错',
      eventTimeText: '05-30 12:00',
      workTitle: '我的作品A',
      workId: 'w001',
      workUrl: 'https://example.com/video/1',
    };

    const normResult = normalizeCommentEvent(raw);
    expect(normResult.valid).toBe(true);

    const dbEvent = {
      id: 1,
      ...normResult.event,
      actor_profile_key: null,
      relation: 'unknown',
      platform_event_id: null,
      notification_item_key: null,
      fingerprint: 'fp-test',
      raw_payload_json: '{}',
      dedup_confidence: 'medium',
      profile_resolution_status: 'unresolved',
      scanned_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const planItem = buildPlanItemFromEvent(dbEvent);
    expect(planItem).not.toBeNull();
    expect(planItem.eventId).toBe(1);
    expect(planItem.approved).toBe(false);
    expect(planItem.workTitle).toBe('我的作品A');
    expect(planItem.actorName).toBe('张三');
    expect(planItem.commentText).toBe('写得不错');
    expect(planItem.replyText).toBeTruthy();
    expect(planItem.workId).toBe('w001');
    expect(planItem.workUrl).toBe('https://example.com/video/1');
    expect(planItem.actorProfileUrl).toBe('https://example.com/user/1');
    expect(planItem.eventTimeText).toBe('05-30 12:00');
  });

  it('缺 workTitle 的采集事件 → plan item 中 workTitle 为空字符串', () => {
    const raw = {
      actorName: '李四',
      actorProfileUrl: '',
      commentText: '支持',
      eventTimeText: '10:00',
      workTitle: '',
      workId: '',
      workUrl: '',
    };

    const normResult = normalizeCommentEvent(raw);
    expect(normResult.valid).toBe(true);
    expect(normResult.warnings).toContain('missing_work_title');

    const dbEvent = {
      id: 2,
      ...normResult.event,
      actor_profile_key: null,
      relation: 'unknown',
      platform_event_id: null,
      notification_item_key: null,
      fingerprint: 'fp-test-2',
      raw_payload_json: '{}',
      dedup_confidence: 'weak',
      profile_resolution_status: 'unresolved',
      scanned_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const planItem = buildPlanItemFromEvent(dbEvent);
    expect(planItem.workTitle).toBe('');
    expect(planItem.actorName).toBe('李四');
    expect(planItem.commentText).toBe('支持');
  });

  it('缺 commentText 的采集事件 → 归一化失败，不入库', () => {
    const raw = {
      actorName: '王五',
      commentText: '',
      workTitle: '作品B',
    };

    const normResult = normalizeCommentEvent(raw);
    expect(normResult.valid).toBe(false);
    expect(normResult.reason).toBe('missing_comment_text');
  });
});