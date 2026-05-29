import crypto from 'crypto';

// Relative time patterns: values that change between scans.
// "昨天HH:mm" / "前天HH:mm" also drift (absolute date shifts daily).
const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
const DAY_RELATIVE_RE = /^(昨天|前天)\s*\d{1,2}:\d{2}$/;

function isRelativeTime(text) {
  const t = (text || '').trim();
  return RELATIVE_TIME_RE.test(t) || DAY_RELATIVE_RE.test(t);
}

/**
 * Normalize relative day times to absolute dates.
 * "昨天 23:44" → "2026-05-28 23:44"
 * Non-relative times return as-is.
 */
export function normalizeTimeText(timeText) {
  const t = (timeText || '').trim();
  if (!DAY_RELATIVE_RE.test(t)) return t;
  const now = new Date();
  const match = t.match(/^(昨天|前天)/);
  if (!match) return t;
  const days = match[1] === '昨天' ? 1 : 2;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = n => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = t.replace(/^(昨天|前天)\s*/, '');
  return `${datePart} ${timePart}`;
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
/**
 * Generate a robust fingerprint for notification events (likes, comments).
 *
 * Priority order:
 * 1. platformEventId (stable DOM attribute)
 * 2. workId (target work identifier, distinguishes same-user interactions on different works)
 * 3. actorId + action + textSummary (excludes relative time)
 *
 * Returns { fp, confidence: 'strong' | 'weak' } to allow downstream filtering.
 */
export function notificationFingerprint({ eventType, username, actorProfileKey, actorProfileUrl, action, content, timeText, rawText, notificationItemKey, platformEventId, workId }) {
  if ((platformEventId || '').trim()) {
    return {
      fp: crypto.createHash('sha256').update('notify:pid:' + platformEventId.trim()).digest('hex').slice(0, 16),
      confidence: 'strong',
    };
  }

  if ((workId || '').trim()) {
    const actorId = (actorProfileKey || '').trim() || (actorProfileUrl || '').trim() || (username || '').trim();
    // For comments, include commentText so same user + same work + different comment = different event
    const textSummary = ((content || '').trim()).slice(0, 200);
    const raw = [eventType, actorId, workId.trim(), (action || '').trim(), textSummary]
      .map(s => s || '').join('||');
    return {
      fp: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
      confidence: 'strong',
    };
  }

  // No stable identifier — fallback with weak confidence.
  // Exclude rawText (contains relative time) entirely; use only content.
  const actorId = (actorProfileKey || '').trim() || (actorProfileUrl || '').trim() || (username || '').trim();
  const actionPart = (action || '').trim();
  const textSummary = ((content || '').trim()).slice(0, 200);

  const raw = [eventType, actorId, actionPart, textSummary]
    .map(s => s || '').join('||');
  return {
    fp: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16),
    confidence: 'weak',
  };
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
