function safeJsonStringify(value) {
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
    workUrl: awemeId ? `https://www.douyin.com/video/${awemeId}` : '',
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

export function normalizeCommentNotice(item) {
  const commentBlock = item?.comment || {};
  const c = commentBlock?.comment || {};
  const work = getNoticeWorkIdentity(item);
  const actor = getNoticeActorIdentity(item);
  const notificationId = item?.nid_str || String(item?.nid || '');
  const commentId = String(c?.cid || '');

  return {
    eventType: 'comment',
    notificationAction: 'comment_on_my_work',
    notificationId,
    platformEventId: commentId || notificationId,
    ...actor,
    relation: normalizeRelation(commentBlock?.label_text || commentBlock?.label_list?.[0]?.text || ''),
    commentText: c?.text || '',
    commentId,
    eventTimeText: item?.create_time ? String(item.create_time) : '',
    eventTimestamp: item?.create_time || null,
    ...work,
    rawPayloadJson: buildNoticeRawPayloadJson(item),
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
