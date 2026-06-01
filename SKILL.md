---
name: li-shang-wang-lai
description: 礼尚往来 · 抖音创作者互动助手。发现评论与好友互动、生成回复建议，并在本人明确确认后安全执行单条评论回复。默认只预览，不自动操作。
---

# 礼尚往来 · 创作者互动助手

当用户希望查看抖音评论、互动通知、拟回复或预览好友回访候选时，使用本 Skill。

## 适用场景

以下用户请求应触发本 Skill：

| 用户说法 | Skill 应执行 |
|---|---|
| "看看有没有新评论"、"查看评论" | scan comment → 输出待处理报告 |
| "谁给我点赞了"、"看下互动通知" | scan like → 汇总候选 |
| "帮我回复这些评论" | 展示评论 + 生成回复草稿（不发送） |
| "给第 N 条拟回复：xxx" | prepare comment reply，等待确认 |
| "先预览回复位置" | dry-run 定位目标评论 |
| "确认发送这一条" | 校验审批 + execute 单条回复 |
| "看看好友回访候选"、"哪些朋友点赞了" | likes:plan 或 visits:discover，仅预览 |
| "进入好友主页看看"、"发现回访目标" | visits:discover，进入主页找最新作品并检查点赞 |
| "去把互关朋友的最新作品拿出来准备回访"、"提取回访候选" | return-visit:prepare 阶段 → 扫描并分析好友最新作品以准备候选任务 |
| "去执行好友回访"、"帮我回访一下" | return-visit:execute 阶段 → 物理隔离顶栏搜索框，安全执行点赞+评论 |
| "自动给好友回赞"、"都回一下" | **拒绝**，提供候选预览和单条审批说明 |

## 禁止场景

以下请求必须拒绝，不得继续操作：

- 批量自动点赞或批量回复；
- 无人值守循环执行互动；
- 绕过验证码、滑块、登录校验或平台风控；
- MVP 阶段触发真实回访点赞（`likes:reciprocate --execute` 已被代码层硬阻断）；
- 仅凭昵称相同就执行回访点赞；
- Agent 可参考策略文件生成低风险候选回复文本，但不得自行 approve、confirm-execute 或真实发送。

## 安全规则（硬约束）

| # | 规则 | 说明 |
|---|---|---|
| 1 | 默认只读 | 默认仅扫描、汇总、生成候选、dry-run |
| 2 | 真实动作必须双确认 | 评论回复需 approve + confirm_execute 两次确认 |
| 3 | 单轮最多 1 条 | MVP 每轮真实执行默认上限为 1 |
| 4 | 先 dry-run 后执行 | 真实发送前必须先 dry-run 定位成功 |
| 5 | 状态未知即阻断 | 页面定位、点赞状态、身份绑定时必须阻断 |
| 6 | 防重复 | 已成功执行过的事件不得重复操作 |
| 7 | 风控停止 | 验证码、登录失效、页面异常 → 立即停止 |
| 8 | 不泄露敏感数据 | 不将浏览器 Profile、Cookie、截图发送给第三方 |

## 可用命令

### 初始化

```bash
npm run db:init          # 初始化 SQLite 数据库
npm run auth             # 打开浏览器扫码登录（首次或登录失效时）
```

### 只读扫描（无需确认）

所有新评论和点赞互动统一从通知中心采集并入库。
评论管理页面仅用于后续定位原评论并执行回复，不作为事件采集入口。

```bash
npm run interactions:scan -- --type all --json    # 采集评论和点赞
npm run interactions:scan -- --type comment --json # 只采集评论通知
npm run interactions:scan -- --type like --json    # 只采集点赞通知
npm run actions:pending -- --type comment --json   # 查看待处理评论摘要
npm run actions:pending -- --json                  # 查看全部待处理互动
```

### 评论回复流程（需逐步确认）

> **步骤 0：评论决策（前置必选）**
>
> 在 `comments:prepare` 之前，Agent 必须先对照 `prompts/comment-reply-policy.md` 中的账号人格、
> 相关性判断和风险分类规则，逐条输出决策结果。
>
> 仅当 `decision=reply` 且 `riskLevel=low` 时，才能继续进入候选流程。
> `decision=manual_review` 或 `riskLevel=medium/high` 的评论，Agent 必须向用户说明原因并请求人工判断，
> 不得自动跳过或隐藏。
> **作品上下文要求**：`relevance=relevant` 时必须提供 `--work-context-id` 并匹配 `prompts/work-context.json` 中的作品；
> 缺少作品上下文或事件作品标题不匹配时，Agent 只能设置 `decision=manual_review`，不得生成确定性技术回复候选。

```bash
# 步骤 0：评论决策（Agent 内部完成，可参考 prompts/comment-reply-policy.md）
# 输出格式参见 prompts/comment-reply-policy.md → "决策输出格式"

# 步骤 1：创建回复候选（需携带决策结果）
npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" \
    --decision reply --risk-level low \
    --relevance relevant --decision-reason "<理由>" \
    --work-context-id <作品ID> --json
```


### 回访候选预览（仅预览，五阶段）

```bash
# 阶段 1: 候选分流（纯数据，不进主页）
npm run actions:plan -- --json       # 从 new 事件生成 replyCommentCandidates + visitWorkCandidates

# 阶段 2 (phase3): 主页发现 + 点赞检查（浏览器进入主页/视频页）
npm run visits:discover -- --json --max-items 5   # 进入好友主页找最新作品，检查点赞状态

# 阶段 3 (phase4): 待审核回访候选预览（与 visits:discover 同样进浏览器，仅输出未点赞候选 + 评论草稿）
npm run visits:review -- --json --max-items 5    # 输出 reviewCandidates，包含 commentDrafts

# 阶段 4 (phase5): 现场审核模式（交互式终端，逐条选择 + 执行）
npm run visits:live-review -- --max-items 5                    # dry-run 模式：选择草稿仅预览
npm run visits:live-review -- --execute --max-items 5          # execute 模式：选择草稿后立即点赞+评论

# 阶段 5: 真实执行（MVP 阶段硬阻断）
npm run likes:reciprocate -- --execute   # FEATURE_DISABLED
```

> **五阶段说明：**
> - `actions:plan`：纯数据分流，不进主页，只按 actorProfileKey 合并事件，输出 visitWorkCandidates；
> - `visits:discover`：phase3，浏览器进入好友/互关主页，找最近非置顶作品，检查点赞状态，输出 pending_review/skipped/blocked；
> - `visits:review`：phase4，复用 visits:discover 的浏览器流程，仅输出 pending_review 候选，每条附带 3 条评论草稿（不点赞、不评论、不落库）；
> - `visits:live-review`：phase5，支持三种评论模式（`--comment-mode local|agent|skill`，默认 skill）；local 用本地规则生成候选，agent 预留 LLM 接口（当前 FEATURE_DISABLED），skill 给外部 Agent 使用只输出 commentContext+constraints；用户选择或传 `--selected-comment-text` 即代表人工审核通过；

### Agent 生成回访评论要求

visits:live-review 在发现好友/互关用户的作品处于 not_liked 状态后，可以由 Agent 根据当前作品内容生成评论候选。Agent 生成评论的目标不是"刷存在感"，而是基于作品上下文给出自然、克制、像真人的回应。

#### 生成输入

Agent 只能基于当前页面已提取到的作品上下文生成评论，包括：

- `targetWorkTitle`
- `captionText`
- `hashtags`
- `authorName`
- `visibleTextSample`
- 页面可见的作品描述、话题、标题、计数信息

禁止基于不存在的信息发挥。没有看到的内容不能假装看到了；没有明确出现的画面、人物、地点、情绪、产品、事件，不得编造。

#### 评论生成原则

Agent 每次最多生成 3 条评论候选。

评论要求：

- 8~24 个中文字符为宜；
- 语气自然，像普通用户评论；
- 尽量贴合作品标题、文案、话题；
- 不要太营销，不要像机器人；
- 不要连续使用感叹号；
- 不要强行夸张；
- 不要生成"万能废话"；
- 不要提"我是 AI"；
- 不要提"回访""互关""互赞""已赞""三连""求关注"；
- 不要出现联系方式、私聊、加 V、引流类内容；
- 不要对敏感、争议、医疗、金融、法律等内容做判断或建议；
- 不要生成可能引战、冒犯、暧昧、低俗、攻击性的评论。

#### 风险等级

Agent 生成的评论默认不是固定模板，因此默认归类为：

```json
{
  "replyMode": "agent_generated_review_required",
  "riskLevel": "medium",
  "autoExecuteAllowed": false
}
```

含义：

- Agent 可以生成候选；
- 不允许自动执行；
- 必须由用户现场选择 1/2/3；
- 用户选择某一条后，才视为当前条评论已人工审核通过。

如果作品上下文不足，Agent 应退回固定低风险模板，例如：

- 支持一下
- 内容不错
- 挺好的

固定模板可归类为：

```json
{
  "replyMode": "auto_simple",
  "riskLevel": "low",
  "autoExecuteAllowed": false
}
```

即使是 low risk，也不能自动执行，仍需用户选择。

#### 阻断规则

出现以下情况时，Agent 不得生成可执行评论，应返回 blocked 或要求人工处理：

- 作品上下文为空或严重不足；
- 页面内容疑似加载失败；
- 作品涉及争议、攻击、隐私、违法、医疗、金融、法律等高风险话题；
- Agent 无法判断评论是否合适；
- 生成内容包含平台风险词；
- 生成内容可能被理解为广告、引流、骚扰或批量互动；
- 点赞状态为 unknown；
- 当前用户关系不是 friend 或 mutual。

#### 输出结构

Agent 生成评论候选时，应输出结构化数据：

```json
{
  "generatedCommentCandidates": [
    {
      "text": "这个主题挺温柔的～",
      "commentCategory": "contextual_praise",
      "replyMode": "agent_generated_review_required",
      "riskLevel": "medium",
      "reason": "基于作品标题和话题生成",
      "sourceSignals": ["targetWorkTitle", "hashtags"],
      "autoExecuteAllowed": false
    }
  ]
}
```

如果使用固定模板 fallback：

```json
{
  "generatedCommentCandidates": [
    {
      "text": "内容不错",
      "commentCategory": "generic_support",
      "replyMode": "auto_simple",
      "riskLevel": "low",
      "reason": "作品上下文不足，使用固定低风险模板",
      "sourceSignals": ["fallback_template"],
      "autoExecuteAllowed": false
    }
  ]
}
```

#### 用户选择即审核

在 `visits:live-review --execute` 模式下：

- Agent 展示 1/2/3 三条候选；
- 用户输入 1、2 或 3，即表示人工审核通过当前条；
- 不需要再输入 YES；
- 只能执行当前打开的视频页；
- 每条候选都必须单独选择；
- 不允许批量确认；
- 用户输入 s 表示跳过当前条；
- 用户输入 q 表示停止本轮。

#### 执行前复查

即使用户已选择评论，执行前仍必须在当前页面重新检查点赞状态：

```text
re-check like state
  ├── already_liked → skipped，不评论
  ├── not_liked → 点赞 + 评论
  └── unknown → blocked，不执行
```

禁止重新打开目标视频；必须复用当前已经打开的视频页。

#### 结果记录

执行结果必须记录：

```json
{
  "selectedCommentText": "这个主题挺温柔的～",
  "commentCategory": "contextual_praise",
  "replyMode": "agent_generated_review_required",
  "riskLevel": "medium",
  "manualReviewMethod": "user_selected_agent_comment",
  "autoExecuteAllowed": false,
  "actionResults": {
    "like": "confirmed",
    "comment": "confirmed"
  }
}
```

如果评论发送后无法确认成功，应记录为：

```json
{
  "actionResults": {
    "like": "confirmed",
    "comment": "unconfirmed",
    "commentReason": "comment_not_confirmed"
  }
}
```

不得把未确认评论记为 confirmed。

> - `likes:reciprocate`：真实点赞继续 `FEATURE_DISABLED` 硬阻断。

### 旧命令兼容

```bash
npm run likes:plan -- --json       # 旧版浏览器回访计划（不推荐）
npm run visits:plan -- --json       # 旧版统一回访计划（不推荐）
```

## 评论回复完整流程

```text
用户请求查看评论
  ↓
npm run interactions:scan -- --type comment --json
  ↓
npm run actions:pending -- --type comment --json
  ↓
Skill 展示待处理评论摘要（昵称、作品、评论内容、当前状态）
  ↓
用户指定回复某条评论："给第 N 条拟回复：xxx"
  ↓
npm run comments:prepare -- --event-id <id> --reply-text "xxx" \
    --decision reply --risk-level low \
    --relevance relevant --decision-reason "<理由>" \
    --work-context-id <作品ID> --json
  ↓
Skill 展示预览：目标用户 / 作品 / 原评论 / 回复文本 / 决策 / 风险 / 相关性 / 作品上下文
  ↓
用户说 "确认"
  ↓
npm run actions:approve -- --action-id <id> --json
  ↓
npm run comments:execute -- --action-id <id> --dry-run --json
  ↓
dry-run 成功 → 告知用户定位成功（原评论已找到，回复框已打开）
dry-run 失败 → 报告 blocked，停止
  ↓
用户说 "发送"
  ↓
npm run actions:confirm-execute -- --action-id <id> --json
  ↓
npm run comments:execute -- --action-id <id> --execute --max-items 1 --json
  ↓
成功 → 告知用户已发送 + 审计记录已保存
失败 → 报告原因 + 证据路径
```

## 回访候选预览流程（五阶段）

```text
阶段 1: 候选分流 (actions:plan)
  用户请求查看好友回访候选
    ↓
  npm run actions:plan -- --json
    ↓
  Skill 展示分流结果：
    - replyCommentCandidates（评论候选回复）
    - visitWorkCandidates（好友回访候选，按 actorProfileKey 合并）
    - skipped（不进入候选的原因）

阶段 2: 主页发现 (visits:discover, phase3)
  用户说 "进入主页看看"
    ↓
  npm run visits:discover -- --json --max-items 5
    ↓
  对每个 visitWorkCandidate（仅 friend/mutual）：
    → page.goto(actorProfileUrl)
    → findLatestNonPinnedVideo
    → navigateToVideo
    → checkLikeState
    ↓
  输出 visitDiscoveries：
    - pending_review: 未点赞 → plannedActions=["like_work","comment_work"], executeAllowed=false
    - skipped: 已点赞 → reason="already_liked_skip_comment", plannedActions=[]
    - blocked: 无法确认 → reason 说明原因 (no_actor_profile_url / LIKE_STATE_UNKNOWN / ...)

阶段 3: 待审核候选 (visits:review, phase4)
  用户说 "看看哪些需要回复"、"生成回访审核列表"
    ↓
  npm run visits:review -- --json --max-items 5
    ↓
  复用 visits:discover 的浏览器流程（进入主页→找作品→检查点赞）
    ↓
  仅输出 pending_review 候选，每条附带 3 条评论草稿
    ↓
  输出 reviewCandidates（selectedCommentDraft=null, executeAllowed=false）

阶段 4: 现场审核 (visits:live-review, phase5)
  用户说 "逐条审核回访候选"、"现场确认回访"
    ↓
  三种评论模式：--comment-mode local|agent|skill（默认 skill）
    ↓
  local:  npm run visits:live-review -- --comment-mode local --execute --max-items 5
  agent:  npm run visits:live-review -- --comment-mode agent --max-items 5  (当前 FEATURE_DISABLED)
  skill:  npm run visits:live-review -- --comment-mode skill --json --max-items 1
    ↓
  local 模式：提取上下文 → generateVisitCommentCandidates → 展示 1/2/3 → 用户选择 → 执行
  agent 模式：预留 LLM 接口，当前 FEATURE_DISABLED
  skill 模式：提取上下文 → 输出 needsAgentComment + commentContext + constraints → 外部 Agent 生成评论
  skill 执行：npm run visits:live-review -- --selected-comment-text "xxx" --execute --max-items 1
    ↓
  选择或传入 --selected-comment-text 即代表人工审核通过当前条，不需要 YES
  skill + selected-comment-text 时必须 --max-items 1，一条评论只对应一个作品
  执行前当前页 re-check like state
    ↓
  输出 reviewCandidates（含 generatedCommentCandidates/needsAgentComment/commentContext/constraints/selectedCommentText 等）

阶段 5: 旧版真实执行保留 (likes:reciprocate, MVP 硬阻断)
  用户说 "给这个候选点赞"
    ↓
  npm run likes:reciprocate -- --execute ...
    ↓
  FEATURE_DISABLED（代码层硬阻断）
```

## 阻断场景处理

当脚本返回以下情况时，Skill 必须向用户报告并停止：

- `blocked` 状态 — 说明阻断原因（如找不到目标评论、点赞状态未知等）；
- `FEATURE_DISABLED` — 真实回访点赞默认禁用；
- `evidence` 目录中有截图或诊断文件 — 提醒用户可查看；
- 脚本异常退出或返回非 JSON — 告知用户错误信息并建议人工检查。

## 错误码速查

| 错误码 | 含义 | Skill 应 |
|---|---|---|
| `FEATURE_DISABLED` | 功能默认禁用 | 告知用户并停止 |
| `LOGIN_REQUIRED` | 需要重新登录 | 提示运行 `npm run auth` |
| `ACTION_NOT_APPROVED` | 任务未审批 | 提示需要先确认 |
| `DUPLICATE_ACTION` | 已执行过 | 告知已处理，跳过 |
| `MAX_ITEMS_REACHED` | 达到单轮上限 | 正常停止 |
| `BLOCKED` / `LIKE_STATE_UNKNOWN` | 状态不确定 | 说明原因并阻断 |
| `RATE_LIMITED` | 疑似风控 | 立即停止本轮 |

## 当前版本限制

- 评论回复流程：`prepare → approve → dry-run → confirm-execute → execute`
- 好友回访五阶段：
  - `actions:plan` — 候选分流，不进主页
  - `visits:discover` — phase3，进主页发现作品并检查点赞
  - `visits:review` — phase4，生成待审核回访候选（含评论草稿，不点赞、不评论、不落库）
  - `visits:live-review` — phase5，交互式审核，根据作品上下文生成评论候选（Agent=medium, 固定模板=low fallback），选择 1/2/3 即审核通过；high/ignore 阻断
  - `likes:reciprocate` — 真实点赞代码层硬阻断
- 新版回访两阶段流程 (return-visit):
  - `return-visit:prepare` — 执行准备阶段。进入好友主页扫描最近非置顶作品并提取上下文，生成 AI 评论内容，并将合法任务标记为 `pending_execute` 落库。
  - `return-visit:execute` — 执行回访阶段。从库中加载真正的合法候选，通过打标精确定位点赞按钮，自动在物理及词汇层级排除顶栏全局搜索框，无缝完成视频点赞和评论发送。

---

## 新版回访两阶段执行与加固规范

### 1. 任务数据流与严格过滤
执行阶段命令 `return-visit:execute` 必须对库中取出的候选任务进行严格把关。
- **合法执行任务标准**：
  1. `status === "pending_execute"` 且非失败状态。
  2. 任务必须存有有效的 `generatedComment`（非空字符）。
  3. 任务必须具有明确的作品 URL（`targetWork.workUrl` 存在且非空）。
  4. 该任务的评论未被执行（`commentStatus !== "posted"`）。
- **脏任务预处理跳过规则**：
  - 若 `generatedComment` 为空，立即标记状态为 `failed_generate_comment`，跳过并不计入执行列表。
  - 若 `workUrl` 为空，立即标记状态为 `failed_collect`，跳过并不计入执行列表。
  - 脏任务预处理更新状态时，**决不计入**本轮真实执行循环，且**绝不累加** `consecutiveFailures` 连续页面操作失败计数。

### 2. 精准定位加固防线 (杜绝误击顶部搜索框)
在视频页进行点赞和评论时，必须严格通过以下物理和逻辑层级的设计，绝不能误点击到任何无关组件：
- **点赞打标定位法**：
  - 在 `page.evaluate` 进行点赞状态判定（无论是 `actionBar` 还是 `rightside`）后，确认目标按钮节点时，在该元素上附带设置临时唯一属性 `data-temp-like-btn="true"`。
  - Playwright 层面优先且直接根据 `[data-temp-like-btn="true"]` 选择器进行精准点击，彻底规避传统泛用选择器因动态打包带来的误中漂移。
- **物理与特定词汇排除评论定位法**：
  - **绝对禁止**无任何前置词汇或容器限制的通用 `'input'`、`'textarea'` 以及 `'[contenteditable="true"]'` 选择器，防止由于评论面板渲染延迟而直接误中页面最显眼且最先渲染的顶栏全局搜索框！
  - 评论选择器必须仅定位在带有特定评论词汇（如匹配 `留下你的精彩评论吧`、`说点什么`、`善语`、`留下`）的属性框上，或仅在评论专属包裹容器（如包含 `class*="comment"` 或 `id*="comment"`）内查找。
  - **双重防搜机制**：匹配输入框后，在运行时 evaluate 动态校验该节点的 placeholder、ID 或类名，一旦发现含有 `搜`、`search` 字样，一律强制剔除，实施物理阻绝。

### 3. 失败截图与 DOM 结构现场调试
当遇到 `failed_like` 或 `failed_comment` 等页面级操作失败时，Skill 必须自动化完成以下现场保留：
- **现场截图**：自动截取当前页面并输出保存到 `data/debug/return-visit/`，文件名格式包含 `taskId`、失败阶段及时间戳。
- **DOM 结构诊断**：自动使用 `page.evaluate` 搜集页面前 20 个候选可点击交互元素、所有文本输入区的 placeholder 列表，并将这些 DOM 树结构输出到错误日志中，方便后期分析。

