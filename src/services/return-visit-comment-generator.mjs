const MIN_COMMENT_LENGTH = 12;
const MAX_COMMENT_LENGTH = 30;
const BLOCK_PATTERNS = /互关|回访|私信|引流|加微信|加V|推广|广告|代运营|刷粉|刷赞|返现|抽奖|关注我/;

const TYPE_PATTERNS = {
  tutorial: /教程|步骤|技巧|方法|教学|干货|入门|攻略|怎么|如何|收藏/,
  viewpoint: /观点|看法|思考|复盘|认知|讨论|角度|启发|判断|反思/,
  life: /生活|日常|vlog|记录|通勤|家庭|碎碎念|真实|共鸣|心情/,
  tool: /工具|软件|插件|平台|模板|效率|场景|功能|网站|应用/,
  tech: /技术|代码|开发|编程|前端|后端|算法|架构|调试|工程|AI|模型/,
};

const COMMENT_LIBRARY = {
  tutorial: [
    '这个讲解挺实用的，准备按你的步骤试试。',
    '步骤拆得很清楚，后面可以再展开一点细节。',
    '这条内容很有参考价值，先收藏慢慢实践。',
  ],
  viewpoint: [
    '这个角度挺有启发，读完确实有新思路。',
    '观点表达得很清晰，看完有不少共鸣。',
    '这段分析很到位，很多细节值得再琢磨。',
  ],
  life: [
    '内容很真实有共鸣，看完感觉很接地气。',
    '这种表达挺自然的，生活感拿捏得很好。',
    '分享很真诚，很多场景看着特别有代入感。',
  ],
  tool: [
    '这个场景确实实用，准备抽空试一下。',
    '这套方法很落地，刚好能解决实际问题。',
    '工具思路挺清楚的，应用场景也讲明白了。',
  ],
  tech: [
    '思路梳理得很清楚，细节部分很有参考。',
    '这条技术分享很扎实，关键点讲得明白。',
    '方案拆解挺到位的，代码思路很清晰。',
  ],
  generic: [
    '这个分享挺实用的，后面可以再展开讲讲。',
    '内容表达很顺畅，读完确实有一些收获。',
    '这条内容质量不错，很多点都很有帮助。',
  ],
};

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:"'`()（）【】\[\]<>《》]/g, '')
    .trim();
}

function containsBlockedPattern(text) {
  return BLOCK_PATTERNS.test(text);
}

function classifyContentType(fullText) {
  const text = String(fullText || '');
  for (const [type, pattern] of Object.entries(TYPE_PATTERNS)) {
    if (pattern.test(text)) return type;
  }
  return 'generic';
}

function calcSeed(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function isLengthValid(text) {
  return text.length >= MIN_COMMENT_LENGTH && text.length <= MAX_COMMENT_LENGTH;
}

function isCopyFromReferences(candidate, references) {
  const n = normalizeText(candidate);
  if (!n) return true;
  for (const ref of references) {
    const r = normalizeText(ref);
    if (!r) continue;
    if (n === r) return true;
    if (r.length >= 8 && n.includes(r)) return true;
    if (n.length >= 8 && r.includes(n)) return true;
  }
  return false;
}

function chooseCandidatesByType(type, seed) {
  const templates = COMMENT_LIBRARY[type] || COMMENT_LIBRARY.generic;
  if (templates.length <= 1) return templates.slice();

  const shift = seed % templates.length;
  const rotated = [];
  for (let i = 0; i < templates.length; i++) {
    rotated.push(templates[(i + shift) % templates.length]);
  }
  return rotated;
}

export function generateReturnVisitComment(input = {}) {
  const workTitle = String(input.workTitle || '').trim();
  const workText = String(input.workText || '').trim();
  const contentSummary = String(input.contentSummary || '').trim();
  const referenceComments = Array.isArray(input.referenceComments) ? input.referenceComments : [];

  const fullText = [workTitle, workText, contentSummary].filter(Boolean).join(' ');
  const stripped = normalizeText(fullText);
  if (stripped.length < 8) {
    return {
      ok: false,
      reason: 'content_too_short',
      contentType: 'generic',
      comment: null,
      candidates: [],
    };
  }

  const contentType = classifyContentType(fullText);
  const seed = calcSeed(`${workTitle}|${workText}|${contentSummary}`);
  const candidates = chooseCandidatesByType(contentType, seed);

  const accepted = [];
  for (const candidate of candidates) {
    if (!isLengthValid(candidate)) continue;
    if (containsBlockedPattern(candidate)) continue;
    if (/[!！]/.test(candidate)) continue;
    if (isCopyFromReferences(candidate, referenceComments)) continue;
    accepted.push(candidate);
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      reason: 'no_safe_candidate',
      contentType,
      comment: null,
      candidates: [],
    };
  }

  return {
    ok: true,
    reason: `${contentType}_template`,
    contentType,
    comment: accepted[0],
    candidates: accepted,
  };
}
