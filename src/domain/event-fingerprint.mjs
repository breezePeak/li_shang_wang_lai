import crypto from 'crypto';

/**
 * Generate a deduplication fingerprint for an interaction event.
 * Hash of: eventType + actorName + targetWork + content + timeText
 */
export function generateFingerprint(eventType, actorName, targetWork, content, timeText) {
  const raw = [eventType, actorName, targetWork, content, timeText]
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
