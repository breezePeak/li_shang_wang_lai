import { buildDouyinWorkUrl } from '../utils/douyin-url.mjs';

export function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

export function normalizeRelation(text) {
  const value = String(text || '').trim();
  if (!value) return 'unknown';
  if (value.includes('互相关注')) return 'mutual';
  if (value.includes('朋友')) return 'friend';
  return 'unknown';
}

export function getNoticeCreateTimeMs(item) {
  const raw = Number(item?.create_time || 0);
  return raw > 0 ? raw * 1000 : null;
}

export function buildNoticeRawPayloadJson(item) {
  return safeJsonStringify(item);
}

export function getNoticeWorkIdentity(item) {
  const commentAweme = item?.comment?.aweme || {};
  const diggAweme = item?.digg?.aweme || {};
  const aweme = Object.keys(commentAweme).length > 0 ? commentAweme : diggAweme;
  const awemeId = String(item?.aweme_id || item?.comment?.comment?.aweme_id || item?.digg?.forward_id || aweme?.aweme_id || '');

  return {
    workId: awemeId || '',
    workUrl: buildDouyinWorkUrl(awemeId),
    workTitle: aweme?.desc || '',
    workType: aweme?.aweme_type != null ? String(aweme.aweme_type) : null,
    workCreateTime: aweme?.create_time || null,
    thumbnailKey: aweme?.video?.cover?.uri || aweme?.images?.[0]?.uri || '',
    thumbnailSrc: aweme?.video?.cover?.url_list?.[0] || aweme?.images?.[0]?.url_list?.[0] || '',
  };
}

export function getNoticeActorIdentity(item) {
  const commentActor = item?.comment?.comment?.user || {};
  const diggActor = item?.digg?.from_user?.[0] || {};
  const actor = Object.keys(commentActor).length > 0 ? commentActor : diggActor;
  const actorProfileKey = actor?.sec_uid || actor?.uid || '';

  return {
    actorName: actor?.nickname || '',
    actorProfileKey,
    actorProfileUrl: actor?.sec_uid ? `https://www.douyin.com/user/${actor.sec_uid}` : '',
    actorUid: actor?.uid || '',
  };
}

export function getNoticeCommentText(c = {}) {
  const text = String(c?.text || '').trim();
  if (text) return text;

  if (c?.sticker) return '[表情]';

  if (Array.isArray(c?.image_list) && c.image_list.length > 0) {
    return '[图片]';
  }

  if (Array.isArray(c?.video_list) && c.video_list.length > 0) {
    return '[视频]';
  }

  return '';
}

export function classifyCommentNotice(item = {}) {
  const block = item?.comment || {};
  const c = block?.comment || {};

  const bizId = Number(item?.interactive_biz_id || 0);
  const commentType = Number(block?.comment_type || 0);

  const awemeId = String(
    item?.aweme_id ||
    block?.forward_id ||
    c?.aweme_id ||
    ''
  ).trim();

  const parentId = String(block?.parent_id || '').trim();
  const hasReplyComment = !!block?.reply_comment;

  // 回复了你的评论
  if (
    bizId === 1003102 ||
    commentType === 2 ||
    (hasReplyComment && parentId && awemeId && parentId !== awemeId)
  ) {
    return 'reply_to_my_comment';
  }

  // 评论了你的作品
  if (
    bizId === 1003101 ||
    commentType === 1 ||
    !parentId ||
    (parentId && awemeId && parentId === awemeId)
  ) {
    return 'comment_on_my_work';
  }

  return 'unknown_comment_notice';
}

export function normalizeCommentNotice(item) {
  const kind = classifyCommentNotice(item);
  const commentBlock = item?.comment || {};
  const c = commentBlock?.comment || {};
  const work = getNoticeWorkIdentity(item);
  const actor = getNoticeActorIdentity(item);
  const notificationId = item?.nid_str || String(item?.nid || '');
  const commentId = String(c?.cid || '');
  const commentText = getNoticeCommentText(c);

  console.error(
    `[notice-api] classified comment notice` +
    ` nid=${notificationId}` +
    ` biz=${item?.interactive_biz_id || '-'}` +
    ` commentType=${commentBlock?.comment_type || '-'}` +
    ` parent=${commentBlock?.parent_id || '-'}` +
    ` aweme=${work.workId}` +
    ` action=${kind}` +
    ` reason=${kind}`
  );

  const base = {
    notificationId,
    platformEventId: commentId || notificationId,
    ...actor,
    relation: normalizeRelation(commentBlock?.label_text || commentBlock?.label_list?.[0]?.text || ''),
    commentText,
    commentId,
    eventTimeText: item?.create_time ? String(item.create_time) : '',
    eventTimestamp: item?.create_time || null,
    ...work,
    rawPayloadJson: buildNoticeRawPayloadJson(item),
  };

  if (kind === 'reply_to_my_comment') {
    return {
      ...base,
      eventType: 'reply',
      notificationAction: 'reply_to_my_comment',
      originalCommentText: String(commentBlock?.reply_comment?.text || ''),
    };
  }

  if (kind === 'comment_on_my_work') {
    return {
      ...base,
      eventType: 'comment',
      notificationAction: 'comment_on_my_work',
    };
  }

  return {
    ...base,
    eventType: 'unknown',
    notificationAction: 'unknown_comment_notice',
  };
}

export function normalizeDiggNotice(item) {
  const digg = item?.digg || {};
  const work = getNoticeWorkIdentity(item);
  const actor = getNoticeActorIdentity(item);
  const notificationId = item?.nid_str || String(item?.nid || '');

  return {
    eventType: 'like',
    notificationAction: 'like_received',
    notificationId,
    platformEventId: notificationId,
    ...actor,
    relation: normalizeRelation(digg?.label_text || digg?.label_list?.[0]?.text || ''),
    commentText: null,
    commentId: String(digg?.real_cid || digg?.cid || ''),
    eventTimeText: item?.create_time ? String(item.create_time) : '',
    eventTimestamp: item?.create_time || null,
    ...work,
    rawPayloadJson: buildNoticeRawPayloadJson(item),
  };
}

export function normalizeNoticeApiItem(item) {
  if (!item) return null;
  if (item.type === 31 && item.comment) return normalizeCommentNotice(item);
  if (item.type === 41 && item.digg) return normalizeDiggNotice(item);
  return null;
}
