const QUESTION_PATTERNS = [/怎么/, /如何/, /为什么/, /为啥/, /啥/, /什么/, /\?/, /？/];
const PRAISE_PATTERNS = [/支持/, /不错/, /厉害/, /学到了/, /有用/, /牛[!！~]?$/, /赞/, /干货/, /优秀/, /精彩/, /太好了/, /好看/];

function isMostlyEmoji(text) {
  const emojiRe = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const matches = text.match(emojiRe);
  if (!matches) return false;
  const emojiCount = matches.length;
  const nonSpace = text.replace(/\s/g, '').length;
  return nonSpace > 0 && emojiCount / nonSpace >= 0.5;
}

export function generateReplyText(commentText) {
  if (!commentText || typeof commentText !== 'string') {
    return { replyText: '感谢支持。', reason: 'template:default' };
  }

  const text = commentText.trim();

  for (const pat of QUESTION_PATTERNS) {
    if (pat.test(text)) {
      return { replyText: '这个问题挺关键，后面我可以单独展开讲一下。', reason: 'template:question' };
    }
  }

  for (const pat of PRAISE_PATTERNS) {
    if (pat.test(text)) {
      return { replyText: '感谢支持，一起交流。', reason: 'template:praise' };
    }
  }

  if (text.length <= 3 || isMostlyEmoji(text)) {
    return { replyText: '感谢支持。', reason: 'template:short' };
  }

  return { replyText: '感谢评论，一起交流。', reason: 'template:default' };
}

export function buildPlanItemFromEvent(event) {
  if (!event || !event.id) return null;

  const template = generateReplyText(event.comment_text);

  const item = {
    eventId: event.id,
    approved: false,
    workId: event.target_work_id || '',
    workTitle: event.my_work_title || '',
    workUrl: event.target_work_url || '',
    actorName: event.actor_name || '',
    actorProfileUrl: event.actor_profile_url || '',
    commentText: event.comment_text || '',
    eventTimeText: event.event_time_text || '',
    replyText: template.replyText,
    reason: template.reason,
  };

  return item;
}
