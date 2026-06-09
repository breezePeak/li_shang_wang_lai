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

// 安全回访评论模板库，保持中性，不写死任何 Agent 人设名。
const COMMENT_LIBRARY = {
  tutorial: [
    '这个步骤拆得挺清楚，细节也比较好跟。',
    '这个方法讲得挺落地，新手跟着也容易理解。',
    '这类技巧讲得很实用，关键点挺有参考感。',
  ],
  viewpoint: [
    '这个思考角度挺有启发，表达也比较清楚。',
    '这类观点说得挺自然，看完挺容易共鸣。',
    '这段复盘挺扎实，里面的问题意识很清楚。',
  ],
  life: [
    '这段日常记录挺真实，生活感也很自然。',
    '这种生活片段很有代入感，看着挺舒服。',
    '这个分享很自然，细节里有真实感。',
  ],
  tool: [
    '这个工具场景讲得清楚，实际用起来会更顺。',
    '这套方法挺落地，应用场景也说明白了。',
    '这个工具分享挺实用，思路也比较清楚。',
  ],
  tech: [
    '这个技术思路挺稳，关键细节也讲明白了。',
    '这次开发分享质量挺高，问题切得很清楚。',
    '技术实现细节挺有参考价值，思路也顺。',
  ],
  generic: [
    '这个内容梳理得挺清楚，看完有些启发。',
    '这个分享挺用心，很多点讲得比较明白。',
    '这篇内容逻辑挺顺，建议也给得挺诚恳。',
  ],
};

// 内容不足或候选全部被过滤时的安全兜底。
const ABSOLUTE_GENERIC_SAFETY = [
  '这个内容梳理得挺清楚，看完有些启发。',
  '这个分享挺用心，很多点讲得比较明白。',
  '这篇内容逻辑挺顺，建议也给得挺诚恳。',
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
    candidates.push(`${signal.subject}这个点很有现场感，${signal.detail}。`);
    candidates.push(`这段${signal.subject}挺真实，${signal.detail}。`);
  }

  if (commentFocus === 'light') {
    candidates.push('氛围很轻松，评论区也挺有共鸣。');
  } else if (commentFocus === 'real') {
    candidates.push('内容挺真实，评论区的感受也很自然。');
  } else if (commentFocus === 'useful') {
    candidates.push('细节挺实用，评论区关注点也很准。');
  } else if (commentFocus === 'thinking') {
    candidates.push('思路挺顺，评论区的共鸣点也很真。');
  } else if (commentFocus === 'visual') {
    candidates.push('画面挺有质感，整体氛围也很舒服。');
  }

  const byType = {
    tutorial: '步骤挺清楚，细节拆得很实用。',
    viewpoint: '观点很顺，表达里的思考也挺真。',
    life: '氛围很自然，生活感拿捏得挺好。',
    tool: '场景讲得清楚，实际用起来会很顺。',
    tech: '技术思路挺稳，关键细节也讲明白了。',
    generic: '内容挺用心，评论区反馈也很真实。',
  };
  candidates.push(byType[contentType] || byType.generic);
  candidates.push('这个分享挺自然，细节处理也很用心。');

  return [...new Set(candidates)];
}

/**
 * 校验回访评论是否符合安全边界。
 * @param {string} text 待校验的评论内容
 * @param {string[]} referenceComments 已有的参考评论，防抄袭
 * @param {string} workTitle 被访作品标题，防复读
 * @returns {boolean} 是否合规
 */
export function validateReturnVisitComment(text, referenceComments = [], workTitle = '') {
  if (!text || typeof text !== 'string') return false;

  // 评论对外不能出现“主人”
  if (text.includes('主人')) return false;

  // 评论长度严格控制在 14 到 36 个中文字符之间
  if (text.length < MIN_COMMENT_LENGTH || text.length > MAX_COMMENT_LENGTH) return false;

  // 不要感叹号
  if (/[!！]/.test(text)) return false;

  // 不要连续标点
  if (/[，。！？、,.!?；;：:"'`()（）【】\[\]<>《》-]{2,}/.test(text)) return false;

  // 5. 自动化痕迹黑名单拦截
  const BLACKLIST = [
    '回访', '互关', '求关注', '已关注', '来看看你', '支持一下', '打卡',
    '引流', '私信', '加微信', '加V', '广告', '推广', '系统生成', '自动回复', '任务', 
    '采集', '根据上下文'
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
 * 核心生成机制：基于输入信息生成符合安全边界的回访评论。
 * @param {object} input 输入视频信息对象
 * @returns {object} 生成结果对象 { ok, reason, contentType, comment, candidates }
 */
export function generateContextualReturnVisitComment(input = {}) {
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
      if (validateReturnVisitComment(candidate, referenceComments, workTitle)) {
        accepted.push(candidate);
      }
    }
  }

  // 2. 第一轮匹配为空或内容不足时，平滑降级至安全泛化评论池
  if (accepted.length === 0) {
    const rotatedGeneric = [];
    const shift = seed % ABSOLUTE_GENERIC_SAFETY.length;
    for (let i = 0; i < ABSOLUTE_GENERIC_SAFETY.length; i++) {
      rotatedGeneric.push(ABSOLUTE_GENERIC_SAFETY[(i + shift) % ABSOLUTE_GENERIC_SAFETY.length]);
    }

    for (const cand of rotatedGeneric) {
      if (validateReturnVisitComment(cand, referenceComments, workTitle)) {
        accepted.push(cand);
      }
    }
  }

  // 3. 终极兜底策略，在极其极端的被抄袭参考评论全覆盖去重情况下
  if (accepted.length === 0) {
    const base = '这个分享的思路挺不错，整体看着很自然。';
    if (validateReturnVisitComment(base, referenceComments, workTitle)) {
      accepted.push(base);
    } else {
      accepted.push('用心记录的内容挺实在，表达也比较自然。');
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
  return generateContextualReturnVisitComment(input);
}
