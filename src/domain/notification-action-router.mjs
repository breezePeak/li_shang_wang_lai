const LIKE_PATTERNS = [
  '赞了你的作品',
  '赞了你的视频',
  '点赞了你的作品',
];

export function classifyNotificationAction(rawText = '') {
  const text = String(rawText || '');

  if (text.includes('评论了你的作品') || text.includes('评论了你的视频')) {
    return {
      notificationAction: 'comment_on_my_work',
      eventType: 'comment',
      nextAction: 'collect_work_comments',
      clickTarget: 'thumbnail',
      reason: 'comment_on_my_work',
    };
  }

  if (text.includes('回复了你的评论') || text.includes('赞了你的评论')) {
    return {
      notificationAction: 'reply_to_my_comment',
      eventType: 'reply',
      nextAction: 'notify_owner',
      clickTarget: null,
      reason: 'reply_to_my_comment_or_like_requires_owner_review',
    };
  }

  if (text.includes('关注了你') || text.includes('回关了你')) {
    return {
      notificationAction: 'follow_received',
      eventType: 'follow',
      nextAction: 'notify_owner',
      clickTarget: null,
      reason: 'follow_received_for_fan_management',
    };
  }

  if (LIKE_PATTERNS.some(pattern => text.includes(pattern))) {
    return {
      notificationAction: 'like_received',
      eventType: 'like',
      nextAction: 'collect_revisit',
      clickTarget: 'avatar',
      reason: 'like_received',
    };
  }

  return {
    notificationAction: 'unknown',
    eventType: 'unknown',
    nextAction: 'notify_owner',
    clickTarget: null,
    reason: 'unknown_notification_requires_owner_review',
  };
}
