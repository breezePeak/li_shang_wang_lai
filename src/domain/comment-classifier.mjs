// 礼尚往来 · 简单互动本地分类器
// 不依赖 Agent，基于关键词和模式匹配进行离线分类。
// classifyComment 返回分类结果，包含候选回复（仅模板池）和风险等级。

// ---- 安全模板池（auto_simple_candidate 只能从这里选回复） ----
const TEMPLATES = {
  support: ['感谢支持～', '收到支持啦～'],
  praise: ['谢谢认可～', '感谢认可，继续折腾～'],
  useful: ['能帮上忙就好～', '有用就好，感谢支持～'],
  encouragement: ['谢谢鼓励，继续努力～'],
};

// ---- 阻断关键词（命中任意 → ignore + high + replyText=null） ----
const BLOCK_KEYWORDS = [
  '刷赞', '刷粉', '互赞', '互关', '养号',
  '绕风控', '绕过', '绕过检测', '绕过验证', '绕过审核',
  '破解', '盗号', 'Cookie', 'Token', 'token',
  '验证码绕过',
  '批量', '自动化脚本', '代运营', '代回复',
  '封号', '举报',
  '加微信', '加V', 'VX', 'vx',
  '引流', '推广', '广告',
  '联系我', '私聊',
];

// ---- 需审核关键词（命中任意 → needs_review） ----
const REVIEW_KEYWORDS = [
  '怎么', '如何', '能不能', '可以吗', '行吗', '行不行',
  '求教程', '求教', '求分享', '出一期', '讲一下',
  '开源吗', '能不能开源', '源码', '代码',
  '安全吗', '稳定吗', '靠谱吗', '能用吗',
  '价格', '多少钱', '收费', '免费',
  '配置', '部署', '安装',
  '链接', '下载', '在哪', '哪里',
  '更新', '版本', '升级',
];

// ---- 问句标记 ----
const QUESTION_MARKS = /[?？吗么]/;
const REQUEST_PATTERNS = /(^|[^不])求|出[一]?[期个]|分享[一]?[下个]|发[一]?[下个]|教[一]?[下个]/;

// ---- 简单正向模式（仅当非阻断、非需审核时允许 auto_simple_candidate） ----
// 匹配这些模式的评论，可以自动归类为简单正向互动
const SIMPLE_POSITIVE_PATTERNS = [
  // 支持类
  { pattern: /^支持[\u4e00-\u9fa5]*$/, category: 'support', templateKey: 'support' },
  { pattern: /支持[一]?[下个]/, category: 'support', templateKey: 'support' },
  // 赞赏类
  { pattern: /厉害/, category: 'praise', templateKey: 'praise' },
  { pattern: /讲得[真很]好/, category: 'praise', templateKey: 'praise' },
  { pattern: /很棒/, category: 'praise', templateKey: 'praise' },
  { pattern: /太强/, category: 'praise', templateKey: 'praise' },
  { pattern: /牛/, category: 'praise', templateKey: 'praise' },
  // 有用类
  { pattern: /学到/, category: 'useful', templateKey: 'useful' },
  { pattern: /有用/, category: 'useful', templateKey: 'useful' },
  { pattern: /干货/, category: 'useful', templateKey: 'useful' },
  { pattern: /分享[真很]?有用/, category: 'useful', templateKey: 'useful' },
  { pattern: /感谢分享/, category: 'useful', templateKey: 'useful' },
  { pattern: /谢谢分享/, category: 'useful', templateKey: 'useful' },
  // 鼓励类
  { pattern: /加油/, category: 'encouragement', templateKey: 'encouragement' },
  { pattern: /继续/, category: 'encouragement', templateKey: 'encouragement' },
  { pattern: /期待/, category: 'encouragement', templateKey: 'encouragement' },
  { pattern: /已三连/, category: 'encouragement', templateKey: 'encouragement' },
  { pattern: /三连/, category: 'encouragement', templateKey: 'encouragement' },
  { pattern: /关注/, category: 'encouragement', templateKey: 'encouragement' },
];

// ---- 模板选择 ----
function pickTemplate(category) {
  const pool = TEMPLATES[category];
  if (!pool || pool.length === 0) return '';
  return pool[0]; // deterministic: always first template
}

/**
 * 检查文本是否包含任一关键词（大小写不敏感）
 */
function containsAnyKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * 本地分类器：基于关键词+模式对评论进行分类。
 *
 * @param {string} commentText - 评论原文
 * @returns {{
 *   commentCategory: string,
 *   replyMode: 'auto_simple_candidate' | 'needs_review' | 'ignore',
 *   riskLevel: 'low' | 'medium' | 'high',
 *   reason: string,
 *   replyText: string,
 *   autoExecuteAllowed: false
 * }}
 */
export function classifyComment(commentText) {
  const text = (commentText || '').trim();

  // 空文本 → needs_review
  if (!text) {
    return {
      commentCategory: 'unclear',
      replyMode: 'needs_review',
      riskLevel: 'medium',
      reason: '空评论文本',
      replyText: '',
      autoExecuteAllowed: false,
    };
  }

  // ---- Step 1: BLOCK_KEYWORDS check ----
  if (containsAnyKeyword(text, BLOCK_KEYWORDS)) {
    return {
      commentCategory: 'spam',
      replyMode: 'ignore',
      riskLevel: 'high',
      reason: '评论包含违规/运营风险关键词',
      replyText: '',
      autoExecuteAllowed: false,
    };
  }

  // ---- Step 2: REVIEW_KEYWORDS / question mark / request pattern ----
  if (containsAnyKeyword(text, REVIEW_KEYWORDS) ||
      QUESTION_MARKS.test(text) ||
      REQUEST_PATTERNS.test(text)) {
    return {
      commentCategory: 'question',
      replyMode: 'needs_review',
      riskLevel: 'medium',
      reason: '评论包含问句、请求或需审核关键词',
      replyText: '',
      autoExecuteAllowed: false,
    };
  }

  // ---- Step 3: SIMPLE_POSITIVE_PATTERNS ----
  for (const { pattern, category, templateKey } of SIMPLE_POSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        commentCategory: category,
        replyMode: 'auto_simple_candidate',
        riskLevel: 'low',
        reason: `匹配简单正向模式: ${category}`,
        replyText: pickTemplate(templateKey),
        autoExecuteAllowed: false,
      };
    }
  }

  // ---- Step 4: Default → needs_review (conservative) ----
  return {
    commentCategory: 'unclear',
    replyMode: 'needs_review',
    riskLevel: 'medium',
    reason: '无法确定评论意图，默认需人工审核',
    replyText: '',
    autoExecuteAllowed: false,
  };
}
