const BLOCK_PATTERNS = /互关|回访|已赞|三连|求关注|私信|加V|加微信|互赞|互粉|刷赞|刷粉|代运营|引流|推广|广告/;

const MAX_COMMENT_LENGTH = 24;

export const FIXED_FALLBACK_TEMPLATES = [
  {
    text: '支持一下',
    commentCategory: 'support',
    replyMode: 'auto_simple',
    riskLevel: 'low',
    reason: 'fixed_fallback_template',
    sourceSignals: ['fallback_no_context'],
    autoExecuteAllowed: false,
  },
  {
    text: '内容不错，来看看',
    commentCategory: 'praise',
    replyMode: 'auto_simple',
    riskLevel: 'low',
    reason: 'fixed_fallback_template',
    sourceSignals: ['fallback_no_context'],
    autoExecuteAllowed: false,
  },
  {
    text: '互相加油',
    commentCategory: 'encouragement',
    replyMode: 'auto_simple',
    riskLevel: 'low',
    reason: 'fixed_fallback_template',
    sourceSignals: ['fallback_no_context'],
    autoExecuteAllowed: false,
  },
];

function isBlocked(text) {
  return BLOCK_PATTERNS.test(text);
}

function truncateComment(text) {
  let result = text;
  if (result.length > MAX_COMMENT_LENGTH) {
    result = result.slice(0, MAX_COMMENT_LENGTH);
    const lastPunct = result.search(/[，。！？、]$/);
    if (lastPunct > MAX_COMMENT_LENGTH - 5) {
      result = result.slice(0, lastPunct);
    }
  }
  return result;
}

function buildContextualCandidates(context) {
  const candidates = [];
  const { targetWorkTitle, captionText, hashtags, authorName } = context;
  const signals = [];

  const titleClean = (targetWorkTitle || '').replace(/抖音| Douyin.*$/g, '').trim();
  const mainHashtag = hashtags && hashtags.length > 0 ? hashtags[0] : '';
  const captionSnippet = (captionText || '').slice(0, 60).replace(/#[^\s#]+/g, '').trim();

  if (titleClean.length >= 2) signals.push(`title:${titleClean.slice(0, 20)}`);
  if (mainHashtag) signals.push(`hashtag:${mainHashtag}`);
  if (captionSnippet.length >= 4) signals.push(`caption:${captionSnippet.slice(0, 20)}`);

  if (mainHashtag) {
    candidates.push({
      text: truncateComment(`${mainHashtag}做得不错`),
      commentCategory: 'praise',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_from_hashtag',
      sourceSignals: [...signals],
      autoExecuteAllowed: false,
    });

    candidates.push({
      text: truncateComment(`关注${mainHashtag}，学到了`),
      commentCategory: 'useful',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_from_hashtag',
      sourceSignals: [...signals],
      autoExecuteAllowed: false,
    });
  }

  if (titleClean.length >= 2 && !mainHashtag) {
    const short = titleClean.slice(0, 8);
    candidates.push({
      text: truncateComment(`${short}不错呀`),
      commentCategory: 'praise',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_from_title',
      sourceSignals: [...signals],
      autoExecuteAllowed: false,
    });

    candidates.push({
      text: truncateComment(`看了${short}，有收获`),
      commentCategory: 'useful',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_from_title',
      sourceSignals: [...signals],
      autoExecuteAllowed: false,
    });
  }

  if (captionSnippet.length >= 4) {
    candidates.push({
      text: truncateComment('内容实用，收藏了'),
      commentCategory: 'useful',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_from_caption',
      sourceSignals: [...signals],
      autoExecuteAllowed: false,
    });
  }

  if (candidates.length < 2) {
    candidates.push({
      text: '分享得挺好的',
      commentCategory: 'praise',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_generic_from_minimal_context',
      sourceSignals: [...signals, 'generic'],
      autoExecuteAllowed: false,
    });

    candidates.push({
      text: '看看，加油',
      commentCategory: 'encouragement',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      reason: 'generated_generic_from_minimal_context',
      sourceSignals: [...signals, 'generic'],
      autoExecuteAllowed: false,
    });
  }

  return candidates.filter(c => {
    if (isBlocked(c.text)) return false;
    if (c.text.length === 0) return false;
    return true;
  }).slice(0, 3);
}

export function generateVisitCommentCandidates(context) {
  if (!context || !context.canGenerateContextualComment) {
    return {
      generatedCommentCandidates: FIXED_FALLBACK_TEMPLATES.map(t => ({ ...t, sourceSignals: ['fallback_no_context'] })),
      usedFallback: true,
    };
  }

  const contextual = buildContextualCandidates(context);
  if (contextual.length === 0) {
    return {
      generatedCommentCandidates: FIXED_FALLBACK_TEMPLATES.map(t => ({ ...t, sourceSignals: ['fallback_no_context'] })),
      usedFallback: true,
    };
  }

  return {
    generatedCommentCandidates: contextual,
    usedFallback: false,
  };
}
