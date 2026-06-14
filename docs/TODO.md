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

2. 回评主流程（无中间 JSON）
   comments:execute --days N --limit M
   ├─ 从 work_comments 查询待回评
   ├─ 进程内调用 Hermes/OpenClaw 写回 reply_text
   └─ CLI 打开作品、定位评论、填写并提交回复

3. 回访主流程（无二次主页访问）
   visit:run --execute
   ├─ 打开用户主页并监听作品列表 API
   ├─ 根据 workId 点击目标作品
   ├─ 进程内调用 Hermes/OpenClaw 生成评论
   └─ CLI 填写并提交评论
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
│  ├─ 不再按最大条数提前截断                      → 继续扫描        │
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
查询待回评摘要 / 创建或更新待回访 DB 任务
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
| 赞了你的作品 / 视频 / 点赞了你的作品 | `like_received` | `like` | 入库记录，进入待回访 DB 任务 |
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
| `COLLECT_PENDING_REPLY` | `works[].comments[].collect_status_code` / DB | 评论已入库，等待 `comments:execute` 调 Hermes/OpenClaw 生成回复 |
| `SKIP_DUPLICATE_NOTIFICATION` | 日志 | 通知重复，跳过 |
| `SKIP_WORK_COLLECTED` | 日志 | 作品评论已采集，跳过 |
| `LIKE_EVENT_STORED` | `interaction_events` | 点赞通知已入库 |
| `NOTIFY_OWNER_STORED` | 现有表 | 回复我的/关注我的记录，暂不处理 |
| `UNKNOWN_LOGGED` | 日志 | 未知通知已记录 |

---

## 二、评论回复模块（`comments:execute`）

### 2.1 评论回复内部流程

`comments:execute` 只从数据库查询待回评评论，先在当前进程内通过 Hermes/OpenClaw 生成 `reply_text` 并写回 `work_comments`，再按作品分组执行“单作品单遍向下扫描”。不再读取、写回或生成中间 JSON 文件。

```text
work_comments
 WHERE reply_status='pending'
   AND reply_text IS NULL/空
 ↓
comments:execute（默认 DB + 本地 AgentProvider + 执行）
  ├─ listPendingCommentsGroupedByHomepageAndWork(limit/days)
  ├─ buildWorkCommentItemsFromDbRows()
  │
  ├─ generateMissingReplies()
 │  ├─ 已有 reply_text → 跳过生成
 │  ├─ 构造 ReplyContext（作品标题/描述 + 对方评论 + 作者/评论者）
  │  ├─ LocalAgentProvider.generateReply()
  │  │  └─ generateReplyWithHermes → Hermes/OpenClaw CLI
  │  │     └─ 返回 {"reply":"回复内容"}
 │  ├─ 成功 → saveReplyText(commentId, reply)
 │  └─ 失败 → markCommentBlocked(agent_generate_failed:reason)
 │
 ├─ --agent-only → 只生成并写回 reply_text，不打开浏览器
 │
 ├─ 逐条校验 / 补全执行上下文：
 │  ├─ reply_text 为空 → 日志跳过（skipped_empty_reply）
 │  ├─ 已 succeeded → 跳过重复执行（EXECUTE_ALREADY_CONFIRMED）
 │  └─ 已 sent_unverified → 跳过重复执行（EXECUTE_ALREADY_SENT_UNVERIFIED）
 │
 ├─ 按作品分组 (workUrl / workId / modalId)
 │
 └─ 每个作品 group 只打开一次：
    启动浏览器
    ↓
    ├─ 创建 commentListCollector（监听 /aweme/v1/web/comment/list/）
    │  └─ group 级 finally 统一 stop()
    │
    ├─ openProfileWorkByAwemeIdFromPostApi(homepageUrl, workId/modalId)
    │  ├─ 打开/复用作者主页，拦截 /aweme/v1/web/aweme/post/ 定位作品卡片
    │  ├─ 点击目标作品卡片 → waitForWorkModal → waitForWorkCommentArea
    │  └─ 打开作品 / modal / 评论区失败 → 当前 group 全部 markCommentBlocked
    │
    ├─ 建立 pendingMap（当前作品全部待回复评论）
    │
    ├─ executeSinglePassForWorkGroup
    │  ┌── 当前作品单遍扫描循环 ────────────────────────────────────────┐
    │  │                                                               │
    │  │  collectVisibleWorkCommentCandidates()                        │
    │  │  └─ 采集当前屏可见评论候选：cid / actor / comment / time      │
    │  │                                                               │
    │  │  planViewportPendingMatches()                                 │
    │  │  ├─ buildWorkReplyTarget()                                    │
    │  │  │  目标评论优先使用 DB / raw_comment_json / comment_key       │
    │  │  ├─ comment/list 旁路补全 actor/comment/cid                   │
    │  │  └─ pickWorkCommentCandidate()                                │
    │  │     匹配优先级: cid → text+actor → text                       │
    │  │                                                               │
    │  │  当前屏命中时：                                                │
    │  │  ├─ openReplyBoxForMatchedWorkComment()                       │
    │  │  │  真实鼠标点击“回复”，并确保底部 editor 已进入可输入态        │
    │  │  ├─ fillWorkReplyText()                                       │
    │  │  │  优先 contenteditable；失败回退 textarea/input             │
    │  │  ├─ clickSendWorkReply()                                      │
    │  │  │  优先发送按钮，找不到则回退 Enter                          │
    │  │  ├─ verifyWorkReplyVisible()                                  │
    │  │  ├─ 成功 → markCommentReplied + saveReplyText                 │
    │  │  └─ 未确认 → markCommentSentUnverified                        │
    │  │                                                               │
    │  │  每成功/阻断一条后：                                           │
    │  │  ├─ 从 pendingMap 移除                                        │
    │  │  └─ 重新采集当前屏 candidates，继续处理本屏剩余 pending       │
    │  │                                                               │
    │  │  当前屏无可处理项时才 scrollCommentAreaOnce()                 │
    │  │                                                               │
    │  │  停止条件：                                                   │
    │  │  ├─ pending 清空                                              │
    │  │  ├─ comment/list has_more=0 且当前屏无命中                    │
    │  │  ├─ 评论区滚动失败 / 到底                                      │
    │  │  ├─ 连续无进展                                                │
    │  │  └─ 达到最大 viewport 轮次                                    │
    │  └───────────────────────────────────────────────────────────────┘
    │
    ├─ 剩余 pending → markCommentBlocked(single_pass_not_found)
    │
    └─ 执行结果处理 → 更新 work_comments / interaction_events，不写中间 JSON
```

说明：

- 主流程不再使用创作者评论管理页，也不再按 `commentIndex` 点回复。
- Agent 只负责生成 `reply_text`；浏览器打开主页、点击作品、定位评论、填写和提交都由 CLI 执行。
- 默认流程不生成待回评文件，采集入库后运行 `comments:execute --days N --limit M`。
- 同作品多条 pending 必须在同一个作品会话里处理，回复成功后不会主动 `Escape` 关闭作品 modal。
- `comment/list` 只作为旁路数据源辅助确认 / 补全，不负责驱动逐条滚动查找。
- 当前屏多条 pending 可同时命中时，必须当前屏处理完再滚动下一屏。

### 2.2 状态码（回评阶段）

| 状态码 | 位置 | 含义 |
|---|---|---|
| `AGENT_REPLY_GENERATED` | 日志 / DB `reply_text` | Hermes/OpenClaw 已生成回复并写回 DB |
| `AGENT_REPLY_FAILED` | 日志 / DB `reply_reason` | Hermes/OpenClaw 生成失败，当前评论阻断 |
| `EXECUTE_CONFIRMED` | 日志 / DB | 已确认回复成功，同时更新 interaction_events.status=replied |
| `EXECUTE_SENT_UNVERIFIED` | 日志 / DB `reply_status` | 已发送但未确认 |
| `EXECUTE_BLOCKED` | 日志 / DB `reply_status` | 定位/输入/发送失败 |
| `EXECUTE_ALREADY_CONFIRMED` | 日志 | DB 中已是 succeeded，本轮跳过重复执行 |
| `EXECUTE_ALREADY_SENT_UNVERIFIED` | 日志 | DB 中已是 sent_unverified，本轮跳过重复执行 |
| `EXECUTE_SKIPPED_EMPTY` | 日志 | `reply_text` 为空，跳过执行 |
| `EXECUTE_FAILED` | 日志 / DB | 执行失败 |

#### 目标评论定位来源

采集完成后，主流程直接从 `work_comments` 查询 `reply_status = 'pending'` 的评论并调用 Hermes/OpenClaw。

执行阶段会优先从以下来源回填目标评论唯一标识：

```text
targetCommentId / commentTargetId / commentCid / cid
↓
comment_key
↓
raw_comment_json.comment.comment.cid
```

---

## 三、回访模块（`visit:run` / `return-visit:execute`）

### 3.1 准备阶段（扫描 / `return-visit:prepare` 辅助入口）

当前准备阶段只创建或更新 `return_visit_tasks`，不打开用户主页、不采集主页作品列表、不读写 JSON 文件。推荐主流程由 `interactions:scan --prepare-visits` 完成；`return-visit:prepare` 仅作为从 `interaction_events` 补建任务的辅助入口。

```text
加载数据源
interactions:scan --prepare-visits
  ├─ 当前扫描事件按用户 identity_key 去重
  ├─ 筛选 relation=friend/mutual
  ├─ createOrUpdateReturnVisitTasksFromItems
  └─ listReturnVisitScanTasks(days/maxCount) 输出摘要

return-visit:prepare（辅助）
  ├─ createOrUpdateReturnVisitTasksFromEvents(status)
  └─ listReturnVisitPrepareTasks
```

> 注意：主流程不需要运行 `return-visit:prepare`。采集入库后，直接运行 `visit:run` / `return-visit:execute`。

### 3.2 执行阶段（`return-visit:execute`）

```text
加载任务
listReturnVisitExecuteTasks
  (状态: pending_visit, pending_execute, executing, failed_collect,
   failed_generate_comment, failed_like, failed_comment; retry 次数限制)
   ↓
过滤脏任务 (getReturnVisitTaskExecutionIssue):
├─ 非可执行状态 → 跳过
├─ 无 targetWork.workUrl 且无 targetWork.workId → FAILED_COLLECT
└─ commentStatus=posted → 跳过（已评论过）
   ↓
通过 → 加入执行队列
   ↓
启动浏览器
   ↓
遍历可执行任务 (连续失败 ≥ max / 每 N 个休息 M ms):
├─ 状态 → EXECUTING
│
├─ executeReturnVisitTask(page, task, options):
│  │
│  ├─ [1/5] resolveWorkForExecution:
│  │  有 profileUrl + 对方作品 workId → openProfileWorkByAwemeId
│  │  ├─ 打开用户主页（每个任务一次）
│  │  ├─ 监听 /aweme/v1/web/aweme/post/ 主页作品列表 API
│  │  ├─ 根据 workId 匹配目标作品 index / DOM 卡片
│  │  ├─ 点击目标作品卡片 → 进入作品页 / modal
│  │  ├─ 无 workId 或未找到 workId → 选择主页首个非置顶作品
│  │  ├─ collectCurrentOpenedWork
│  │  │  收集 workId / workUrl / workTitle / workText / contentSummary / referenceComments 等
│  │  └─ 缺少 profileUrl → failed_collect (missing_profile_url_or_work_id)
│  │
│  ├─ [2/5] detectWorkPresentationKind + handleVideoWatch:
│  │  检测页面类型 (modal / note / video)
│  │  ├─ 视频页 → handleVideoWatch (policy=seconds/full, watchSeconds=[5,8])
│  │  └─ 图文/note → 跳过观看
│  │  （注：观看视频在点赞之前执行）
│  │
│  ├─ [3/5] checkLikeState:
│  │  ├─ already_liked → 跳过点赞
│  │  ├─ neutral → clickLike → confirmLikeSucceeded
│  │  └─ 无法确认 → failed_like (截图 debug)
│  │
│  ├─ waitRandom(likeToCommentMs) → 随机等待 (默认 [2000, 6000]ms)
│  │
│  ├─ [4/5] ensureReturnVisitCommentBoxReady:
│  │  ├─ modal 页 → waitForWorkModal → ensureWorkModalCommentBoxReady
│  │  └─ 视频页 → ensureCommentPanelOpen → findCommentInput/activateCommentComposer
│  │  fail → failed_comment（评论框不存在）
│  │
│  ├─ WAIT_AGENT_COMMENT:
│  │  ├─ buildCommentContext(task, resolvedWork)
│  │  ├─ LocalAgentProvider.generateComment()
│  │  │  └─ generateCommentWithHermes → Hermes/OpenClaw CLI
│  │  │     └─ 返回 {"comment":"评论内容"}
│  │  └─ fail → failed_generate_comment
│  │
│  ├─ [5/5] postReturnVisitComment(page, comment, presentation):
│  │  ├─ modal 页 → postWorkModalComment
│  │  └─ 视频页 → postVideoComment
│  │  fail → failed_comment（评论提交失败）
│  │
│  └─ 全部成功 → DONE
│
└─ 结果处理:
   ├─ result.ok → markReturnVisitDone
   │  likeStatus=liked/already_liked, commentStatus=posted
   ├─ result.dryRun → 回退 PENDING_EXECUTE (保留 likeStatus/commentStatus)
   ├─ result.status starts with "skipped_" → 记录跳过原因
   └─ 失败 → markReturnVisitFailure (FAILED_LIKE / FAILED_COMMENT / FAILED)
      累计连续失败, 达到阈值则暂停
   ↓
   每任务间 waitBetweenUsersMs (默认 [8000, 20000]ms)
   每 restEveryTasksRange 个任务后休息 restDurationMs (默认 [60000, 180000]ms)
```

### 3.3 任务状态枚举

```text
pending_visit → executing → done

过渡状态: collecting_content / content_collected / comment_generated / pending_execute

跳转路径: skipped_no_work / skipped_private / skipped_no_suitable_work
失败路径: failed_collect / failed_generate_comment / failed_like / failed_comment / failed
```

> 注意：新流程在执行阶段实时调用 Hermes/OpenClaw 生成评论，`comment_generated` / `pending_execute` 只作为状态机过渡状态保留。

### 3.4 状态码（回访阶段）

> 回访模块不使用 JSON 状态码，任务状态直接记录在 `return_visit_tasks` 表的 `status`、`like_status`、`comment_status` 字段中。

---

## 附录

### A. 模块边界与约束

```text
采集模块 (interactions:scan) — 通知面板唯一入口，负责入库；查询待处理范围时必须显式输入 --days；不生成中间 JSON
LocalAgentProvider — 进程内调用 Hermes/OpenClaw 生成 comment/reply 文本，可通过 AGENT_PROVIDER=hermes|openclaw 切换
agent-server — 可选 HTTP 调试/外部集成入口，不属于主流程
回评模块 (comments:execute) — 默认从 DB 查询待回评，只要求显式输入 --limit/--max-count，调用 LocalAgentProvider 生成 reply_text，再由 CLI 执行浏览器动作
回访模块 (visit:run / return-visit:execute) — 打开主页监听作品列表 API，匹配 workId，进入作品页后调用 LocalAgentProvider 生成 comment，再由 CLI 填写提交

actions:pending 不属于主流程；第一步已把评论和回访任务写入 DB。
return-visit:prepare 不属于推荐主流程。
只有用户明确要求回访时，才在评论回复结束后单独执行回访流程。
```

用户意图 → 命令映射：

```text
只看互动:   interactions:scan --display-only
评论回复:   interactions:scan --days N
           → comments:execute --days N --limit M
明确回访:   interactions:scan --days N --prepare-visits
           → visit:run --execute
评论+回访:  interactions:scan --days N
           → comments:execute --days N --limit M
           → visit:run --execute
```

### B. 开发约束

1. `interactions:scan --type` 支持 `all` / `comment` / `like` / `reply` / `follow`
   - 默认 `--collect-types` 为 `like,comment,reply,follow`
   - `reply` / `follow` 只入库并进入分类统计，暂不触发后续回评/回访执行
2. 新互动采集入口以通知中心为准，主路径使用 notice API（拦截 /aweme/v1/web/notice/），DOM 解析为降级路径
3. 采集业务数据通过 `upsertNotificationEvent()` 写入 `interaction_events`
4. 评论回复由 `comments:execute --days N --limit M` 调用 LocalAgentProvider 写入 `reply_text` 到 `work_comments` 并执行
5. 回访任务由 `interactions:scan --prepare-visits` 或 `return-visit:prepare` 创建/更新，默认执行入口是 `visit:run`
6. `return-visit:prepare` 仅从 DB 事件创建/查询任务，默认读取 `new`，可通过 `--event-status` 覆盖
7. 日志里 `newInBatch` 不是"新入库数量"，是"本次扫描内未见过且通过过滤"
8. `seenItemKeys` 是本次扫描级别去重，不是每轮去重

### C. 仓库文档同步

主要文档入口：

```text
README.md                              — 安装、初始化、命令快速参考
SKILL.md                               — Hermes/OpenClaw 主 Skill
references/comment-safety-rules.md     — 评论回复与回访评论共用规则
docs/COMMANDS.md                       — 全部命令参数详情
docs/todo_plan.md（本文件）              — 开发文档、流程图、架构约束
```

需注意避免的旧说明：采集产物是 JSON 文件、默认完整流程必须先 return-visit:prepare、Agent 需要编辑 JSON。

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
