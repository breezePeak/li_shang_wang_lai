// 礼尚往来 · 安全回复模板池
// auto_simple 回复只能从模板池中选取，不允许自由生成承诺型内容。

export const REPLY_TEMPLATES = {
  praise: [
    '谢谢认可～',
    '感谢支持，继续折腾～',
    '哈哈谢谢，一起进步～',
  ],
  encouragement: [
    '谢谢鼓励，继续努力～',
    '感谢关注，持续更新中～',
    '有你们的支持真好～',
  ],
  useful: [
    '能帮上忙就好～',
    '有用就好，感谢支持～',
    '对大家有帮助就是最好的反馈～',
  ],
};

// All allowed auto_simple reply texts (flattened for validation)
const ALL_ALLOWED = new Set();
for (const group of Object.values(REPLY_TEMPLATES)) {
  for (const t of group) {
    ALL_ALLOWED.add(t);
  }
}

/**
 * Check if the given reply text is in the allowed template pool.
 */
export function isAllowedTemplate(text) {
  return ALL_ALLOWED.has((text || '').trim());
}

/**
 * Get allowed templates for a given category.
 */
export function getTemplatesForCategory(category) {
  return REPLY_TEMPLATES[category] || [];
}
