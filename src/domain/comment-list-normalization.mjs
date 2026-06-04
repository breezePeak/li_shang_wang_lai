import { normalizeRelation, getNoticeCommentText, safeJsonStringify } from './notice-api-normalization.mjs';

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

  return {
    cid,
    commentId: cid,
    awemeId,
    commentText: getNoticeCommentText(raw),
    rawText: String(raw?.text || ''),
    createTime: raw?.create_time || null,
    eventTimeText: raw?.create_time ? String(raw.create_time) : '',
    diggCount: Number(raw?.digg_count || 0),
    replyCommentTotal: Number(raw?.reply_comment_total || 0),
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
