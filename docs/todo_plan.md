# 开发文档

## 一、采集模块（`interactions:scan`）

### 1.1 主流程概览

```text
开始
 ↓
1. interactions:scan（仅通过通知中心扫描，主路径使用 notice API）
    状态码: SCAN_JSON_READY
    打开抖音通知中心 -> 打开通知面板 -> 启动 notice API 监听 -> 滚动面板
    ↓
    拦截 /aweme/v1/web/notice/ API 响应，逐条解码通知
   ├─ 赞我的作品 / 赞我的视频 / 点赞我的作品
   │  ↓
   │  通知级去重 (platformEventId / fingerprint)
   │  ├─ 已存在: duplicate
   │  └─ 不存在: LIKE_EVENT_STORED，写入 interaction_events (event_type=like)
   │
   ├─ 评论我的作品 / 评论我的视频
   │  ↓
   │  从 notice API payload 直接提取评论文本、用户、作品信息
   │  ├─ 通知级去重 → upsert interaction_events (event_type=comment)
   │  └─ 评论级去重 → upsert work_comments (reply_status=pending, COLLECT_PENDING_REPLY)
   │     注: 主路径不打开作品弹窗，评论文本来自 API 数据结构
   │
   ├─ 回复我的评论 / 赞我的评论
   │  ↓
   │  归入回复分类 (event_type=reply)
   │  ├─ 重复: SKIP_DUPLICATE_NOTIFICATION
   │  └─ 不重复: REPLY_EVENT_STORED，写入 interaction_events，暂不后续处理
   │
   ├─ 关注我 / 回关我
   │  ↓
   │  归入粉丝管理分类 (event_type=follow)
   │  ├─ 重复: SKIP_DUPLICATE_NOTIFICATION
   │  └─ 不重复: FOLLOW_EVENT_STORED，写入 interaction_events，暂不后续处理
   │
   └─ 其他通知
      ├─ 能识别: OTHER_STORED，分类入库
      └─ 不能识别: UNKNOWN_LOGGED，打印未知类型日志

2. Agent 读取 JSON，直接填写 reply_text 和 prepare_status_code → PREPARE_READY

3. comments:execute --items-file <JSON>
    → 校验并执行回复 → EXECUTE_JSON_DONE / EXECUTE_JSON_PARTIAL
```

### 1.2 通知采集内部流程（notice API 主路径 + DOM 降级）

主路径通过拦截 notice API 响应采集数据，仅在 API 无法捕获时降级到 DOM 解析。

```text
导航到通知主页 (creator.douyin.com/creator-micro/interactive)
 ↓
打开通知面板 (铃铛 hover/click)
 ↓
等待面板稳定 (DOM 就绪)
 ↓
鼠标移入面板 (保持悬浮态)
 ↓
启动 notice API 监听器 (createNoticeApiCollector)
  拦截 /aweme/v1/web/notice/ 响应
  解码 notice_list_v2，按 nid_str 去重压入 items[]
 ↓
┌── 滚动采集循环 (while round < maxScrollRounds) ──────────────────┐
│                                                                   │
│  检查 notice API 兜底:                                             │
│  └─ 2+ 轮后 items 仍为空 && responseCount=0                       │
│     → 降级到 DOM 解析路径 (runNotificationScanDomFallback)        │
│                                                                   │
│  遍历 apiCollector.getItems() 中的每条通知:                       │
│  ├─ 本次扫描内重复 (processedNoticeIds)         → skip           │
│  ├─ --type 过滤 (comment/like 不匹配)           → skip           │
│  ├─ --max-count M 条数限制                      → return(成功)    │
│  ├─ --days N 天数窗口 (事件 create_time 比较)                     │
│  │  ├─ 超过 N 天 → 累计连续过期计数                               │
│  │  │  └─ 连续 ≥ 3 条 → stop='old-relevant' → break             │
│  │  └─ 在窗口内 → 重置连续计数为 0                                 │
│  │                                                                 │
│  └─ 每条通知处理 (processNoticeApiItem):                           │
│     ├─ normalizeNoticeApiItem → 标准化字段                         │
│     ├─ upsert work_contexts (作品信息)                             │
│     ├─ upsertNotificationEvent (interaction_events)                │
│     │  去重: platformEventId → fingerprint → workId+actor+type    │
│     │  结果: inserted / enriched / duplicate / ambiguous           │
│     └─ 对 comment 类型:                                           │
│        └─ upsertWorkComment (work_comments)                        │
│           评论文本来自 API payload，不打开作品弹窗                  │
│           结果: inserted / enriched / duplicate                    │
│                                                                   │
│  ── 一轮处理完毕 ──                                               │
│  apiCollector.getMeta().hasMore === 0?          → break           │
│  DOM 显示 "暂无更多数据"?                         → break           │
│  达到最大滚动轮次 maxScrollRounds?               → break           │
│                                                                   │
│  scrollPanelDown() → apiCollector.waitForNewItems()                │
│  └─ 滚动失败? → break                                              │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
 ↓
生成待回复评论 JSON / 生成待回访 JSON
```

#### DOM 降级路径 (runNotificationScanDomFallback)

当 notice API 无法捕获数据（2+ 轮后 items 为空），降级到 DOM 解析：

```text
降级触发: 2+ 轮后 apiCollector items=0 && responseCount=0
 ↓
关闭通知面板 → 重新导航 → 重新打开面板
 ↓
┌── DOM 滚动采集循环 ───────────────────────────────────────────┐
│  extractVisibleNotifications() (DOM 解析)                     │
│  遍历每条通知:                                                  │
│                                                                │
│  └─ 按通知类型分发:                                              │
│     ├─ comment_on_my_work（评论我的作品）                       │
│     │  ├─ 作品级去重 → 已采集              → skip              │
│     │  └─ 未采集:                                              │
│     │     点击缩略图 → 等待作品弹窗                              │
│     │     └─ collectCommentsFromNotificationWork               │
│     │        ├─ extractWorkModalContext → 作品上下文            │
│     │        ├─ upsert work_contexts                           │
│     │        ├─ findUnrepliedCommentsInModal (作品内滚动采集)   │
│     │        │  └─ 连续 3 条过期 → 停止作品内滚动               │
│     │        ├─ upsert work_comments (评论级去重)               │
│     │        └─ 标记作品已采集                                  │
│     │     关闭作品弹窗 → 恢复通知面板                            │
│     │     └─ 恢复失败 → break                                  │
│     │                                                          │
│     ├─ like（赞我的作品）→ 写入 interaction_events               │
│     ├─ reply_to_my_comment → skip（暂不处理）                   │
│     └─ unknown → skip                                          │
│                                                                │
│  停止条件: hasMore=0 / noMoreData / 连续空轮 / 全重复           │
│  scrollPanelDown(600px)                                        │
└──────────────────────────────────────────────────────────────────┘
```

### 1.3 通知识别与分类

主路径通过 `normalizeNoticeApiItem()`（`src/domain/notice-api-normalization.mjs`）解码 notice API payload；DOM 降级路径通过 `normalizeCommentEvent()`（`src/domain/notification-action-router.mjs`）匹配固定短语：

| 通知内容 | `notificationAction` | `eventType` | 后续动作 |
|---|---|---|---|
| 评论了你的作品 / 视频 | `comment_on_my_work` | `comment` | API 路径直接 upsert work_comments；DOM 降级路径点击缩略图采集作品评论 |
| 回复了你的评论 / 赞了你的评论 | `reply_to_my_comment` | `reply` | 归入回复分类，暂不后续处理 |
| 赞了你的作品 / 视频 / 点赞了你的作品 | `like_received` | `like` | 入库记录，进入待回访 JSON |
| 关注了你 / 回关了你 | `follow_received` | `follow` | 归入粉丝管理分类，暂不后续处理 |
| 无法识别 | `unknown` | `unknown` | 打印日志 |

可识别动作列表：

```text
赞了你的作品  赞了你的视频  点赞了你的作品
评论了你的作品  评论了你的视频
赞了你的评论  回复了你的评论
关注了你  回关了你
```

类型判断（notice API 路径通过 `item.type` 字段区分；DOM 降级通过文本匹配）：

- API 路径：`normalizeNoticeApiItem()` 根据 `notice_list_v2[].type` 字段判断
- DOM 降级路径：
  - 包含"回复" 或 "赞了你的评论" → `eventType = 'reply'`
  - 包含"关注" 或 "回关" → `eventType = 'follow'`
  - 包含"赞了" 或 "点赞" → `eventType = 'like'`
  - 其余已匹配评论类短语 → `eventType = 'comment'`

> 注：主路径（notice API）评论通知的 `comment_text` 直接来自 API payload，不再打开作品弹窗滚动采集。DOM 降级路径仍会点击缩略图进入作品弹窗采集评论。

**约束**：`interaction_events.event_type` 允许 `comment` / `like` / `reply` / `follow`。

### 1.4 去重机制

通知采集有四级去重：

**API 级去重**（主路径，`processedNoticeIds`）：
- 主路径: `nid_str` 去重，确保每个通知只处理一次

**内存级去重**（DOM 降级路径，`seenItemKeys`）：
- 使用 `seenItemKeys`，优先 `notificationItemKey`，其次 `platformEventId`，再次组合 key
- **是本次扫描级别去重，不是每轮去重**

**通知级去重**（来源表 `interaction_events`）：
- 优先 key: `platform_event_id`
- 其次: `fingerprint`
- 再次: `target_work_id` + `actor_profile_key` + `event_type` 组合

**作品级去重**（来源表 `work_contexts`）：
- key: `work_id` / `modal_id` / `thumbnail_key` / `work_url`

**评论级去重**（来源表 `work_comments`）：
- 优先 key: `comment_key`
- 无稳定 ID 时组合生成: `work_id/modal_id + actor_profile_key + comment_text + event_time_text`

**入库去重**（`upsertNotificationEvent`）：
1. `platformEventId` 精确匹配
2. `fingerprint` 匹配
3. 有 `workId` 时做 partial match
4. 都不匹配则插入新事件

入库结果: `inserted` / `enriched` / `duplicate` / `ambiguous`

### 1.5 采集字段

主路径每条通知从 notice API payload 解码，字段映射由 `notice-api-normalization.mjs` 负责。

```text
username  relation  eventType  action  content  timeText
actorProfileUrl  actorProfileKey  profileResolveMethod
workUrl  workId  workTitle  thumbnailSrc  thumbnailAlt  thumbnailKey
platformEventId  notificationItemKey
```

其中 `eventType = comment | like | reply | follow`。

> 主路径 comment 类型通知的 `comment_text` 来自 notice API 数据结构，不来自作品弹窗 DOM 采集。DOM 降级路径的 comment_text 来自 `collectCommentsFromNotificationWork()` 中的作品弹窗 DOM 提取。

### 1.6 跳过日志

所有 `continue` / `return` / `skip` 前必须打印详细日志，格式示例：

```text
[通知跳过] index=12 eventType=comment actorName=张三 targetWorkId=video-987
dedupeKey=work:video-987 reason=该作品评论已采集过 rawText=张三评论了你的作品
```

### 1.7 数据表

采集事件写入 `interaction_events`（事件类型支持 `comment` / `like` / `reply` / `follow`）：

```text
platform  event_type  actor_name  actor_profile_key  actor_profile_url
relation  my_work_title  comment_text  event_time_text
platform_event_id  notification_item_key  fingerprint  raw_payload_json
target_work_id  target_work_url  dedup_confidence
profile_resolution_status  status  scanned_at
```

说明：业务数据通过 `upsertNotificationEvent()` 写入。命令启动时会执行数据库迁移。

### 1.8 JSON 输出

`--json` 输出分为 `data` 和 `summary`：

| 位置 | 字段 |
|---|---|
| `data` | `events`, `failedEvents`, `ambiguousEvents`, `counts` |
| `summary` | `totalScanned`, `inserted`, `duplicates`, `enriched`, `ambiguous`, `parseFailed`, `profileResolved`, `profileUnresolved`, `scrollRounds`, `source` |

### 1.9 状态码（采集阶段）

| 状态码 | 位置 | 含义 |
|---|---|---|
| `SCAN_JSON_READY` | JSON `workflow_status_code` | 采集完成（主路径 notice API + 降级 DOM），JSON 可编辑 |
| `COLLECT_PENDING_REPLY` | `works[].comments[].collect_status_code` | 评论已入库，等待填写回复 |
| `SKIP_DUPLICATE_NOTIFICATION` | 日志 | 通知重复，跳过 |
| `SKIP_WORK_COLLECTED` | 日志 | 作品评论已采集，跳过 |
| `LIKE_EVENT_STORED` | `interaction_events` | 点赞通知已入库 |
| `NOTIFY_OWNER_STORED` | 现有表 | 回复我的/关注我的记录，暂不处理 |
| `UNKNOWN_LOGGED` | 日志 | 未知通知已记录 |

---

## 二、评论回复模块（`comments:execute`）

### 2.1 评论回复内部流程

Agent 直接填写 JSON 的 `reply_text`，`comments:execute` 执行时写 DB 并回复。

```text
JSON（Agent 已填写 reply_text）
 ↓
comments:execute（执行阶段 — 默认真实执行）
 ├─ 加载 JSON，提取全部评论（无数量限制）
 │
 ├─ 逐条检查：
 │  ├─ reply_text 为空 → 日志跳过（skipped_empty_reply）
 │  ├─ 已 succeeded → 跳过重复执行（EXECUTE_ALREADY_CONFIRMED）
 │  └─ 已 sent_unverified → 跳过重复执行（EXECUTE_ALREADY_SENT_UNVERIFIED）
 │
 └─ 逐条真实执行：
    启动浏览器
    ↓
    ├─ saveReplyText → 写入 reply_text 到 work_comments
    │
    ├─ page.goto(workUrl) → 等待作品弹窗
    │  └─ 弹窗未出现 → markCommentBlocked
    │
    ├─ findCommentInWorkModal (作品内滚动最多 30 轮)
    │  └─ 找不到 → markCommentBlocked
    │
    ├─ openReplyBoxByIndex → 打开回复框
    │  └─ 失败 → markCommentBlocked
    │
    ├─ 模拟打字 → sendReplyInWorkModal → 发送
    │  └─ 失败 → markCommentBlocked
    │
    ├─ verifyReplyInWorkModal → 确认回复
    │  ├─ 确认成功 → markCommentReplied
    │  │  reply_status = succeeded
    │  │  同时更新 interaction_events.status = replied
    │  └─ 已发送未确认 → markCommentSentUnverified
    │     reply_status = sent_unverified
    │
    └─ 回写 JSON 状态码
       ├─ 全部成功或全部可跳过 → EXECUTE_JSON_DONE（使用 isSkippedResult 判断）
       └─ 存在真正的失败 → EXECUTE_JSON_PARTIAL
       重复执行已成功 → EXECUTE_ALREADY_CONFIRMED
       重复执行已 sent_unverified → EXECUTE_ALREADY_SENT_UNVERIFIED
```

### 2.2 状态码（回评阶段）

| 状态码 | 位置 | 含义 |
|---|---|---|
| `PREPARE_WAIT_REPLY_TEXT` | JSON / 评论字段 | 等待填写 `reply_text` |
| `PREPARE_JSON_UPDATED` | JSON `workflow_status_code` | 准备完成，JSON 已回写 |
| `PREPARE_READY` | `works[].comments[].prepare_status_code` | 已写入 `reply_text`，等待执行 |
| `PREPARE_FAILED` | `works[].comments[].prepare_status_code` | 准备失败，查看 `prepare_error` |
| `EXECUTE_JSON_DONE` | JSON `workflow_status_code` | 全部成功或全部可跳过（空回复/已回复/已发送） |
| `EXECUTE_JSON_PARTIAL` | JSON `workflow_status_code` | 有失败或未确认 |
| `EXECUTE_CONFIRMED` | `works[].comments[].execute_status_code` | 已确认回复成功，同时更新 interaction_events.status=replied |
| `EXECUTE_SENT_UNVERIFIED` | `works[].comments[].execute_status_code` | 已发送但未确认 |
| `EXECUTE_BLOCKED` | `works[].comments[].execute_status_code` | 定位/输入/发送失败 |

#### 待回复评论 JSON

采集完成后，从 `work_comments` 查询 `reply_status = 'pending'` 的评论，按 `work_id || modal_id || '__unknown__'` 聚合输出 JSON。字段优先沿用 `work_comments` 现有字段，不做扩表。

---

## 三、回访模块（`return-visit:prepare` / `return-visit:execute`）

### 3.1 准备阶段（`return-visit:prepare`）

```text
加载数据源
├─ --items-file → createOrUpdateReturnVisitTasksFromItems
│  JSON 中每个用户: identity_key 去重 → insert/enrich
└─ 无文件 → createOrUpdateReturnVisitTasksFromEvents
   从 interaction_events (status=new)
   筛选 friend/mutual → identity_key 去重 → insert/enrich
   ↓
listReturnVisitPrepareTasks (状态: pending_visit 等)
   ↓
启动浏览器
   ↓
遍历待准备任务 (连续失败 ≥ maxConsecutiveFailures 则停止):
├─ 无 profileUrl → FAILED_COLLECT
│
├─ 打开用户主页
│  ├─ 私密账号 → SKIPPED_PRIVATE
│  └─ listProfileWorkUrls (滚动采集视频/笔记链接)
│
├─ 遍历候选作品 (最多 maxWorksToCheck 个):
│  ├─ navigateToVideo → 检查点赞状态
│  ├─ getVideoTitle → 提取作品标题
│  ├─ extractVideoCommentContext → 提取参考评论
│  ├─ analyzeReturnVisitContext → 场景信号分析
│  │  └─ 无场景信号 / 无作品标题且无评论 → 跳过
│  └─ 选择最佳作品
│
├─ 无合适作品 → SKIPPED_NO_SUITABLE_WORK
│
├─ generateReturnVisitComment → 生成回访评论
│  └─ 失败 → FAILED_GENERATE_COMMENT
│
└─ 成功 → 更新任务:
   status: collecting_content → content_collected
          → comment_generated → pending_execute
   写入 targetWork + referenceComments + generatedComment
```

### 3.2 执行阶段（`return-visit:execute`）

```text
listReturnVisitExecuteTasks (status: pending_execute 等)
   ↓
过滤脏任务:
├─ 无 generatedComment → FAILED_GENERATE_COMMENT
├─ 无 targetWork.workUrl → FAILED_COLLECT
└─ 通过 → 加入执行队列
   ↓
启动浏览器
   ↓
遍历可执行任务 (连续失败 ≥ max / 每 N 个休息 M ms):
├─ 状态 → executing
│
├─ executeReturnVisitTask:
│  ├─ resolveWorkForExecution:
│  │  ├─ knownWorkUrl → collectWorkFromUrl
│  │  └─ 失败 → 降级: collectCandidateWorkFromProfile
│  │     ├─ 私密 → skipped_private
│  │     └─ 无合适作品 → skipped_no_suitable_work
│  │
│  ├─ navigateToVideo(workUrl)
│  │
│  ├─ checkLikeState → 点赞状态检测
│  │  ├─ already_liked → 跳过点赞
│  │  └─ neutral → clickLike → confirmLikeSucceeded
│  │
│  ├─ waitRandom(likeToCommentMs) → 随机等待
│  ├─ handleVideoWatch → 观看视频
│  │
│  ├─ postVideoComment → 发送回访评论
│  │
│  └─ dry-run 模式: 只检查不执行
│
└─ 结果处理:
   ├─ done → markReturnVisitDone
   │  likeStatus=liked/already_liked, commentStatus=posted
   ├─ dry-run → 回退 PENDING_EXECUTE
   ├─ skipped_* → 记录跳过原因
   └─ 失败 → markReturnVisitFailure (累计连续失败)
```

### 3.3 任务状态枚举

```text
pending_visit → collecting_content → content_collected
→ comment_generated → pending_execute → executing → done

跳转路径: skipped_no_work / skipped_private / skipped_no_suitable_work
失败路径: failed_collect / failed_generate_comment / failed_like / failed_comment / failed
```

### 3.4 状态码（回访阶段）

> 回访模块不使用 JSON 状态码，任务状态直接记录在 `return_visit_tasks` 表的 `status`、`like_status`、`comment_status` 字段中。

---

## 附录

### A. 模块边界与约束

```text
采集模块 (interactions:scan)     — 通知面板唯一入口
回评模块 (comments:execute) — 只消费待回评 JSON，执行时写入 DB
回访模块 (return-visit:prepare/execute) — 只消费待回访 JSON

actions:pending 不属于主流程；第一步已拿到按作品分组的评论 JSON。
return-visit:prepare 不属于评论回复默认流程。
只有用户明确要求回访时，才在评论回复结束后单独执行回访流程。
```

用户意图 → 命令映射：

```text
只看互动:   interactions:scan --display-only
评论回复:   interactions:scan --generate-reply-json
           → Agent 填写 reply_text → comments:execute --items-file <JSON>
明确回访:   interactions:scan --generate-visit-json
           → return-visit:prepare --items-file <JSON>
           → return-visit:execute --execute
评论+回访:  interactions:scan --generate-reply-json --generate-visit-json
           → 先回评，再按用户明确意图走回访
```

### B. 开发约束

1. 采集类型只有 `all` / `comment` / `like`，暂无 `follow`
2. 新互动采集入口以通知中心为准，主路径使用 notice API（拦截 /aweme/v1/web/notice/），DOM 解析为降级路径
3. 采集业务数据通过 `upsertNotificationEvent()` 写入 `interaction_events`
4. 评论回复由 `comments:execute` 写入 `reply_text` 到 `work_comments` 并执行
5. 回访任务由 `return-visit:prepare` 创建或更新
6. `return-visit:prepare` 默认读取 `new`，可通过 `--event-status` 覆盖
7. 日志里 `newInBatch` 不是"新入库数量"，是"本次扫描内未见过且通过过滤"
8. `seenItemKeys` 是本次扫描级别去重，不是每轮去重

### C. 仓库文档同步

主要文档入口：

```text
README.md                              — 安装、初始化、命令快速参考
SKILL.md                               — Hermes/OpenClaw 路由入口
docs/COMMANDS.md                       — 全部命令参数详情
docs/todo_plan.md（本文件）              — 开发文档、流程图、架构约束
skills/creator-interaction-executor/   — 互动执行 Skill 文档
skills/creator-comment-suggestion/     — 评论回复建议 Skill 文档
```

需注意避免的旧说明：采集产物用于回访、默认完整流程必须先 return-visit:prepare。

### D. 字段映射

| 逻辑含义 | 当前字段 / 结构 |
|---|---|
| 通知类型 | `interaction_events.event_type` (`comment` / `like`) |
| 用户 ID | `actor_profile_key`；无则退到 `actor_profile_url`，再退到 `actor_name` |
| 作品唯一标识 | `target_work_id` / `works.work_id` |
| 作品 URL | `target_work_url` / `works.work_url` |
| 评论唯一标识 | `work_comments.comment_key` |
| 通知时间 | `interaction_events.event_time_text` |
| 是否需要回复 | `work_comments.reply_status = 'pending'` |
| 回访处理状态 | `return_visit_tasks.status` / `like_status` / `comment_status` |
