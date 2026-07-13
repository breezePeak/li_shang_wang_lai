const FORBIDDEN_WORDS = ['回访', '互关', '互赞', '已赞', '三连', '求关注', '私信', '加V', '加微信', '联系方式', '引流', '广告', '刷赞', '刷粉', '代运营', '推广', '互粉', '老哥', '老妹', '老弟', '兄弟', '哥们', '帅哥', '美女', '小姐姐', '小哥哥', '妹子', '姐们', '大哥', '大姐'];

const FORBIDDEN_PATTERN = new RegExp(FORBIDDEN_WORDS.join('|'));

export { FORBIDDEN_WORDS, FORBIDDEN_PATTERN };

export function validateSelectedComment({ text, replyMode, riskLevel, manualReviewMethod }) {
  const errors = [];
  const warnings = [];

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    errors.push('selectedCommentText is empty');
  }

  if (text) {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const totalLen = text.length;

    if (totalLen > 40) {
      errors.push(`comment too long: ${totalLen} chars (max 40)`);
    }

    if (chineseChars > 0 && chineseChars < 8) {
      warnings.push(`chinese char count ${chineseChars} below recommended minimum 8`);
    }

    if (chineseChars > 24) {
      warnings.push(`chinese char count ${chineseChars} exceeds recommended max 24`);
    }

    if (FORBIDDEN_PATTERN.test(text)) {
      const matched = FORBIDDEN_WORDS.filter(w => text.includes(w));
      errors.push(`forbidden words: ${matched.join(',')}`);
    }
  }

  if (riskLevel === 'high') {
    errors.push('riskLevel=high is not allowed');
  }

  if (replyMode === 'ignore') {
    errors.push('replyMode=ignore is not allowed');
  }

  if (!manualReviewMethod) {
    errors.push('no manualReviewMethod (user selection required)');
  }

  const isLowAuto = riskLevel === 'low' && replyMode === 'auto_simple' && manualReviewMethod === 'user_selected_template';
  const isMedAgent = riskLevel === 'medium' && replyMode === 'agent_generated_review_required' && manualReviewMethod === 'user_selected_agent_comment';

  if (!isLowAuto && !isMedAgent && errors.length === 0) {
    errors.push(`invalid combination: riskLevel=${riskLevel}, replyMode=${replyMode}, manualReviewMethod=${manualReviewMethod}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function isExecuteAllowed(candidate, record) {
  if (!candidate) return false;
  if (!record || !record.selectedCommentText) return false;
  const validation = validateSelectedComment({
    text: record.selectedCommentText,
    replyMode: candidate.replyMode,
    riskLevel: candidate.riskLevel,
    manualReviewMethod: record.manualReviewMethod,
  });
  return validation.valid;
}
