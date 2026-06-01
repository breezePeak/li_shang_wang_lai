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

打开浏览器，扫码登录抖音。登录态保存在 `.playwright/` 目录下，后续命令复用。

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

## 6. actions:approve

```bash
npm run actions:approve -- --action-id 42 --json
```

**源文件**：`src/cli/approve-action.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--action-id` | int | 必填 | 要审批的动作 ID |
| `--json` | bool | `false` | JSON 输出 |

审批指定动作，允许后续执行。

---

## 7. actions:confirm-execute

```bash
npm run actions:confirm-execute -- --action-id 42 --json
```

**源文件**：`src/cli/confirm-execute.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--action-id` | int | 必填 | 要确认执行的动作 ID |
| `--json` | bool | `false` | JSON 输出 |

将已审批动作标记为 `execute_confirmed`，允许真实执行。

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

## 9. comments:plan

```bash
npm run comments:plan -- --status new --max-items 10 --output plan.json
```

**源文件**：`src/cli/plan-comment-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--max-items` | int | — | 限制生成条数 |
| `--status` | string | — | 按状态筛选事件 |
| `--output` | string | — | 输出计划文件路径 |
| `--include-missing-work-title` | flag | — | 包含缺少作品标题的评论 |

根据数据库事件生成评论回复计划文件。

---

## 10. comments:approve-plan

```bash
npm run comments:approve-plan -- --plan plan.json --all
npm run comments:approve-plan -- --plan plan.json --event-id e1 --event-id e2
```

**源文件**：`src/cli/approve-comment-plan.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--plan` | string | 必填 | 计划文件路径 |
| `--all` | flag | — | 全部审批 |
| `--none` | flag | — | 全部拒绝 |
| `--event-id` | string[] | — | 指定审批的事件 ID（可多次使用） |
| `--index` | int[] | — | 指定审批的序号（可多次使用） |
| `--reason` | string | — | 审批理由 |
| `--dry-run` | flag | — | 只预演不修改 |
| `--output` | string | — | 输出路径 |

审批或拒绝评论回复计划中的条目。

---

## 11. comments:prepare

```bash
npm run comments:prepare -- --event-id 42 --reply-text "谢谢支持" --decision approve
```

**源文件**：`src/cli/prepare-comment-reply.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--event-id` | int | 必填 | 事件 ID |
| `--reply-text` | string | — | 回复文本 |
| `--decision` | string | — | 决定：`approve` / `skip` / `block` |
| `--risk-level` | string | — | 风险等级 |
| `--decision-reason` | string | — | 决定理由 |
| `--relevance` | string | — | 相关性 |
| `--work-context-id` | string | — | 作品上下文 ID |
| `--comment-category` | string | — | 评论分类 |
| `--reply-mode` | string | — | 回复模式 |
| `--json` | bool | `false` | JSON 输出 |

为单条评论准备回复，记录决定和元数据。

---

## 12. comments:execute

```bash
npm run comments:execute -- --action-id 42 --dry-run
```

**源文件**：`src/cli/execute-comment-reply.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--action-id` | int | 必填 | 动作 ID |

执行单条评论回复。遵循动作状态机：`approved` → `execute_confirmed` → `succeeded`。

---

## 13. comments:reply

```bash
npm run comments:reply -- --plan plan.json --dry-run --max-items 5
npm run comments:reply -- --plan plan.json --execute --max-items 3
```

**源文件**：`src/cli/execute-comment-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--plan` | string | 必填 | 计划文件路径 |

按作品分组批量执行评论回复。复用同一个浏览器和评论管理页，同一作品下多条评论只切换作品一次。

### 分组逻辑

- 分组键优先级：`workId` > `workUrl` > `workTitle` > `__unknown_work__`
- 分组键带前缀（`workId:xxx`、`workUrl:xxx`、`workTitle:xxx`），防止不同字段值相同导致撞组
- 空字符串、纯空格、null、undefined 归入 `__unknown_work__` 组
- 保持 group 出现顺序和组内 item 顺序

### 安全逻辑

- 未审批（`approved !== true`）跳过
- `replyText` 为空阻断
- 已 `succeeded` 的 action 跳过（防重复）
- `max-items` 控制真实执行数量
- 作品缺少 `workTitle` 时整组 blocked
- `selectWorkByTitle` 后二次 `getSelectedWorkTitle` 校验
- 作品选择失败只 blocked 当前 group，继续下一个 group
- dry-run 成功/失败都写 actions 表

---

## 14. comments:verify

```bash
npm run comments:verify -- --result result.json
```

**源文件**：`src/cli/verify-comment-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--result` | string | — | 结果文件路径 |

校验评论回复是否真实出现在页面上。

---

## 15. comments:resume

```bash
npm run comments:resume -- --result result.json
```

**源文件**：`src/cli/resume-comment-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--result` | string | — | 结果文件路径 |

从中断的结果文件恢复执行。

---

## 16. interactions:live

```bash
npm run interactions:live -- --max-items 5 --execute
```

**源文件**：`src/cli/live-interactions.mjs`

实时交互模式：打开通知面板，逐条处理评论通知，自动生成回复并执行。

使用全部通用参数。这是功能最完整的交互式命令。

---

## 17. interactions:collect

```bash
npm run interactions:collect -- --max-notifications 30
```

**源文件**：`src/cli/live-interactions.mjs`（加 `--collect-only`）

只采集通知，不生成回复。等价于 `interactions:live --collect-only`。

---

## 18. interactions:reply

```bash
npm run interactions:reply -- --execute --max-items 5
```

**源文件**：`src/cli/live-reply.mjs`

基于已入库的 work/comment 数据，生成回复并执行。使用全部通用参数。

---

## 19. replies:export

```bash
npm run replies:export -- --limit 20 --out replies.json --pretty
```

**源文件**：`src/cli/export-pending-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--limit` | int | `20` | 导出条数 |
| `--work-id` | string | — | 按作品 ID 筛选 |
| `--out` | string | — | 输出文件路径 |
| `--pretty` | flag | `true` | 格式化 JSON |
| `--no-pretty` | flag | — | 压缩 JSON |

导出待回复评论为 JSON 文件。

---

## 20. replies:apply

```bash
npm run replies:apply -- --input replies.json --commit
```

**源文件**：`src/cli/apply-prepared-replies.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--input` | string | 必填 | 输入文件路径 |
| `--dry-run` | flag | — | 只预演 |
| `--commit` | flag | — | 写入数据库 |
| `--overwrite` | flag | — | 覆盖已有回复 |

将导出的回复文件应用到数据库。

使用 `--commit` 成功写库且无错误后，命令会自动删除 `--input` 指定的临时结果文件。`--dry-run` 不会删除文件。

---

## 21. comments:prepare-replies

```bash
npm run comments:prepare-replies -- --max-items 5 --reply-max-length 40
```

**源文件**：`src/cli/prepare-work-comment-replies.mjs`

从数据库读取待回复评论，结合作品内容和已采集参考评论生成回复，并写回数据库。该命令不打开浏览器，不执行真实回复。

默认完整工作流不使用该命令。默认评论回复流程使用 `replies:export` 导出临时文件、agent 填写结果文件、`replies:apply -- --commit` 更新数据库，再执行 `replies:execute -- --execute`。

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--max-items` | int | `100` | 最多处理多少条待回复评论 |
| `--reply-max-length` | int | `40` | 回复最大长度，最小 `10` |

该命令不支持 `--execute`。

---

## 22. replies:execute

```bash
npm run replies:execute -- --execute --max-items 5
```

**源文件**：`src/cli/execute-prepared-replies.mjs`

执行已准备的回复。使用全部通用参数。

---

## 23. likes:plan

```bash
npm run likes:plan -- --mode auto --out likes-plan.json
```

**源文件**：`src/cli/plan-likes.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--mode` | string | — | 计划模式 |
| `--out` | string | — | 输出路径 |

生成点赞回访计划。

---

## 24. likes:reciprocate

```bash
npm run likes:reciprocate -- --plan likes-plan.json --dry-run
```

**源文件**：`src/cli/execute-reciprocal-likes.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--plan` | string | 必填 | 计划文件路径 |
| `--relation` | string | — | 按关系筛选 |

执行点赞回访。当前真实点赞功能为 `FEATURE_DISABLED`。

---

## 25. visits:plan

```bash
npm run visits:plan -- --source notifications
```

**源文件**：`src/cli/plan-visits.mjs`

### 命令特有参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--source` | string | — | 数据来源 |

生成作品回访计划。

---

## 26. visits:discover

```bash
npm run visits:discover -- --max-items 5 --keep-open
npm run visits:discover -- --max-items 1 --safe-observe
npm run visits:discover -- --json --max-items 3
```

**源文件**：`src/cli/discover-visits.mjs`

逐个访问好友/互关用户主页，找最新非置顶作品，进入视频页检查点赞状态。

### 页面切换节奏

```
进入用户主页
→ waitForProfileSettled（等待主页稳定）
→ waitForHumanObservation（停留供人工观察）
→ 确认主页视频列表存在
→ findLatestNonPinnedVideo（找候选作品）
→ waitForHumanObservation（停留供人工确认候选）
→ navigateToVideo（进入视频页）
→ waitForVideoSettled（等待视频页稳定）
→ waitForHumanObservation（停留供人工观察）
→ waitForTimeout(1500)（额外缓冲）
→ checkLikeState（检查点赞状态）
```

如果 `waitForProfileSettled` 或 `waitForVideoSettled` 失败，该候选标记为 `blocked`，不会继续执行。

### keepOpen 默认行为

- 非 `--json` 模式：默认 `keepOpen=true`，方便人工检查
- `--json` 模式：自动关闭浏览器

---

## 27. visits:review

```bash
npm run visits:review -- --json --max-items 5
```

**源文件**：`src/cli/review-visits.mjs`

汇总展示已发现的作品回访候选。使用全部通用参数。

---

## 28. visits:live-review

```bash
npm run visits:live-review -- --comment-mode skill --json --max-items 1
npm run visits:live-review -- --comment-mode local --max-items 5
npm run visits:live-review -- --comment-mode skill --execute --max-items 1 \
  --selected-comment-text "这个主题挺温柔的～" \
  --reply-mode agent_generated_review_required \
  --risk-level medium \
  --manual-review-method user_selected_agent_comment
npm run visits:live-review -- --safe-observe --max-items 1
```

**源文件**：`src/cli/live-review-visits.mjs`

访问好友主页 → 进入作品页 → 检查点赞 → 生成评论候选或输出上下文给 Agent。

### 三种 comment-mode

| 模式 | 用途 | 评论来源 | 状态 |
|---|---|---|---|
| `skill` | 给 Hermes / OpenClaw 使用 | 外部 Agent 根据 `SKILL.md` 生成 | 推荐默认 |
| `local` | 本地调试 | 本地规则生成器 | 可用 |
| `agent` | 项目自己调用大模型 | 内置 LLM provider | 预留（`FEATURE_DISABLED`） |

### skill 模式流程

1. 不传 `--selected-comment-text`：只输出 `commentContext` + `constraints`，Agent 生成评论
2. 传 `--selected-comment-text`：执行 Agent 选中的评论（必须 `--max-items 1`）

### 页面切换节奏

与 `visits:discover` 完全一致，使用相同的 `waitForProfileSettled` / `waitForVideoSettled` / `waitForHumanObservation` 流程。

### keepOpen 默认行为

- 非 `--json` 模式：默认 `keepOpen=true`
- `--json` 模式：自动关闭浏览器

---

## 29. return-visit:prepare

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

## 30. return-visit:execute

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

## 31. notify:inspect

```bash
npm run notify:inspect
```

**源文件**：`src/cli/inspect-notifications.mjs`

检查通知面板 DOM 结构，用于调试。

---

## 32. interactions:inspect

```bash
npm run interactions:inspect
```

**源文件**：`src/cli/inspect-interactions.mjs`

检查已入库的交互事件，用于调试。

---

## 33. history

```bash
npm run history
```

**源文件**：`src/cli/show-history.mjs`

查看历史运行记录。

---

## 34. dev:inspect-page

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

## 35. debug:like-dom

```bash
npm run debug:like-dom
```

**源文件**：`scripts/debug-like-dom.mjs`

调试点赞按钮 DOM 结构。

---

## 36. debug:like-state

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
| 默认只读 | 默认仅允许扫描、汇总、生成候选和 dry-run |
| 明确审批 | 真实动作必须由用户针对具体条目明确确认 |
| 单条执行 | 真实执行默认最多 1 条（`--max-items 1`） |
| 先预览后执行 | 在执行前展示目标、内容和动作 |
| 状态未知即阻断 | 页面定位、关系判断或点赞状态不确定时不得继续 |
| 防重复 | 已成功执行过的事件或目标不得重复操作 |
| 可追溯 | 保存计划、执行结果、运行摘要和异常证据 |
| 风控停止 | 遇到验证码、登录失效、页面异常时立刻停止 |
| skill + maxItems=1 | skill 模式传入 `--selected-comment-text` 时必须 `--max-items 1` |
| 页面未稳定即阻断 | `waitForProfileSettled` / `waitForVideoSettled` 失败时 blocked |
| 作品缺少标题即阻断 | `comments:reply` 中作品无 `workTitle` 时整组 blocked |
