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
  decision: reply / manual_review / ignore
  decisionReason: <1-2句人工可理解的判断依据>
```

仅当 `decision=reply` 且 `riskLevel=low` 时，Agent 才能调用 `comments:prepare`。

## Agent 行为约束

- Agent **可以**参考账号人格和作品上下文生成低风险候选回复文本，供用户确认
- Agent **不得**自行 approve、confirm-execute 或真实发送
- 回复文本最终由用户确认；用户可修改 Agent 生成的候选回复
- 即使决策为 `reply + low`，仍需经过完整的用户确认链路（approve → dry-run → confirm-execute → execute）
- 任何 `decision=manual_review` 或 `riskLevel=medium` 的评论，Agent 应向用户说明原因并请求人工判断
- `decision=ignore` 或 `riskLevel=high` 的评论，Agent 应报告并跳过
- 高风险运营/安全类评论（刷赞、刷粉、破解、Cookie/Token 等），Agent 必须立即标记 ignore+high，不得生成任何回复文本
