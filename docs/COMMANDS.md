# 命令参考手册

本文档只记录 `package.json` scripts 暴露的 CLI 命令、实际参数和入口分类。主流程以当前代码验证结果为准。

## 入口分类

| 分类 | 命令 |
|---|---|
| 主流程 | `auth`、`db:init`、`interactions:scan`、`comments:execute`、`return-visit:prepare`、`return-visit:execute` |
| 只读/辅助入口 | `actions:pending`、`actions:plan`、`likes:plan`、`comments:classify`、`return-visit:comment`、`history` |
| 兼容入口 | `likes:reciprocate` |
| 调试/开发入口 | `notify:inspect`、`interactions:inspect`、`debug:like-dom`、`debug:like-state`、`debug:open`、`dev:inspect-page`、`server`、`icon:profile` |

旧评论导出/应用/手动审批/二次确认链路已删除，不属于可用入口。

## 安全默认值

- 评论回复：`comments:execute` 默认真实执行，不再需要 `--execute`。reply_text 由 Agent 生成并填写。
- 回访：`return-visit:execute` 不带 `--execute` 时为 dry-run，不真实点赞或评论。
- 旧回赞：`likes:reciprocate --execute` 固定返回 `FEATURE_DISABLED`，不真实点赞。
- 所有真实动作必须经过登录态、页面稳定、状态判断、重复判断和失败阻断。

## 主流程

评论回复（Agent 填写 reply_text 后直接执行）：

```bash
npm run interactions:scan -- --type comment --generate-reply-json
# Agent 根据评论内容、作品上下文和安全规则，生成并填写 reply_text
npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
```

回访（默认 7 天 / 100 条）：

```bash
npm run interactions:scan -- --generate-visit-json
npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json
# Agent 编辑 pending-visit-comments-xxx.json，填写 comment 字段
npm run return-visit:execute -- --execute --items-file data/pending-visits/pending-visit-comments-xxx.json
```

评论回复结束后只有在用户明确要求回访时，才进入回访流程。回访准备从数据库读取待回访用户，完全按提供的回访 JSON 处理。

## 1. auth

```bash
npm run auth
```

源文件：`src/auth-douyin.mjs`

打开浏览器并检测抖音登录态。检测到已登录后关闭浏览器并返回认证成功；60 秒未检测到登录态时提示扫码登录；最多等待 5 分钟，超时后关闭浏览器并返回验证失败。

参数：无。

## 2. db:init

```bash
npm run db:init
```

源文件：`src/db/migrations.mjs`

初始化 SQLite 数据库并执行迁移。

参数：无。

## 3. interactions:scan

```bash
npm run interactions:scan -- --display-only
npm run interactions:scan -- --type comment --generate-reply-json
npm run interactions:scan -- --generate-visit-json
```

源文件：`src/cli/scan-interactions.mjs`

打开抖音通知中心，通过通知面板逐条扫描互动通知，点击作品缩略图采集评论，写入本地数据库。`runCommentScan()` 仅保留用于回复执行定位，不再用于新事件采集。

用户意图由 Agent 判断，项目 CLI 不解析自然语言。Agent 应根据用户是否只看互动、是否明确回评、是否明确回访，选择 `--display-only`、`--generate-reply-json` 或 `--generate-visit-json`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--type` | `all` | `all` / `comment` / `like` / `reply` / `follow` |
| `--days` | `7` | 限定最近 N 天通知，传 `0` 取消限制 |
| `--max-count` | `100` | 最大采集通知条数 |
| `--display-only` | `false` | 只采集和展示互动数据，不生成待回评 / 待回访 JSON |
| `--generate-reply-json` | 兼容默认 | 生成 `data/pending-replies/pending-comments-xxx.json` |
| `--generate-visit-json` | `false` | 生成 `data/pending-visits/pending-visits-xxx.json` |
| `--collect-types` | `like,comment,reply,follow` | 生成待回访 JSON 时保留的来源类型 |
| `--json` | `false` | JSON 输出 |
| `--debug` | `true` | 调试日志 |
| `--keep-open` | `false` | 结束后保持浏览器打开 |
| `--keep-open-on-error` | `true` | 出错时保持浏览器打开 |
| `--pause-on-error` | `true` | 出错时暂停等待人工处理 |
| `--max-items` | `1` | 通用运行上限 |
| `--write-run-files` | `false` | 写入运行摘要文件 |
| `--pause-after-open` | `0` | 打开通知面板后停顿毫秒数 |
| `--debug-notification-dom` | `false` | 保存通知 DOM 调试信息 |

## 4. actions:pending

```bash
npm run actions:pending
npm run actions:pending -- --type comment --json
```

源文件：`src/cli/report-pending.mjs`

只读辅助入口，用于查看当前待处理事件、最近动作状态、blocked 项和 unstable 项。评论回复推荐主流程不使用该命令；第一步扫描已经输出按作品分组的待回复评论 JSON。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--type` | `null` | 可选 `comment` / `like` |
| `--json` | `false` | JSON 输出 |

## 5. comments:prepare

```bash
npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json
```

源文件：`src/cli/prepare-comment-reply.mjs`

**备注**：当前主流程已简化，Agent 直接在扫描生成的 JSON 中填写 `reply_text`，然后由 `comments:execute` 读取 JSON 并写库执行。`comments:prepare` 仍可用作独立的校验和写库步骤，但在主流程中非必需。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--items-file` | 必填 | `interactions:scan` 生成的 `data/pending-replies/pending-comments-xxx.json` |
| `--decision` | `reply` | `reply` / `manual_review` / `ignore` |
| `--risk-level` | `low` | `low` / `medium` / `high` |
| `--decision-reason` | `''` | 决策理由 |
| `--relevance` | `neutral` | `relevant` / `neutral` / `irrelevant` |
| `--work-context-id` | `''` | 可选审计字段，不触发额外读取或校验 |
| `--comment-category` | `unclear` | 评论分类 |
| `--reply-mode` | `auto_natural` | `auto_natural` / `auto_simple` / `needs_review` / `ignore` |
| `--json` | `false` | JSON 输出 |

安全规则：

- 缺少 `--items-file` 时直接报错。
- 输入必须是 `interactions:scan` 生成的 `works[].comments[]`、`comments[]` 或评论数组。
- 每条要回复的评论必须包含 `work_comments.id` 和非空 `reply_text`。
- 批量项可覆盖 `decision`、`riskLevel`、`relevance`、`workContextId`、`commentCategory`、`replyMode` 等字段；未提供时使用 CLI 默认值。
- 只有 `decision=reply`、`risk-level=low`、`relevance != irrelevant` 可准备回复。
- `auto_simple` 只用于调用方已经选择模板池文本的场景。
- `auto_natural` 是主流程默认模式，用于接收符合 `references/comment-safety-rules.md` 的一条自然回复，并做长度和禁用词校验。
- 已回复或已发送未确认的评论会阻断，避免重复准备。

JSON 中评论项示例：

```json
{
  "id": 42,
  "comment_text": "这个做法有意思",
  "reply_text": "这个小虾也觉得挺有意思",
  "reply_status": "pending",
  "prepare_status_code": "PREPARE_WAIT_REPLY_TEXT"
}
```

## 6. comments:execute

```bash
npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
```

源文件：`src/cli/execute-comment-replies.mjs`

读取同一个待回复评论 JSON，按作品分组打开对应抖音作品页，在作品评论区中查找目标评论。`reply_text` 由 Agent 根据评论内容、作品上下文和安全规则生成并填写。执行时优先结合 `cid/comment_id` 和 `/aweme/v1/web/comment/list/` 辅助确认目标评论，再在评论区 DOM 中唯一定位后点击“回复”、填写 `reply_text`、发送并校验；成功后更新 `work_comments.reply_status` 和 `interaction_events.status`，并回写 JSON 状态码。

命令默认真实执行，不再需要 `--execute`。

reply_text 为空的评论会打印日志跳过。已经 succeeded / sent_unverified 的评论会跳过重复执行。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--items-file` | 必填 | `interactions:scan` 生成并已由 Agent 填写 reply_text 的 JSON |
| `--json` | `false` | JSON 输出 |

安全规则：

- 只处理 `reply_text` 非空的评论。
- 执行前检查原评论、回复文本和作品 URL。
- 不再进入 `creator.douyin.com` 评论管理页，也不做全量评论加载/提取。
- 发送失败、页面定位失败或状态不确定会进入 `blocked` 或 `sent_unverified`。
- 重复执行已成功评论回写 `EXECUTE_ALREADY_CONFIRMED`，不算失败。

## 7. return-visit:prepare

```bash
npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json --json
```

源文件：`src/cli/execute-return-visit-prepare.mjs`

读取 `interactions:scan -- --generate-visit-json` 生成的待回访 JSON 中的 id，从数据库加载对应 `return_visit_tasks`（任务创建已在扫描阶段完成）。逐个打开用户主页，监听 `/aweme/v1/web/aweme/post/`，筛选第一条非置顶作品并记录作品元数据。该命令**不会生成评论**，也不会点赞或发表评论。评论由 Agent 直接填写 `pending-visit-comments-xxx.json` 的 `comment` 字段，或通过 `return-visit:comment` 辅助入口写入。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--items-file` | `''` | 待回访 JSON 文件路径，推荐主流程使用 |
| `--event-status` | 配置 `returnVisit.eventSourceStatus` 或 `new` | 用于创建任务的事件状态 |
| `--keep-open` | `false` | 复用并保留浏览器 |
| `--headless` | `false` | 无头运行 |
| `--json` | `false` | JSON 输出 |

## 7a. return-visit:comment

```bash
npm run return-visit:comment -- --task-id <taskId> --comment "<评论内容>"
npm run return-visit:comment -- --task-id <taskId> --comment "<评论内容>" --json
```

源文件：`src/cli/set-return-visit-comment.mjs`

**可选单任务辅助入口，不属于推荐主流程。** 推荐主流程是 Agent 直接编辑 `pending-visit-comments-xxx.json` 的 `comment` 字段，然后 `return-visit:execute --execute --items-file ...` 执行。

本命令用于单条写入：将生成的回访评论写入指定任务，校验评论是否符合小猿人格规范，校验通过后任务状态变为 `pending_execute`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--task-id` | `''` | 必填。`return-visit:prepare` 输出的任务 ID |
| `--comment` | `''` | 必填。回访评论内容，需通过小猿人格校验 |
| `--json` | `false` | JSON 输出 |

## 8. return-visit:execute

```bash
npm run return-visit:execute -- --execute --items-file data/pending-visits/pending-visit-comments-xxx.json
npm run return-visit:execute -- --dry-run
```

源文件：`src/cli/execute-return-visit.mjs`

读取 `pending_execute` 等可执行回访任务，或从 `--items-file` 读取 Agent 已填写 `comment` 的 JSON。打开准备阶段选中的作品，检查点赞状态，并在 `--execute` 模式下执行点赞 + 评论。不带 `--execute` 时为 dry-run，不真实点赞或评论。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--execute` | `false` | 真实点赞并评论 |
| `--dry-run` | `true` | 只预演，不真实点赞或评论 |
| `--items-file` | `''` | 回访准备阶段生成、并由 Agent 填写 comment 的 JSON 文件 |
| `--watch-policy` | 配置 `returnVisit.watchPolicy` 或 `seconds` | 看视频策略 |
| `--watch-seconds` | 配置 `returnVisit.watchSeconds` 或 `5-8` | 看视频秒数 |
| `--keep-open` | `false` | 复用并保留浏览器 |
| `--headless` | `false` | 无头运行 |
| `--json` | `false` | JSON 输出 |

安全规则：

- 任务必须有生成好的回访评论和目标作品 URL。
- 点赞前必须确认点赞状态。
- 已点赞时跳过点赞，不重复点击。
- 评论发送后会确认结果；未确认会阻断并记录失败。
- 连续失败达到配置上限时暂停本轮执行。

## 9. actions:plan

```bash
npm run actions:plan -- --json
```

源文件：`src/cli/plan-actions.mjs`

只读辅助入口：从事件生成评论回复候选和回访候选预览。当前主流程不依赖该命令；Agent 不应把它作为执行链路入口。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--json` | `false` | JSON 输出 |
| `--limit` | `200` | 读取事件数 |
| `--commit` | `false` | 当前未实现，仍按只读运行 |

## 10. likes:plan

```bash
npm run likes:plan -- --json
```

源文件：`src/cli/plan-likes.mjs`

只读点赞候选预览。所有候选都带 `previewOnly: true` 和 `executeAllowed: false`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--json` | `false` | JSON 输出 |
| `--limit` | `200` | 读取事件数 |

## 11. likes:reciprocate

```bash
npm run likes:reciprocate -- --dry-run --plan plan.json
```

源文件：`src/cli/execute-reciprocal-likes.mjs`

兼容旧 Agent 的入口，不推荐使用。真实回赞已禁用，`--execute` 固定返回 `FEATURE_DISABLED`。真实回访必须使用 `return-visit:prepare` / `return-visit:execute -- --execute`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--plan` | `null` | 旧计划文件路径 |
| `--dry-run` | `false` | 预览模式 |
| `--execute` | `false` | 固定禁用，返回 `FEATURE_DISABLED` |

## 12. comments:classify

```bash
npm run comments:classify -- --text "求教程" --json
```

源文件：`src/cli/classify-comment.mjs`

本地评论分类器，返回分类、风险等级和回复模式。不执行任何平台动作。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--text` | 必填 | 要分类的评论文本 |
| `--json` | `false` | JSON 输出 |

## 13. history

```bash
npm run history
```

源文件：`src/cli/show-history.mjs`

**尚未实现。** 当前仅输出 `[TODO] history — 运行记录查看尚未实现`。

## 14. interactions:inspect

```bash
npm run interactions:inspect
npm run interactions:inspect -- --page comment
npm run interactions:inspect -- --page like
npm run interactions:inspect -- --page notice
```

源文件：`src/cli/inspect-interactions.mjs`

调试命令：打开浏览器，导航到互动页，采集页面诊断数据。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--page` | `comment` | 目标页面类型：`comment` / `like` / `notice` |
| `--keep-open` | `false` | 采集后保持浏览器打开 |

## 15. notify:inspect

```bash
npm run notify:inspect
npm run notify:inspect -- --keep-open
```

源文件：`src/cli/inspect-notifications.mjs`

调试命令：打开抖音通知面板，采集通知列表数据。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--keep-open` | `false` | 采集后保持浏览器打开 |

## 16. dev:inspect-page

```bash
npm run dev:inspect-page -- --url "https://www.douyin.com" --keep-open
```

源文件：`src/cli/dev-inspect-page.mjs`

开发调试工具：打开指定页面并检查 DOM。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--url` | `https://www.douyin.com/user/self` | 要打开的 URL |
| `--keep-open` | `true` | 保持浏览器打开 |
| `--label` | `''` | 页面标签 |
| `--wait-after-enter-ms` | `500` | 进入后等待毫秒数 |

## 17. debug:like-dom

```bash
npm run debug:like-dom
```

源文件：`scripts/debug-like-dom.mjs`

调试点赞按钮 DOM 结构。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--url` | `''` | 要打开的视频页 URL（为空则使用内置测试 URL） |
| `--out` | `''` | 输出目录（为空则自动生成 `debug-output/dom-<timestamp>/`） |
| `--wait-ms` | `5000` | 页面加载后等待毫秒数 |
| `--keep-open` | `false` | 采集后保持浏览器打开 |
| `--selector` | `''` | 自定义 CSS 选择器（为空则使用内置默认） |

## 18. debug:like-state

```bash
npm run debug:like-state
```

源文件：`scripts/debug-like-state.mjs`

调试点赞状态检测逻辑。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--url` | `''` | 要打开的视频页 URL |
| `--wait-ms` | `5000` | 页面加载后等待毫秒数 |
| `--keep-open` | `false` | 采集后保持浏览器打开 |

## 19. server

```bash
npm run server
```

源文件：`src/server.mjs`

本地开发服务入口，用于内部页面或调试接口，不属于 CLI 主流程。

## 20. debug:open

```bash
npm run debug:open <URL>
npm run debug:open https://www.douyin.com/user/self
```

源文件：`src/cli/open-page.mjs`

打开指定页面，浏览器保持打开不做任何操作，用于手动排查页面 DOM 或调试问题。

---

## 21. icon:profile

```bash
npm run icon:profile
```

源文件：`.sisyphus/icon-profile.mjs`（文件不存在，命令尚未实现）
