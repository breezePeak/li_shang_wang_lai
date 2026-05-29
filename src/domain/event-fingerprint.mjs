import crypto from 'crypto';

const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;

function isRelativeTime(text) {
  return RELATIVE_TIME_RE.test((text || '').trim());
}

export { isRelativeTime, RELATIVE_TIME_RE };

/**
 * Generate a stable dedup fingerprint for a comment event.
 *
 * Priority:
 * 1. platformEventId (from data-comment-id or similar DOM attribute) → hash(id)
 * 2. No platform ID + stable time → hash(actorName || workTitle || content || timeText)
 * 3. No platform ID + relative time → hash(actorName || workTitle || content) — event marked 'unstable'
 */
export function commentFingerprint(comment, workTitle) {
  const pid = (comment.platformEventId || '').trim();
  if (pid) {
    return crypto.createHash('sha256').update('comment:pid:' + pid).digest('hex').slice(0, 16);
  }

  const timeIsRelative = isRelativeTime(comment.timeText);
  const timePart = timeIsRelative ? '' : (comment.timeText || '').trim();
  const raw = ['comment', (comment.username || '').trim(), (workTitle || '').trim(), (comment.content || '').trim(), timePart]
    .map(s => s)
    .join('||');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Determine the initial status for a newly scanned comment event.
 */
export function commentInitialStatus(timeText) {
  return isRelativeTime(timeText) ? 'unstable' : 'new';
}

/**
 * Generate a robust fingerprint for notification events (likes, comments).
 * Priority order: actorProfileKey > actorProfileUrl > username
 */
export function notificationFingerprint({ eventType, username, actorProfileKey, actorProfileUrl, action, content, timeText, rawText }) {
  const actorId = (actorProfileKey || '').trim()
    || (actorProfileUrl || '').trim()
    || (username || '').trim();
  const actionPart = (action || '').trim();
  const textSummary = ((content || rawText || '').trim()).slice(0, 200);
  const timePart = isRelativeTime(timeText) ? '' : (timeText || '').trim();

  const raw = [eventType, actorId, actionPart, textSummary, timePart]
    .map(s => s || '')
    .join('||');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Generate a fingerprint for a specific notification panel item.
 * Used for precise notification matching (not event dedup).
 */
export function notificationItemFingerprint({ username, relation, action, content, timeText }) {
  const raw = [
    (username || '').trim(),
    (relation || '').trim(),
    (action || '').trim(),
    ((content || '').trim()).slice(0, 200),
    (timeText || '').trim(),
  ].join('||');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}
