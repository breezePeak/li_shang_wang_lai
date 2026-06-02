# 命令参考手册

本文档只记录 `package.json` scripts 暴露的 CLI 命令、实际参数和入口分类。主流程以当前代码验证结果为准。

## 入口分类

| 分类 | 命令 |
|---|---|
| 主流程 | `auth`、`db:init`、`interactions:scan`、`comments:prepare`、`comments:execute-all`、`return-visit:prepare`、`return-visit:execute` |
| 只读/辅助入口 | `actions:pending`、`actions:plan`、`likes:plan`、`comments:classify`、`history` |
| 兼容入口 | `likes:reciprocate` |
| 调试/开发入口 | `notify:inspect`、`interactions:inspect`、`debug:like-dom`、`debug:like-state`、`dev:inspect-page`、`server`、`icon:profile` |

旧评论导出/应用/手动审批/二次确认链路已删除，不属于可用入口。

## 安全默认值

- 评论回复：`comments:execute-all` 不带 `--execute` 时只做数据门禁校验，不真实发送。
- 回访：`return-visit:execute` 不带 `--execute` 时为 dry-run，不真实点赞或评论。
- 旧回赞：`likes:reciprocate --execute` 固定返回 `FEATURE_DISABLED`，不真实点赞。
- 所有真实动作必须经过登录态、页面稳定、状态判断、重复判断和失败阻断。

## 主流程

评论回复：

```bash
npm run interactions:scan -- --type all --days 7
# 填写 data/pending-replies/pending-comments-xxx.json 中每条要回复评论的 reply_text
npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json --execute
```

回访：

```bash
npm run interactions:scan -- --type all --days 7
npm run return-visit:prepare -- --days 7 --max-items 5
npm run return-visit:execute -- --execute
```

评论回复结束后只有在用户明确要求回访时，才进入回访流程。回访准备必须从数据库读取待回访用户，并同时受 `--days` 时间窗口、`--event-limit` 来源事件数和 `--max-items` 本轮处理数约束。

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
npm run interactions:scan -- --type all --days 7
```

源文件：`src/cli/scan-interactions.mjs`

打开抖音通知中心或评论管理页，采集评论和点赞互动，写入本地数据库。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--type` | `all` | `all` / `comment` / `like` |
| `--days` | `null` | 限定最近 N 天通知 |
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

读取 `interactions:scan` 输出的按作品分组 JSON，校验每条待回复评论的 `reply_text`，并更新 `work_comments.reply_text` / `work_comments.reply_status`。该命令只支持 `--items-file`。

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
- `auto_natural` 是主流程默认模式，用于接收 `skills/creator-comment-suggestion/SKILL.md` 生成的一条自然回复，并做长度和禁用词校验。
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

## 6. comments:execute-all

```bash
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json --execute
```

源文件：`src/cli/execute-all-comment-replies.mjs`

读取同一个待回复评论 JSON，逐条打开作品评论区、定位原评论、填写并发送回复。每条发送后必须确认成功，再更新 `work_comments.reply_status` 和 JSON 状态码。不带 `--execute` 时只做门禁校验；带 `--execute` 才真实发送回复。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--items-file` | 必填 | `interactions:scan` 生成且已 prepare 的 JSON |
| `--max-items` | `20` | 本轮最多处理条数 |
| `--execute` | `false` | 真实发送回复 |
| `--json` | `false` | JSON 输出 |

安全规则：

- 只处理 `work_comments.reply_status = prepared` 的评论。
- 执行前检查原评论、回复文本和作品 URL。
- 发送失败、页面定位失败或状态不确定会进入 `blocked` 或 `sent_unverified`。

## 7. return-visit:prepare

```bash
npm run return-visit:prepare -- --days 7 --max-items 5 --json
```

源文件：`src/cli/execute-return-visit-prepare.mjs`

从数据库中的互动事件创建或更新待回访用户任务，再从符合时间窗口的回访任务中取本轮处理对象，进入用户主页和作品页采集上下文，生成回访评论并写入数据库。该命令不会点赞，也不会发表评论。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--max-items` | 配置 `returnVisit.prepareMaxItems` 或 `20` | 本轮最多准备任务数 |
| `--event-limit` | 配置 `returnVisit.taskEventLimit` 或 `500` | 从互动事件读取的上限 |
| `--event-status` | 配置 `returnVisit.eventSourceStatus` 或 `new` | 用于创建任务的事件状态 |
| `--days` | 配置 `returnVisit.sourceDays` 或 `7` | 只从过去 N 天扫描到的互动事件中获取待回访用户 |
| `--keep-open` | `false` | 复用并保留浏览器 |
| `--headless` | `false` | 无头运行 |
| `--json` | `false` | JSON 输出 |

## 8. return-visit:execute

```bash
npm run return-visit:execute
npm run return-visit:execute -- --execute
npm run return-visit:execute -- --max-items 3 --execute
```

源文件：`src/cli/execute-return-visit.mjs`

读取 `pending_execute` 等可执行回访任务，打开准备阶段选中的作品，检查点赞状态，并在 `--execute` 模式下执行点赞 + 评论。不带 `--execute` 时为 dry-run，不真实点赞或评论。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--max-items` | 配置 `returnVisit.executeMaxItems` 或 `20` | 本轮最多执行任务数 |
| `--execute` | `false` | 真实点赞并评论 |
| `--dry-run` | `true` | 只预演，不真实点赞或评论 |
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

查看历史运行记录。

## 14. interactions:inspect

```bash
npm run interactions:inspect
```

源文件：`src/cli/inspect-interactions.mjs`

调试命令：检查已入库互动事件。

## 15. notify:inspect

```bash
npm run notify:inspect
```

源文件：`src/cli/inspect-notifications.mjs`

调试命令：检查通知面板 DOM 结构。

## 16. dev:inspect-page

```bash
npm run dev:inspect-page -- --url "https://www.douyin.com" --keep-open
```

源文件：`src/cli/dev-inspect-page.mjs`

开发调试工具：打开指定页面并检查 DOM。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--url` | `null` | 要打开的 URL |
| `--keep-open` | `false` | 保持浏览器打开 |
| `--label` | `''` | 页面标签 |
| `--wait-after-enter-ms` | `0` | 进入后等待毫秒数 |

## 17. debug:like-dom

```bash
npm run debug:like-dom
```

源文件：`scripts/debug-like-dom.mjs`

调试点赞按钮 DOM 结构。

## 18. debug:like-state

```bash
npm run debug:like-state
```

源文件：`scripts/debug-like-state.mjs`

调试点赞状态检测逻辑。

## 19. server

```bash
npm run server
```

源文件：`src/server.mjs`

本地开发服务入口，用于内部页面或调试接口，不属于 CLI 主流程。

## 20. icon:profile

```bash
npm run icon:profile
```

源文件：`.sisyphus/icon-profile.mjs`

内部图标资料工具，不属于互动主流程。
