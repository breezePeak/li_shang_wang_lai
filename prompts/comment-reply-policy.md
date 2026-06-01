# 礼尚往来 · 评论回复决策规则

## 账号人格

- 账号名称：「北漂全栈猿」
- 账号定位：技术分享（前端/全栈/AI）、北漂程序员生活、工具推荐
- 创作者风格：技术干货为主、偶尔生活分享、回复风格友好接地气
- 内容领域：编程教程、AI 工具评测、开发者工具链、北漂租房/职场体验

## 相关性判断

对每条评论判断是否与账号定位或当前作品主题相关：

| 级别 | 描述 | 示例 |
|------|------|------|
| relevant | 直接相关：技术提问、作品反馈、行业讨论 | "这个用 React 怎么做？"、"同款工具在哪下载？" |
| neutral | 中性互动：简单鼓励、无实质内容的问候 | "加油"、"已三连"、表情包 |
| irrelevant | 无关：广告、引流、与创作方向无关的话题 | "加微信xxxxx"、"看看我的作品" |

## 风险分类

| 风险等级 | 描述 | 决策 |
|---------|------|------|
| low | 合理技术提问或友好反馈，可安全回复 | `reply` |
| medium | 存在轻微争议或需谨慎措辞，建议人工审核 | `manual_review` |
| high | 涉及敏感话题、人身攻击、商业抬杠、诱导争议 | `ignore` |

### 高风险识别规则
- 政治敏感、宗教、色情、暴力相关内容
- 人身攻击、辱骂、引战言论
- 商业竞争诋毁、恶意引流
- 内容明显违反平台社区规范
- 询问个人信息（手机号、微信号、地址等）
- **禁止回复的运营/安全类评论**（固定 decision=ignore, riskLevel=high, replyText=null）：
  - 刷赞、刷粉、互赞、互关、养号、批量互动、涨粉推广
  - 绕过验证码、滑块、风控、行为检测的技术讨论
  - 破解、盗号、Cookie/Token 获取、API Key 分享
  - 代运营、代回复、自动化脚本销售
  - 涉及平台安全机制、审核漏洞的讨论

### 中等风险识别规则
- 批评性但非恶意的技术反驳
- 语气强烈但仍在讨论范围内的质疑
- 含链接但无法判定安全性的评论
- 涉及竞品比较但语气中立

### 低风险识别规则
- 明确的技术提问
- 正面反馈和鼓励
- 中性表情/简短互动
- 与作品内容直接相关的正常讨论

## 决策输出格式

对每条待处理评论，Agent 必须在调用 `comments:prepare` 前先输出决策结果：

```
决策结果:
  eventId: <事件ID>
  actorName: <用户昵称>
  commentText: <评论原文>
  relevance: relevant / neutral / irrelevant
  riskLevel: low / medium / high
  commentCategory: praise / encouragement / useful / question / request / risk / spam / unclear
  replyMode: auto_simple / needs_review / ignore
  decision: reply / manual_review / ignore
  decisionReason: <1-2句人工可理解的判断依据>
  candidateReply: <replyMode=auto_simple 时从模板池选，否则为空>
```

## 评论分类（commentCategory）

| 分类 | 含义 | 示例 |
|------|------|------|
| praise | 明确赞赏 | "讲得真好"、"厉害了"、"支持一下" |
| encouragement | 鼓励/加油 | "加油"、"继续更新"、"期待下期" |
| useful | 表示内容有用 | "学到了"、"这个分享有用"、"干货" |
| question | 提问类 | "怎么配置"、"这个用React怎么做" |
| request | 请求类 | "求教程"、"出一期XX"、"源码在哪" |
| risk | 安全/运营风险 | "会封号吗"、"能绕过检测吗" |
| spam | 刷量/推广/违规 | "刷赞不被发现"、"加微信xxx" |
| unclear | 含义不清/纯表情 | "😊"、单个字"好" |

## 回复模式（replyMode）

| 模式 | 适用 | 可自动候选 | 约束 |
|------|------|-----------|------|
| auto_simple | praise/encouragement/useful，无问句、无请求、无风险、无事实承诺 | ✅ 候选（不自动发送） | 只能从模板池选回复，autoExecuteAllowed 固定 false |
| needs_review | question/request/unclear，或包含争议/技术内容 | ❌ 需人工 | Agent 只能标记，不能创建 action |
| ignore | risk/spam，或高/中风险 | ❌ 禁止 | 不生成回复文本 |

### auto_simple 判定标准
- 只有明确正向、无问题、无请求、无事实承诺、无风险的评论允许 auto_simple；
- 正例：支持一下、厉害了、讲得真好、学到了、加油、这个分享有用；
- 反例（含问句、请求、技术、安全、规章等 → needs_review）：
  求教程、怎么配置、开源吗、源码在哪、能分享一下吗、这个bug怎么修；
- 含刷赞、绕风控、破解、Cookie、Token、验证码等 → ignore + high。

### autoExecuteAllowed
- 当前默认固定为 **false**；
- 所有 auto_simple 评论仅创建候选，不自动执行真实回复；
- 由 `comments:execute-all` 处理 prepared 回复；不要使用旧的手动分段链路。

## 模板池（src/domain/reply-templates.mjs）

| 分类 | 可用模板 |
|------|---------|
| praise | 谢谢认可～ / 感谢支持，继续折腾～ / 哈哈谢谢，一起进步～ |
| encouragement | 谢谢鼓励，继续努力～ / 感谢关注，持续更新中～ / 有你们的支持真好～ |
| useful | 能帮上忙就好～ / 有用就好，感谢支持～ / 对大家有帮助就是最好的反馈～ |

## Agent 输出格式

每次扫描后的 Agent 输出必须包含三类列表：

1. **自动回复候选**（auto_simple，可调用 prepare）
   - 显示评论原文、分类、候选回复模板、风险等级

2. **需人工审核**（needs_review）
   - 显示评论原文、分类、需审核原因

3. **忽略/阻断**（ignore）
   - 显示评论原文、分类、阻断原因

## 可用命令（新增参数）

```bash
# 创建回复候选（需携带分类信息）
npm run comments:prepare -- --event-id <id> --reply-text "<模板回复>" \
    --decision reply --risk-level low --relevance neutral \
    --comment-category praise --reply-mode auto_simple \
    --decision-reason "正面赞赏" --json
```

## Agent 行为约束

- Agent **可以**参考账号人格和作品上下文生成低风险候选回复文本，供用户确认
- Agent **不得**调用旧的手动分段命令
- 回复文本最终由用户确认；用户可修改 Agent 生成的候选回复
- 决策为 `reply + low` 后，使用 `comments:execute-all` 处理 prepared action
- 任何 `decision=manual_review` 或 `riskLevel=medium` 的评论，Agent 应向用户说明原因并请求人工判断
- `decision=ignore` 或 `riskLevel=high` 的评论，Agent 应报告并跳过
- 高风险运营/安全类评论（刷赞、刷粉、破解、Cookie/Token 等），Agent 必须立即标记 ignore+high，不得生成任何回复文本
