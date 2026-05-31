const MIN_COMMENT_LENGTH = 14;
const MAX_COMMENT_LENGTH = 36;

// 原始敏感特征正则
const BLOCK_PATTERNS = /互关|回访|私信|引流|加微信|加V|推广|广告|代运营|刷粉|刷赞|返现|抽奖|关注我/;

const TYPE_PATTERNS = {
  tutorial: /教程|步骤|技巧|方法|教学|干货|入门|攻略|怎么|如何|收藏/,
  viewpoint: /观点|看法|思考|复盘|认知|讨论|角度|启发|判断|反思/,
  life: /生活|日常|vlog|记录|通勤|家庭|碎碎念|真实|共鸣|心情/,
  tool: /工具|软件|插件|平台|模板|效率|场景|功能|网站|应用/,
  tech: /技术|代码|开发|编程|前端|后端|算法|架构|调试|工程|AI|模型/,
};

// 全小猿人格模板金句库 (字数均在 28-34 之间，符合 14-36 字符强要求)
const COMMENT_LIBRARY = {
  tutorial: [
    '小猿觉得这个视频步骤拆解得挺清楚的，后面可以再多展开一些细节。',
    '小猿看完觉得这个方法很落地，正好解决了很多新手遇到的实际问题。',
    '小猿觉得这种实用的技术技巧讲解，细节部分还是挺有参考意义的。',
  ],
  viewpoint: [
    '小猿看完觉得这个思考角度挺有启发，读完以后确实带来了一些新思路。',
    '小猿觉得这种观点表达得很清晰自然，看完之后内心产生了挺多共鸣的。',
    '小猿看完觉得这段技术复盘很扎实到位，有很多点值得再反复琢磨一下。',
  ],
  life: [
    '小猿看完感觉内容挺用心的，日常记录的很多场景看着特别有接地气代入感。',
    '小猿觉得这种真实日常碎碎念挺有代入感的，生活感被拿捏得挺不错的。',
    '小猿觉得这种自然的日常分享很真实，很多地方看着特别容易让人产生共鸣。',
  ],
  tool: [
    '小猿看完觉得这套工具的思路和应用场景讲得非常明白，很能解决实际痛点。',
    '小猿觉得这套落地方法思路特别清晰，日常工作里很多地方都能应用起来。',
    '小猿觉得这个工具分享思路挺落地实用的，抽空一定要好好研究一下。',
  ],
  tech: [
    '小猿看完觉得这个方案拆解得挺到位的，底层的代码与工程思路非常清晰。',
    '小猿觉得这次的技术开发分享质量很高，很多关键的硬核技术点都讲明白了。',
    '小猿看完觉得思路梳理得挺清楚的，技术实现的细节描述很有参考借鉴价值。',
  ],
  generic: [
    '小猿看完觉得这个内容梳理得很清晰自然，读完以后确实有一些不错的启发。',
    '小猿觉得这个用心的分享非常有参考价值，很多观点和方法都讲得很明白。',
    '小猿觉得这篇精心整理的内容逻辑挺通顺的，许多建议都给得很诚恳到位。',
  ],
};

// 绝对安全的小猿泛化兜底库，用于无合适候选或内容严重不足时的安全返回
const ABSOLUTE_GENERIC_SAFETY = [
  '小猿看完觉得这个内容梳理得很清晰自然，读完以后确实有一些不错的启发。',
  '小猿觉得这个用心的分享非常有参考价值，很多观点和方法都讲得很明白。',
  '小猿觉得这篇精心整理的内容逻辑挺通顺的，许多建议都给得很诚恳到位。',
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:"'`()（）【】\[\]<>《》]/g, '')
    .trim();
}

function classifyContentType(fullText) {
  const text = String(fullText || '');
  for (const [type, pattern] of Object.entries(TYPE_PATTERNS)) {
    if (pattern.test(text)) return type;
  }
  return 'generic';
}

function analyzeReferenceComments(referenceComments) {
  const text = (referenceComments || []).join(' ');
  if (/笑|哈哈|可爱|有趣|好玩|开心|欢乐/.test(text)) return 'light';
  if (/真实|生活|日常|共鸣|感动|舒服/.test(text)) return 'real';
  if (/学到|干货|有用|收藏|步骤|清楚|细节/.test(text)) return 'useful';
  if (/观点|思路|认同|说得对|启发/.test(text)) return 'thinking';
  if (/漂亮|好看|氛围|画面|质感/.test(text)) return 'visual';
  return 'general';
}

function extractSceneSignals(fullText) {
  const text = String(fullText || '');
  const signalRules = [
    { key: 'api_key', priority: 100, pattern: /API\s*key|apikey|接口密钥|密钥/i, subject: '接口问题', detail: '互动点挺具体' },
    { key: 'ai_tooling', priority: 95, pattern: /openclaw|codex|chatgpt|agent|skills|claude|deepseek|qwen|千问|模型|AI/i, subject: 'AI工具折腾', detail: '实践味很足' },
    { key: 'script_hack', priority: 90, pattern: /脚本|魔改|注册机|验证码|临时邮箱|代理|proxy|bug|调试/, subject: '脚本魔改', detail: '动手思路挺清楚' },
    { key: 'coding', priority: 80, pattern: /代码|编程|开发|前端|后端|接口|工程|调试|程序员/, subject: '技术内容', detail: '问题切得挺准' },
    { key: 'tutorial', priority: 70, pattern: /教程|步骤|方法|技巧|教学|干货|怎么|如何/, subject: '步骤讲解', detail: '细节挺清楚' },
    { key: 'water_kids', priority: 65, pattern: /玩水|游泳|水上乐园|泳池|孩子|小孩|亲子/, subject: '玩水日常', detail: '孩子状态真自然' },
    { key: 'travel', priority: 55, pattern: /旅行|旅游|风景|景色|城市|打卡|出游/, subject: '出游记录', detail: '画面感挺强' },
    { key: 'pet', priority: 55, pattern: /猫|狗|宠物|毛孩子|小猫|小狗/, subject: '宠物日常', detail: '状态很可爱' },
    { key: 'food', priority: 45, pattern: /美食|吃|餐|饭|菜|探店|味道|口粮/, subject: '美食分享', detail: '烟火气很足' },
    { key: 'life_record', priority: 10, pattern: /生活|日常|记录|随拍|vlog|真实生活/, subject: '日常记录', detail: '生活感很足' },
  ];
  const signals = [];
  for (const rule of signalRules) {
    if (rule.pattern.test(text)) signals.push(rule);
  }
  return signals.sort((a, b) => b.priority - a.priority);
}

export function analyzeReturnVisitContext(input = {}) {
  const workTitle = String(input.workTitle || '').trim();
  const workText = String(input.workText || '').trim();
  const contentSummary = String(input.contentSummary || '').trim();
  const referenceComments = Array.isArray(input.referenceComments) ? input.referenceComments : [];
  const fullText = [workTitle, workText, contentSummary, referenceComments.join(' ')].filter(Boolean).join(' ');
  const stripped = normalizeText(fullText);
  const contentType = stripped.length < 8 ? 'generic' : classifyContentType(fullText);
  const commentFocus = analyzeReferenceComments(referenceComments);
  const contentDeficient = normalizeText([workTitle, workText, contentSummary].filter(Boolean).join(' ')).length < 8;
  const sceneSignals = extractSceneSignals(fullText);

  return {
    workTitle,
    workText,
    contentSummary,
    referenceComments,
    fullText,
    stripped,
    contentType,
    commentFocus,
    contentDeficient,
    sceneSignals,
  };
}

function calcSeed(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
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

function buildAgentCandidates(analysis) {
  const { contentType, commentFocus, sceneSignals } = analysis;
  const candidates = [];

  for (const signal of sceneSignals || []) {
    candidates.push(`小猿看完觉得${signal.subject}很有现场感，${signal.detail}。`);
    candidates.push(`小猿觉得这段${signal.subject}挺真实，${signal.detail}。`);
  }

  if (commentFocus === 'light') {
    candidates.push('小猿看完觉得氛围很轻松，评论区也挺有共鸣。');
  } else if (commentFocus === 'real') {
    candidates.push('小猿看完觉得内容挺真实，评论区的感受也很自然。');
  } else if (commentFocus === 'useful') {
    candidates.push('小猿看完觉得细节挺实用，评论区关注点也很准。');
  } else if (commentFocus === 'thinking') {
    candidates.push('小猿看完觉得思路挺顺，评论区的共鸣点也很真。');
  } else if (commentFocus === 'visual') {
    candidates.push('小猿看完觉得画面挺有质感，整体氛围也很舒服。');
  }

  const byType = {
    tutorial: '小猿看完觉得步骤挺清楚，细节拆得很实用。',
    viewpoint: '小猿看完觉得观点很顺，表达里的思考也挺真。',
    life: '小猿看完觉得氛围很自然，生活感拿捏得挺好。',
    tool: '小猿看完觉得场景讲得清楚，实际用起来会很顺。',
    tech: '小猿看完觉得技术思路挺稳，关键细节也讲明白了。',
    generic: '小猿看完觉得内容挺用心，评论区反馈也很真实。',
  };
  candidates.push(byType[contentType] || byType.generic);
  candidates.push('小猿看完觉得这个分享挺自然，细节处理也很用心。');

  return [...new Set(candidates)];
}

/**
 * 校验评论是否符合小猿人格和强约束规范
 * @param {string} text 待校验的评论内容
 * @param {string[]} referenceComments 已有的参考评论，防抄袭
 * @param {string} workTitle 被访作品标题，防复读
 * @returns {boolean} 是否合规
 */
export function validateXiaoyuanComment(text, referenceComments = [], workTitle = '') {
  if (!text || typeof text !== 'string') return false;

  // 1. 评论必须包含“小猿”二字
  if (!text.includes('小猿')) return false;

  // 2. 评论对外不能出现“主人”
  if (text.includes('主人')) return false;

  // 3. 评论长度严格控制在 14 到 36 个中文字符之间
  if (text.length < MIN_COMMENT_LENGTH || text.length > MAX_COMMENT_LENGTH) return false;

  // 4. 不要 emoji 表情
  const emojiRegex = /[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E6}-\u{1F1FF}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F251}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/u;
  if (emojiRegex.test(text)) return false;

  // 不要感叹号
  if (/[!！]/.test(text)) return false;

  // 不要连续标点
  if (/[，。！？、,.!?；;：:"'`()（）【】\[\]<>《》-]{2,}/.test(text)) return false;

  // 5. 自动化痕迹黑名单拦截
  const BLACKLIST = [
    '回访', '互关', '求关注', '已关注', '来看看你', '支持一下', '路过', '打卡', 
    '引流', '私信', '加微信', '加V', '广告', '推广', '系统生成', '自动回复', '任务', 
    '采集', '根据上下文', '炸裂', '封神', '绝了', '无敌', '顶级'
  ];
  for (const word of BLACKLIST) {
    if (text.includes(word)) return false;
  }

  // 6. 不要直接复制 referenceComments
  if (isCopyFromReferences(text, referenceComments)) return false;

  // 7. 不要直接复读作品标题
  if (workTitle && workTitle.trim()) {
    const normTitle = normalizeText(workTitle);
    const normComment = normalizeText(text);
    if (normTitle.length >= 6 && normComment.includes(normTitle)) return false;
  }

  // 8. 不要编造行为词汇
  const FABRICATED_BEHAVIORS = [
    '收藏了', '试过了', '买了', '去了', '下单了', '尝试了', '关注了', '拿下了', '收了'
  ];
  for (const word of FABRICATED_BEHAVIORS) {
    if (text.includes(word)) return false;
  }

  return true;
}

/**
 * 核心生成机制：基于输入信息生成符合小猿人格和强约束规范的评论
 * @param {object} input 输入视频信息对象
 * @returns {object} 生成结果对象 { ok, reason, contentType, comment, candidates }
 */
export function generateXiaoyuanReturnVisitComment(input = {}) {
  const analysis = analyzeReturnVisitContext(input);
  const { workTitle, workText, contentSummary, referenceComments, contentType } = analysis;

  const seed = calcSeed(`${workTitle}|${workText}|${contentSummary}`);
  const candidates = [
    ...buildAgentCandidates(analysis),
    ...chooseCandidatesByType(contentType, seed),
  ];

  const accepted = [];
  // 内容充足时优先走上下文分析候选，避免固定模板感。
  if (!analysis.contentDeficient) {
    for (const candidate of candidates) {
      if (validateXiaoyuanComment(candidate, referenceComments, workTitle)) {
        accepted.push(candidate);
      }
    }
  }

  // 2. 第一轮匹配为空或内容不足时，平滑降级至绝对安全的小猿泛化评论池
  if (accepted.length === 0) {
    const rotatedGeneric = [];
    const shift = seed % ABSOLUTE_GENERIC_SAFETY.length;
    for (let i = 0; i < ABSOLUTE_GENERIC_SAFETY.length; i++) {
      rotatedGeneric.push(ABSOLUTE_GENERIC_SAFETY[(i + shift) % ABSOLUTE_GENERIC_SAFETY.length]);
    }

    for (const cand of rotatedGeneric) {
      if (validateXiaoyuanComment(cand, referenceComments, workTitle)) {
        accepted.push(cand);
      }
    }
  }

  // 3. 终极兜底策略，在极其极端的被抄袭参考评论全覆盖去重情况下
  if (accepted.length === 0) {
    const base = '小猿看完觉得这个分享的思路真的挺不错的。'; // 20字
    if (validateXiaoyuanComment(base, referenceComments, workTitle)) {
      accepted.push(base);
    } else {
      accepted.push('小猿觉得用心记录分享的内容真的感觉挺实在的。'); // 22字
    }
  }

  return {
    ok: true,
    reason: analysis.contentDeficient
      ? 'deficient_generic_fallback'
      : (buildAgentCandidates(analysis).includes(accepted[0]) ? `agent_context_${contentType}_${analysis.commentFocus}` : 'safe_fallback_generic'),
    contentType,
    commentFocus: analysis.commentFocus,
    sceneSignals: analysis.sceneSignals,
    comment: accepted[0],
    candidates: accepted,
  };
}

/**
 * 维持向前兼容的回访评论生成标准入口
 */
export function generateReturnVisitComment(input = {}) {
  return generateXiaoyuanReturnVisitComment(input);
}
