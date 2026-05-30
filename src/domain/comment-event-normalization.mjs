export function normalizeCommentEvent(raw) {
  const warnings = [];

  const commentText = (raw.commentText || '').trim();
  const actorName = (raw.actorName || '').trim();
  const workTitle = (raw.workTitle || '').trim();

  if (!commentText) {
    return { valid: false, reason: 'missing_comment_text' };
  }

  if (!actorName) {
    warnings.push('missing_actor_name');
  }

  if (!workTitle) {
    warnings.push('missing_work_title');
  }

  const event = {
    event_type: 'comment',
    actor_name: actorName || '',
    actor_profile_url: raw.actorProfileUrl || '',
    comment_text: commentText,
    event_time_text: raw.eventTimeText || '',
    my_work_title: workTitle || '',
    target_work_id: raw.workId || '',
    target_work_url: raw.workUrl || '',
    status: 'new',
  };

  return { valid: true, event, warnings };
}

export function buildRawPayloadJson(raw, warnings = []) {
  const payload = {
    rawText: raw.rawText || '',
    notificationItemKey: raw.notificationItemKey || '',
    extractSource: 'notification',
    workId: raw.workId || null,
    workUrl: raw.workUrl || null,
    workTitle: raw.workTitle || null,
  };
  if (warnings.length > 0) {
    payload.warnings = warnings;
  }
  return JSON.stringify(payload);
}