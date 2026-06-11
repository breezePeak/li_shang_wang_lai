import { normalizeRelation, getNoticeCommentText, safeJsonStringify } from './notice-api-normalization.mjs';

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null;
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function isAuthorReplyItem(reply = {}) {
  const labelText = String(reply?.label_text || '').trim();
  const labelType = Number(reply?.label_type ?? 0);
  if (labelText === '作者') return true;
  if (labelType === 1) return true;
  const labels = Array.isArray(reply?.label_list) ? reply.label_list : [];
  return labels.some(label => String(label?.text || '').trim() === '作者');
}

/**
 * 归一化 /aweme/v1/web/comment/list/ 接口返回的单条评论原始数据。
 *
 * 评论文本规则与 notice api 的 getNoticeCommentText 完全一致：
 *   text 有值 → text
 *   sticker 存在 → [表情]
 *   image_list 有内容 → [图片]
 *   video_list 有内容 → [视频]
 *   否则 → ''
 */
export function normalizeCommentListItem(raw = {}) {
  const user = raw?.user || {};
  const cid = String(raw?.cid || '').trim();
  const awemeId = String(raw?.aweme_id || '').trim();
  const replyComments = Array.isArray(raw?.reply_comment) ? raw.reply_comment : [];
  const authorReplies = replyComments.filter(isAuthorReplyItem);

  return {
    cid,
    commentId: cid,
    awemeId,
    commentText: getNoticeCommentText(raw),
    rawText: String(raw?.text || ''),
    createTime: raw?.create_time || null,
    eventTimeText: raw?.create_time ? String(raw.create_time) : '',
    eventCreatedAt: unixToIso(raw?.create_time),
    diggCount: Number(raw?.digg_count || 0),
    replyCommentTotal: Number(raw?.reply_comment_total || 0),
    replyCommentCount: replyComments.length,
    hasAuthorReply: authorReplies.length > 0,
    authorReplyCount: authorReplies.length,
    authorReplyCids: authorReplies.map(reply => String(reply?.cid || '').trim()).filter(Boolean),
    contentType: raw?.content_type ?? null,
    userDigged: Number(raw?.user_digged || 0),
    isAuthorDigged: Boolean(raw?.is_author_digged),
    labelText: raw?.label_text || '',
    relation: normalizeRelation(raw?.label_text || ''),
    actorUid: user?.uid || '',
    actorName: user?.nickname || '',
    actorProfileKey: user?.sec_uid || user?.uid || '',
    actorProfileUrl: user?.sec_uid ? `https://www.douyin.com/user/${user.sec_uid}` : '',
    actorFollowStatus: user?.follow_status ?? null,
    actorFollowerStatus: user?.follower_status ?? null,
    ipLabel: raw?.ip_label || '',
    rawCommentJson: safeJsonStringify(raw),
  };
}
