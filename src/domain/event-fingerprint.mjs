import crypto from 'crypto';

const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;

function isRelativeTime(text) {
  return RELATIVE_TIME_RE.test((text || '').trim());
}

/**
 * Generate a deduplication fingerprint for an interaction event.
 * Relative time (e.g. "3分钟前") is excluded from the fingerprint
 * because it drifts between scans and causes false duplicates.
 */
export function generateFingerprint(eventType, actorName, targetWork, content, timeText) {
  const timePart = isRelativeTime(timeText) ? '' : (timeText || '').trim();
  const raw = [eventType, actorName, targetWork, content, timePart]
    .map(s => (s || '').trim())
    .join('||');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Generate fingerprint from a comment object.
 */
export function commentFingerprint(comment, workTitle) {
  return generateFingerprint(
    'comment',
    comment.username,
    workTitle,
    comment.content,
    comment.timeText,
  );
}

/**
 * Generate a robust fingerprint for notification events (likes, comments).
 * Unlike the generic generateFingerprint, this includes profile identifiers
 * (actorProfileKey or actorProfileUrl) for stable dedup even if nicknames change.
 *
 * Priority order: actorProfileKey > actorProfileUrl > username
 */
export function notificationFingerprint({ eventType, username, actorProfileKey, actorProfileUrl, action, content, timeText, rawText }) {
  // Use profile key as primary identifier when available; fall back to URL, then name
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
 * This is used for precise notification matching (not event dedup).
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
