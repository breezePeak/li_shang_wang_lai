# 命令参考手册

本文档详细说明 `li_shang_wang_lai` 所有 CLI 命令的用法、参数和默认值。

---

## 通用参数

以下参数由 `parseCommonArgs` 解析，大部分命令都支持：

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--dry-run` | bool | `true` | 只预演，不执行真实操作 |
| `--execute` | bool | `false` | 真实执行（与 `--dry-run` 互斥） |
| `--json` | bool | `false` | JSON 模式输出，适合 Agent 调用 |
| `--debug` | bool | `true` | 打印调试日志 |
| `--keep-open` | bool | `false` | 结束后保持浏览器打开 |
| `--keep-open-on-error` | bool | `true` | 出错时保持浏览器打开 |
| `--pause-on-error` | bool | `true` | 出错时暂停等待人工处理 |
| `--max-items` | int | `1` | 本轮最大处理条数 |
| `--comment-mode` | string | `skill` | 评论模式：`local` / `agent` / `skill` |
| `--selected-comment-text` | string | `null` | skill 模式下外部 Agent 传回的评论文本 |
| `--reply-mode` | string | `null` | 回复模式 |
| `--risk-level` | string | `null` | 风险等级：`low` / `medium` / `high` |
| `--manual-review-method` | string | `null` | 人工审核方式 |
| `--observe-ms` | int | `5000` | 人工观察停留时间（ms） |
| `--profile-settle-ms` | int | `6000` | 主页稳定等待时间（ms） |
| `--video-settle-ms` | int | `5000` | 视频页稳定等待时间（ms） |
| `--safe-observe` | flag | — | 保守观察模式（等价 `observeMs=5000, profileSettleMs=8000, videoSettleMs=8000, keepOpen=true, maxItems=1`） |
| `--revisit` | bool | `false` | 允许回访 |
| `--no-revisit` | bool | `false` | 禁止回访 |
| `--preview` | bool | `false` | 预演模式 |
| `--ai-reply` | bool | `false` | AI 回复模式 |
| `--max-revisits` | int | `null` | 最大回访数 |
| `--max-notifications` | int | `50` | 最大通知采集数 |
| `--max-scroll-rounds` | int | `5` | 通知面板最大滚动轮数 |
| `--ai-max-comments` | int | `10` | AI 单次最大评论数 |
| `--ai-timeout-ms` | int | `30000` | AI 调用超时（ms） |
| `--reply-max-length` | int | `40` | 回复最大字符数 |
| `--revisit-like-only` | bool | `true` | 回访只点赞不评论 |
| `--days` | int | `null` | 限定最近 N 天的事件 |
| `--write-run-files` | bool | `false` | 写入运行摘要文件 |

### `--json` 模式的特殊行为

- `keepOpen` / `keepOpenOnError` / `pauseOnError` 强制为 `false`
- `observeMs` 降到 1000ms（Agent 不需要长停顿）
- `profileSettleMs` / `videoSettleMs` 保留至少 3000ms（页面未稳定不能读 DOM）

### `--safe-observe` 模式

等价于同时设置：

```
--observe-ms 5000 --profile-settle-ms 8000 --video-settle-ms 8000 --keep-open --max-items 1
```

适合首次使用或网络不稳定时。

---

## 1. auth

```bash
npm run auth
```

**源文件**：`src/auth-douyin.mjs`

打开浏览器并检测抖音登录态。检测到已登录后自动关闭浏览器并返回认证成功；60 秒未检测到登录态时提示扫码登录；最多等待 5 分钟，超时后关闭浏览器并返回验证失败。登录态保存在 `.playwright/` 目录下，后续命令复用。

无需任何参数。

---

## 2. db:init

```bash
npm run db:init
```

**源文件**：`src/db/migrations.mjs`

初始化 SQLite 数据库，创建 `interaction_events`、`actions` 等表。

无需任何参数。

---

## 3. interactions:scan

```bash
npm run interactions:scan -- --type all --json --debug
```

**源文件**：`src/cli/scan-interactions.mjs`

打开抖音通知中心，采集评论和点赞通知，写入本地数据库。

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--type` | string | `all` | 扫描类型：`all` / `comment` / `like` |
| `--pause-after-open` | int | `0` | 打开通知面板后停顿 ms |
| `--debug-notification-dom` | flag | — | 打印通知 DOM 调试信息 |

### 流程

```
打开浏览器 → 导航到通知页面 → 打开通知面板 → 等待面板稳定
→ 滚动采集通知 → 去重 → 入库 → 关闭面板
```

---

## 4. actions:plan

```bash
npm run actions:plan -- --json
```

**源文件**：`src/cli/plan-actions.mjs`

从数据库中读取已入库事件，生成两类候选：

- `replyCommentCandidates`：评论回复候选
- `visitWorkCandidates`：好友/互关用户作品回访候选

无命令特有参数（使用通用参数）。

---

## 5. actions:pending

```bash
npm run actions:pending -- --json
```

**源文件**：`src/cli/report-pending.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--type` | string | — | 筛选类型 |
| `--json` | bool | `false` | JSON 输出 |

列出当前待处理（pending）的事件和动作。

---

## 6. likes:plan

```bash
npm run likes:plan -- --json
```

**源文件**：`src/cli/plan-likes.mjs`

只读预览点赞候选，所有候选都带 `previewOnly: true` 和 `executeAllowed: false`。该命令不会执行真实点赞。

---

## 7. likes:reciprocate

```bash
npm run likes:reciprocate -- --execute --plan plan.json
```

**源文件**：`src/cli/execute-reciprocal-likes.mjs`

真实回赞入口当前默认禁用，`--execute` 会返回 `FEATURE_DISABLED`。保留该命令是为了兼容旧 Agent 和测试安全门禁；真实回访请使用 `return-visit:prepare` / `return-visit:execute`。

---

## 8. comments:classify

```bash
npm run comments:classify -- --text "求教程" --json
```

**源文件**：`src/cli/classify-comment.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--text` | string | 必填 | 要分类的评论文本 |
| `--json` | bool | `false` | JSON 输出 |

本地评论分类器，返回分类结果（`needs_review` / `ignore` / `auto_simple`）和风险等级。不依赖 Agent。

---

## 9. comments:prepare

```bash
npm run comments:prepare -- --event-id 42 --reply-text "谢谢支持"
```

**源文件**：`src/cli/prepare-comment-reply.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--event-id` | int | 必填 | 事件 ID |
| `--reply-text` | string | — | 回复文本 |
| `--decision` | string | `reply` | 决定：`reply` / `manual_review` / `ignore` |
| `--risk-level` | string | `low` | 风险等级 |
| `--decision-reason` | string | — | 决定理由 |
| `--relevance` | string | `neutral` | 相关性 |
| `--work-context-id` | string | — | 作品上下文 ID |
| `--comment-category` | string | `unclear` | 评论分类 |
| `--reply-mode` | string | `auto_natural` | 回复模式：`auto_natural` / `auto_simple` / `needs_review` / `ignore` |
| `--json` | bool | `false` | JSON 输出 |

为单条评论准备回复，记录决定和元数据。最小命令只需要 `--event-id` 和 `--reply-text`。缺少必填参数时会一次性输出所有缺失项。

`auto_simple` 要求回复文本来自模板池；`auto_natural` 允许 Agent 生成的自然回复，但会校验长度和禁用词。

---

## 10. comments:execute-all

```bash
npm run comments:execute-all -- --action-id 42 --execute
npm run comments:execute-all -- --action-ids 42,43 --execute
npm run comments:execute-all -- --all-prepared --max-items 20 --execute
```

**源文件**：`src/cli/execute-all-comment-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--action-id` | int | — | 单条动作 ID |
| `--action-ids` | csv | — | 批量动作 ID，例如 `1,2,3` |
| `--all-prepared` | flag | — | 处理所有 prepared 动作 |
| `--max-items` | int | `20` | 本轮最多处理条数 |
| `--execute` | bool | `false` | 是否真实发送；不加时只做数据门禁校验 |
| `--json` | bool | `false` | JSON 输出 |

评论回复默认入口。只处理 `prepared` 动作；旧手动分段链路已删除。加 `--execute` 后逐条打开页面并真实发送。

---

## 11. actions:reset-blocked

```bash
npm run actions:reset-blocked -- --action-id 42 --json
```

**源文件**：`src/cli/reset-blocked-action.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--action-id` | int | 必填 | 要恢复的 blocked 动作 ID |
| `--json` | bool | `false` | JSON 输出 |

将 blocked 评论回复动作恢复到 `prepared`，用于浏览器崩溃、profile 锁定、页面临时异常后的重试。不要手动改 SQLite。

---

## 12. return-visit:prepare

```bash
npm run return-visit:prepare -- --max-items 5
```

**源文件**：`src/cli/execute-return-visit-prepare.mjs`

准备回访任务：从互动事件创建或更新回访任务，进入用户主页和作品页采集上下文，生成回访评论并写入数据库。该命令不会点赞，也不会发表评论。

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--max-items` | int | 配置 `returnVisit.prepareMaxItems` 或 `20` | 本轮最多准备多少个回访任务 |
| `--event-limit` | int | 配置 `returnVisit.taskEventLimit` 或 `500` | 从互动事件创建任务时读取的事件上限 |
| `--event-status` | string | 配置 `returnVisit.eventSourceStatus` 或 `new` | 用于创建回访任务的互动事件状态 |
| `--keep-open` | flag | `false` | 复用并保留浏览器 |
| `--headless` | flag | `false` | 无头运行 |
| `--json` | flag | `false` | JSON 输出 |

---

## 13. return-visit:execute

```bash
npm run return-visit:execute -- --max-items 3
```

**源文件**：`src/cli/execute-return-visit.mjs`

执行回访任务：读取待执行回访任务，打开准备阶段选中的作品，检查点赞状态，点赞并发送已生成评论。该命令没有 `--execute` 参数；默认不加 `--dry-run` 即真实执行。

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--max-items` | int | 配置 `returnVisit.executeMaxItems` 或 `20` | 本轮最多执行多少个回访任务 |
| `--dry-run` | flag | `false` | 只预演，不真实点赞或评论 |
| `--watch-policy` | string | 配置 `returnVisit.watchPolicy` 或 `seconds` | 看视频策略 |
| `--watch-seconds` | string | 配置 `returnVisit.watchSeconds` 或 `5-8` | 看视频秒数，可传单个数字或 `min-max` |
| `--keep-open` | flag | `false` | 复用并保留浏览器 |
| `--headless` | flag | `false` | 无头运行 |
| `--json` | flag | `false` | JSON 输出 |

---

## 14. notify:inspect

```bash
npm run notify:inspect
```

**源文件**：`src/cli/inspect-notifications.mjs`

检查通知面板 DOM 结构，用于调试。

---

## 15. interactions:inspect

```bash
npm run interactions:inspect
```

**源文件**：`src/cli/inspect-interactions.mjs`

检查已入库的交互事件，用于调试。

---

## 16. history

```bash
npm run history
```

**源文件**：`src/cli/show-history.mjs`

查看历史运行记录。

---

## 17. dev:inspect-page

```bash
npm run dev:inspect-page -- --url "https://www.douyin.com" --keep-open
```

**源文件**：`src/cli/dev-inspect-page.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--url` | string | — | 要打开的 URL |
| `--keep-open` | flag | — | 保持浏览器打开 |
| `--label` | string | — | 页面标签 |
| `--wait-after-enter-ms` | int | — | 进入后等待时间 |

开发调试工具：打开页面并检查 DOM。

---

## 18. debug:like-dom

```bash
npm run debug:like-dom
```

**源文件**：`scripts/debug-like-dom.mjs`

调试点赞按钮 DOM 结构。

---

## 19. debug:like-state

```bash
npm run debug:like-state
```

**源文件**：`scripts/debug-like-state.mjs`

调试点赞状态检测逻辑。

---

## 页面稳定等待（page-settle）

**源文件**：`src/browser/page-settle.mjs`

三个核心函数控制页面切换节奏：

### waitForHumanObservation(page, label, ms, logger)

人工观察停留。打印 `[label]，停留 Nms 供人工确认...` 后等待指定时间。

### waitForProfileSettled(page, options)

主页稳定等待：

1. 等待 `body` 可见
2. 等待至少 `profileSettleMs`（默认 6000ms）
3. 检查视频链接是否存在
4. 如果不存在，额外等 3000ms 后再检查
5. 仍然不存在则返回 `blocked`

### waitForVideoSettled(page, options)

视频页稳定等待：

1. 等待 `body` 可见
2. 检查 URL 包含 `/video/` 或 `/note/`
3. 等待至少 `videoSettleMs`（默认 5000ms）
4. 检查点赞按钮或视频播放器元素是否存在
5. 如果不存在，额外等 3000ms 后再检查
6. 仍然不存在则返回 `blocked`

---

## 安全规则汇总

| 规则 | 约束 |
|---|---|
| 默认只读 | 默认仅允许扫描、汇总和生成候选 |
| 明确执行 | 真实动作必须显式传入 `--execute` |
| 单条执行 | 真实执行默认最多 1 条（`--max-items 1`） |
| prepared 后执行 | 评论回复从 prepared action 直接执行 |
| 状态未知即阻断 | 页面定位、关系判断或点赞状态不确定时不得继续 |
| 防重复 | 已成功执行过的事件或目标不得重复操作 |
| 可追溯 | 保存计划、执行结果、运行摘要和异常证据 |
| 风控停止 | 遇到验证码、登录失效、页面异常时立刻停止 |
| skill + maxItems=1 | skill 模式传入 `--selected-comment-text` 时必须 `--max-items 1` |
| 页面未稳定即阻断 | `waitForProfileSettled` / `waitForVideoSettled` 失败时 blocked |
| 作品缺少标题即阻断 | 回访执行中作品无标题时 blocked |
