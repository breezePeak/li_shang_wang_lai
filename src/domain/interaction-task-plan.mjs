const INTENT_PATTERNS = {
  visitBack: /回访|主页互动|去.*主页|互动一下|回赞|回关/,
  replyComment: /回复|回评|评论.*回|评论.*回复/,
  viewOnly: /看看|看下|查看|有什么互动|谁.*互动|谁.*点赞|谁.*评论/,
  like: /点赞|赞/,
  comment: /评论|回评|回复/,
  reply: /回复我的|回复了我/,
  follow: /关注/,
};

function normalizeCollectTypes(types) {
  const allowed = new Set(['like', 'comment', 'reply', 'follow', 'other']);
  const result = [];
  for (const type of types || []) {
    const value = String(type || '').trim().toLowerCase();
    if (allowed.has(value) && !result.includes(value)) result.push(value);
  }
  return result.length > 0 ? result : ['like', 'comment', 'reply', 'follow'];
}

export function parseIntent(userInput = '', options = {}) {
  const text = String(userInput || '');
  const visitBack = Boolean(options.visitBack ?? INTENT_PATTERNS.visitBack.test(text));
  const replyComment = Boolean(options.replyComment ?? INTENT_PATTERNS.replyComment.test(text));

  let collectTypes = [];
  if (Array.isArray(options.collectTypes) && options.collectTypes.length > 0) {
    collectTypes = options.collectTypes;
  } else {
    if (INTENT_PATTERNS.like.test(text)) collectTypes.push('like');
    if (INTENT_PATTERNS.comment.test(text)) collectTypes.push('comment');
    if (INTENT_PATTERNS.reply.test(text)) collectTypes.push('reply');
    if (INTENT_PATTERNS.follow.test(text)) collectTypes.push('follow');
    if (collectTypes.length === 0) collectTypes = ['like', 'comment', 'reply', 'follow'];
  }

  if (replyComment && !collectTypes.includes('comment')) collectTypes.push('comment');

  return {
    collect: options.collect !== false,
    replyComment,
    visitBack,
    viewOnly: !replyComment && !visitBack,
    collectTypes: normalizeCollectTypes(collectTypes),
    days: Number(options.days) > 0 ? Number(options.days) : 7,
    maxCount: Number(options.maxCount) > 0 ? Number(options.maxCount) : 100,
  };
}

export function buildExecutionPlan(userInput = '', options = {}) {
  const intent = parseIntent(userInput, options);
  return {
    ...intent,
    generateReplyJson: intent.replyComment,
    generateVisitJson: intent.visitBack,
    executeReply: intent.replyComment && options.execute === true,
    executeVisit: intent.visitBack && options.execute === true,
  };
}
