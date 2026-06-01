const QUESTION_PATTERNS = [/怎么/, /如何/, /为什么/, /为啥/, /啥/, /什么/, /\?/, /？/];
const PRAISE_PATTERNS = [/支持/, /不错/, /厉害/, /学到了/, /有用/, /牛[!！~]?$/, /赞/, /干货/, /优秀/, /精彩/, /太好了/, /好看/];
const REPLY_SCENE_RULES = [
  { key: 'script_hack', priority: 100, pattern: /脚本|魔改|注册机|验证码|临时邮箱|代理|proxy|bug|调试/, subject: '脚本折腾过程' },
  { key: 'ai_tooling', priority: 90, pattern: /openclaw|codex|chatgpt|agent|deepseek|qwen|千问|模型|AI/i, subject: 'AI工具实践' },
  { key: 'coding', priority: 80, pattern: /代码|编程|开发|前端|后端|接口|工程|程序员/, subject: '技术实现思路' },
  { key: 'tutorial', priority: 70, pattern: /教程|步骤|方法|技巧|教学|干货|怎么|如何/, subject: '步骤细节' },
  { key: 'life', priority: 10, pattern: /生活|日常|记录|vlog|真实|通勤/, subject: '日常记录' },
];

function isMostlyEmoji(text) {
  const emojiRe = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const matches = text.match(emojiRe);
  if (!matches) return false;
  const emojiCount = matches.length;
  const nonSpace = text.replace(/\s/g, '').length;
  return nonSpace > 0 && emojiCount / nonSpace >= 0.5;
}

function compactTopic(text, maxLength = 12) {
  return String(text || '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:"'`()（）【】\[\]<>《》]/g, '')
    .slice(0, maxLength);
}

function analyzeReplyContext({ workTitle = '', workText = '', referenceComments = [] } = {}) {
  const fullText = [
    workTitle,
    workText,
    ...(Array.isArray(referenceComments) ? referenceComments : []),
  ].filter(Boolean).join(' ');
  const scene = REPLY_SCENE_RULES
    .filter(rule => rule.pattern.test(fullText))
    .sort((a, b) => b.priority - a.priority)[0];
  const topic = scene?.subject || compactTopic(workTitle || workText);
  return {
    hasContext: Boolean(String(workTitle || workText).trim() || (Array.isArray(referenceComments) && referenceComments.length > 0)),
    topic,
    sceneKey: scene?.key || '',
  };
}

function buildContextualReply(commentText, { workTitle = '', workText = '', referenceComments = [] } = {}) {
  const context = analyzeReplyContext({ workTitle, workText, referenceComments });
  if (!context.hasContext || !context.topic) return null;

  const text = String(commentText || '').trim();
  if (QUESTION_PATTERNS.some(pat => pat.test(text))) {
    return {
      replyText: `这个问题和${context.topic}有关，后面我展开说。`,
      reason: `template:question_context:${context.sceneKey || 'title'}`,
    };
  }

  if (PRAISE_PATTERNS.some(pat => pat.test(text))) {
    return {
      replyText: `感谢认可，这条主要想把${context.topic}讲清楚。`,
      reason: `template:praise_context:${context.sceneKey || 'title'}`,
    };
  }

  if (text.length > 3 && !isMostlyEmoji(text)) {
    return {
      replyText: `感谢评论，这条想聊的就是${context.topic}。`,
      reason: `template:default_context:${context.sceneKey || 'title'}`,
    };
  }

  return null;
}

export function generateReplyText(commentText, { workTitle = '', workText = '', referenceComments = [] } = {}) {
  if (!commentText || typeof commentText !== 'string') {
    return { replyText: '感谢支持。', reason: 'template:default' };
  }

  const text = commentText.trim();
  const contextual = buildContextualReply(text, { workTitle, workText, referenceComments });
  if (contextual) return contextual;

  for (const pat of QUESTION_PATTERNS) {
    if (pat.test(text)) {
      if (workTitle) {
        return { replyText: `关于「${workTitle}」这个问题挺关键，后面我可以单独展开讲一下。`, reason: 'template:question_with_title' };
      }
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

  if (workTitle) {
    return { replyText: `感谢评论，一起交流。`, reason: 'template:default_with_title' };
  }

  return { replyText: '感谢评论，一起交流。', reason: 'template:default' };
}
