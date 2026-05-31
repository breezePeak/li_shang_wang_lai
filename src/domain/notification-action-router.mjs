const LIKE_PATTERNS = [
  '赞了你的作品',
  '赞了你的视频',
  '点赞了你的作品',
  '赞了你的评论',
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

  if (text.includes('回复了你的评论')) {
    return {
      notificationAction: 'reply_to_my_comment',
      eventType: 'comment',
      nextAction: 'notify_owner',
      clickTarget: null,
      reason: 'reply_to_my_comment_requires_owner_review',
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
