# 命令参考手册

本文档只记录 `package.json` scripts 暴露的 CLI 命令、实际参数和入口分类。主流程以当前代码验证结果为准。

## 入口分类

| 分类 | 命令 |
|---|---|
| 主流程 | `auth`、`db:init`、`interactions:scan`、`comments:execute`、`visit:run` / `return-visit:execute` |
| 可选 HTTP 调试 | `agent-server` |
| 只读/辅助入口 | `actions:pending`、`comments:classify`、`return-visit:comment` |
| 调试/开发入口 | `notify:inspect`、`interactions:inspect`、`debug:like-dom`、`debug:like-state`、`debug:open`、`dev:inspect-page`、`server` |

旧评论导出/应用/手动审批/二次确认链路及 `comments:prepare`、`actions:plan`、`likes:plan`、`likes:reciprocate`、`history`、`icon:profile` 已删除，不属于可用入口。

## 安全默认值

- 评论回复：`comments:execute` 默认真实执行，不再需要 `--execute`。reply_text 由 Agent 生成并填写。
- 回访：`return-visit:execute` 不带 `--execute` 时为 dry-run，不真实点赞或评论。
- 所有真实动作必须经过登录态、页面稳定、状态判断、重复判断和失败阻断。

## 主流程

评论回复（DB 查询 + 进程内 Hermes/OpenClaw 生成 + CLI 执行）：

```bash
npm run interactions:scan -- --type comment --days 7 --max-count 50 --prepare-replies
npm run comments:execute -- --days 7 --limit 50
```

回访（DB 任务 + 进程内 Hermes/OpenClaw 生成 + CLI 执行）：

```bash
npm run interactions:scan -- --days 7 --max-count 50 --prepare-visits
npm run visit:run -- --execute
```

评论回复结束后只有在用户明确要求回访时，才进入回访流程。回评和回访都不读写中间 JSON 文件。

### Agent 传输配置

默认不设置任何新环境变量时，仍然使用现有 CLI 调用 `hermes` / `openclaw`，主流程命令不变。

设置 `HERMES_WS_URL` 后，评论回复和回访中的评论生成会优先走 WebSocket 常驻连接；同一进程内复用同一个连接。WebSocket 不可用时，默认自动 fallback 到原 CLI。设置 `AGENT_WS_FALLBACK=none` 可关闭 fallback，强制要求 WebSocket 成功。

注意：`HERMES_WS_URL` 必须指向 Hermes 自身提供的 WebSocket 常驻服务，不是本项目的 `npm run agent-server`。`agent-server` 只是 HTTP 调试入口，不提供 `agent.prompt` WebSocket 协议。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_TRANSPORT` | 自动判断 | `cli` / `ws` |
| `HERMES_WS_URL` | `''` | Hermes WebSocket 地址，例如 `ws://127.0.0.1:3001`；需连接外部 Hermes WS 服务，不是 `npm run agent-server` |
| `AGENT_WS_TIMEOUT_MS` | `60000` | WebSocket 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `AGENT_WS_FALLBACK` | `cli` | `cli` / `none` |
| `REPLY_BATCH_SIZE` | `8` | `comments:execute` 批量生成回复时每批条数 |

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
npm run interactions:scan -- --type comment --days 7 --max-count 50 --prepare-replies
npm run interactions:scan -- --days 7 --max-count 50 --prepare-visits
```

源文件：`src/cli/scan-interactions.mjs`

打开抖音通知中心，通过通知面板逐条扫描互动通知，点击作品缩略图采集评论，写入本地数据库。`runCommentScan()` 仅保留用于回复执行定位，不再用于新事件采集。

用户意图由 Agent 判断，项目 CLI 不解析自然语言。Agent 应根据用户是否只看互动、是否明确回评、是否明确回访，选择 `--display-only`、`--prepare-replies` 或 `--prepare-visits`。不带 `--display-only` 且不显式指定 prepare 标志时，默认同时准备回评摘要和回访任务。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--type` | `all` | `all` / `comment` / `like` / `reply` / `follow` |
| `--days` | 必填（非 display-only） | 限定最近 N 天通知，传 `0` 取消限制 |
| `--max-count` | 必填（非 display-only） | 最大采集通知条数 |
| `--display-only` | `false` | 只采集和展示互动数据，不查询待回评 / 准备待回访任务 |
| `--prepare-replies` | 默认准备 | 查询待回评 DB 摘要，不生成文件 |
| `--prepare-visits` | 默认准备 | 创建/更新待回访 DB 任务，不生成文件 |
| `--collect-types` | `like,comment,reply,follow` | 准备待回访任务时保留的来源类型 |
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

只读辅助入口，用于查看当前待处理事件、最近动作状态、blocked 项和 unstable 项。评论回复推荐主流程不使用该命令；第一步扫描已经把评论写入 `work_comments`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--type` | `null` | 可选 `comment` / `like` |
| `--json` | `false` | JSON 输出 |

## 5. comments:execute

```bash
npm run comments:execute -- --days 7 --limit 50
npm run comments:execute -- --days 7 --limit 50 --agent-only
```

源文件：`src/cli/execute-comment-replies.mjs`

从数据库查询待回评评论，先在当前进程内调用 Hermes/OpenClaw 生成缺失的 `reply_text` 并写回 `work_comments`，再按作品分组打开对应抖音作品页，在作品评论区中查找目标评论。执行时优先结合 `cid/comment_id` 和 `/aweme/v1/web/comment/list/` 辅助确认目标评论，再在评论区 DOM 中唯一定位后点击“回复”、填写、发送并校验；成功后更新 `work_comments.reply_status` 和 `interaction_events.status`。

命令默认真实执行，不再需要 `--execute`。

reply_text 为空的评论会打印日志跳过。已经 succeeded / sent_unverified 的评论会跳过重复执行。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--days` | 必填 | 查询最近 N 天待回评评论 |
| `--limit` / `--max-count` | 必填 | 最大处理评论数 |
| `--agent-only` | `false` | 只生成并写回 `reply_text`，不打开浏览器执行 |
| `--json` | `false` | JSON 输出 |

安全规则：

- 只处理 `reply_text` 非空的评论。
- 执行前检查原评论、回复文本和作品 URL。
- 不再进入 `creator.douyin.com` 评论管理页，也不做全量评论加载/提取。
- 发送失败、页面定位失败或状态不确定会进入 `blocked` 或 `sent_unverified`。
- 重复执行已成功评论回写 `EXECUTE_ALREADY_CONFIRMED`，不算失败。

## 6. return-visit:prepare

```bash
npm run return-visit:prepare -- --event-status new --json
```

源文件：`src/cli/execute-return-visit-prepare.mjs`

辅助入口。只从数据库 `interaction_events` 创建/更新 `return_visit_tasks` 并列出待准备任务，不打开主页，不采集作品，不生成评论，不读写 JSON 文件。默认主流程使用 `interactions:scan --prepare-visits` 后直接运行 `visit:run`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--event-status` | 配置 `returnVisit.eventSourceStatus` 或 `new` | 用于创建任务的事件状态 |
| `--keep-open` | `false` | 复用并保留浏览器 |
| `--headless` | `false` | 无头运行 |
| `--json` | `false` | JSON 输出 |

## 6a. return-visit:comment

```bash
npm run return-visit:comment -- --task-id <taskId> --comment "<评论内容>"
npm run return-visit:comment -- --task-id <taskId> --comment "<评论内容>" --json
```

源文件：`src/cli/set-return-visit-comment.mjs`

**可选单任务辅助入口，不属于推荐主流程。** 推荐主流程由 `visit:run` 在执行阶段实时调用 Hermes/OpenClaw 生成回访评论。

本命令用于单条写入：将生成的回访评论写入指定任务，校验评论是否符合回访评论安全规则，校验通过后任务状态变为 `pending_execute`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--task-id` | `''` | 必填。`return_visit_tasks.task_id` |
| `--comment` | `''` | 必填。回访评论内容，需通过回访评论安全校验 |
| `--json` | `false` | JSON 输出 |

## 7. return-visit:execute

```bash
npm run return-visit:execute -- --execute
npm run return-visit:execute -- --dry-run
```

源文件：`src/cli/execute-return-visit.mjs`

读取数据库中可执行回访任务。打开目标用户主页，监听主页作品列表 API；有可用的对方作品 `workId` 时优先匹配并点击目标作品，否则选择主页首个非置顶作品。进入作品页后在当前进程内调用 Hermes/OpenClaw 生成回访评论，再在 `--execute` 模式下执行点赞 + 评论。不带 `--execute` 时为 dry-run，不真实点赞或评论。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--execute` | `false` | 真实点赞并评论 |
| `--dry-run` | `true` | 只预演，不真实点赞或评论 |
| `--watch-policy` | 配置 `returnVisit.watchPolicy` 或 `seconds` | 看视频策略 |
| `--watch-seconds` | 配置 `returnVisit.watchSeconds` 或 `5-8` | 看视频秒数 |
| `--keep-open` | `false` | 复用并保留浏览器 |
| `--headless` | `false` | 无头运行 |
| `--json` | `false` | JSON 输出 |

安全规则：

- 任务必须有目标用户主页；目标作品可在执行阶段从主页作品列表选择。
- 点赞前必须确认点赞状态。
- 已点赞时跳过点赞，不重复点击。
- 评论发送后会确认结果；未确认会阻断并记录失败。
- 连续失败达到配置上限时暂停本轮执行。

## 8. comments:classify

```bash
npm run comments:classify -- --text "求教程" --json
```

源文件：`src/cli/classify-comment.mjs`

本地评论分类器，返回分类、风险等级和回复模式。不执行任何平台动作。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--text` | 必填 | 要分类的评论文本 |
| `--json` | `false` | JSON 输出 |

## 9. interactions:inspect

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

## 10. notify:inspect

```bash
npm run notify:inspect
npm run notify:inspect -- --keep-open
```

源文件：`src/cli/inspect-notifications.mjs`

调试命令：打开抖音通知面板，采集通知列表数据。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--keep-open` | `false` | 采集后保持浏览器打开 |

## 11. dev:inspect-page

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

## 12. debug:like-dom

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

## 13. debug:like-state

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

## 14. server

```bash
npm run server
```

源文件：`src/server.mjs`

本地开发服务入口，用于内部页面或调试接口，不属于 CLI 主流程。

## 15. debug:open

```bash
npm run debug:open <URL>
npm run debug:open https://www.douyin.com/user/self
```

源文件：`src/cli/open-page.mjs`

打开指定页面，浏览器保持打开不做任何操作，用于手动排查页面 DOM 或调试问题。
