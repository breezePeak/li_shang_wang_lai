import { describe, expect, it } from 'vitest';
import { classifyNotificationAction } from '../../src/domain/notification-action-router.mjs';

describe('classifyNotificationAction', () => {
  it('routes comments on my work to work comment collection', () => {
    expect(classifyNotificationAction('张三\n评论了你的作品\n讲得不错')).toMatchObject({
      notificationAction: 'comment_on_my_work',
      eventType: 'comment',
      nextAction: 'collect_work_comments',
      clickTarget: 'thumbnail',
    });
  });

  it('routes replies to my comment to owner notification only', () => {
    expect(classifyNotificationAction('张三\n回复了你的评论\n谢谢')).toMatchObject({
      notificationAction: 'reply_to_my_comment',
      eventType: 'reply',
      nextAction: 'notify_owner',
      clickTarget: null,
    });
  });

  it('routes like-of-comment variants to reply classification', () => {
    for (const rawText of ['赞了你的评论', '点赞了你的评论']) {
      expect(classifyNotificationAction(rawText)).toMatchObject({
        notificationAction: 'reply_to_my_comment',
        eventType: 'reply',
        nextAction: 'notify_owner',
      });
    }
  });

  it('routes like variants to revisit collection (works only)', () => {
    for (const rawText of ['赞了你的作品', '赞了你的视频', '点赞了你的作品']) {
      expect(classifyNotificationAction(rawText)).toMatchObject({
        notificationAction: 'like_received',
        eventType: 'like',
        nextAction: 'collect_revisit',
      });
    }
  });

  it('routes follow notifications to fan management', () => {
    for (const rawText of ['关注了你', '回关了你']) {
      expect(classifyNotificationAction(rawText)).toMatchObject({
        notificationAction: 'follow_received',
        eventType: 'follow',
        nextAction: 'notify_owner',
      });
    }
  });

  it('routes unknown notifications to owner notification only', () => {
    expect(classifyNotificationAction('一些随机文本')).toMatchObject({
      notificationAction: 'unknown',
      eventType: 'unknown',
      nextAction: 'notify_owner',
    });
  });
});
