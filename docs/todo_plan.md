# 开发文档

## 一、采集模块（`interactions:scan`）

### 1.1 主流程概览

```text
开始
 ↓
1. interactions:scan
   状态码: SCAN_JSON_READY
   打开主页 -> 打开通知面板 -> 逐条扫描通知
   ├─ 赞我的
   │  ↓
   │  通知级去重
   │  ├─ 已存在: SKIP_DUPLICATE_NOTIFICATION
   │  └─ 不存在: LIKE_EVENT_STORED，写入 interaction_events
   │
   ├─ 评论我的
   │  ↓
   │  提取缩略图作品唯一标识
   │  ↓
   │  作品级去重
   │  ├─ 已采集: SKIP_WORK_COLLECTED
   │  └─ 未采集:
   │      WORK_COLLECTING
   │      点击缩略图进入作品 → 滚动采集评论 → 评论级去重
   │      连续 3 条过期则停止 → 写入 work_comments → 标记作品已采集
   │      输出按作品分组 JSON (每条 COLLECT_PENDING_REPLY)
   │
   ├─ 回复我的 / 关注我的
   │  ├─ 重复: SKIP_DUPLICATE_NOTIFICATION
   │  └─ 不重复: NOTIFY_OWNER_STORED，分类入库，暂不处理
   │
   └─ 其他通知
      ├─ 能识别: OTHER_STORED，分类入库
      └─ 不能识别: UNKNOWN_LOGGED，打印未知类型日志

2. 填写第一步 JSON 的 reply_text → PREPARE_WAIT_REPLY_TEXT

3. comments:prepare --items-file <JSON> → PREPARE_JSON_UPDATED

4. comments:execute-all --items-file <JSON> --execute
   → EXECUTE_JSON_DONE / EXECUTE_JSON_PARTIAL
```

### 1.2 通知面板滚动采集内部流程

```text
导航到通知主页
 ↓
打开通知面板 (铃铛 hover/click)
 ↓
等待面板稳定 (DOM 就绪)
 ↓
鼠标移入面板 (保持悬浮态)
 ↓
┌── 滚动采集循环 (while true) ────────────────────────────────────┐
│                                                                   │
│  extractVisibleNotifications()                                    │
│  ├─ 失败（首轮）→ 阻断返回                                        │
│  └─ 成功 → 获取可见通知列表 + noMoreData 标记                       │
│                                                                   │
│  遍历每条通知:                                                     │
│  ├─ 本次扫描内重复 (seenItemKeys)                 → skip           │
│  ├─ 数据库已存在 (dedupeContext.notificationKeys) → skip           │
│  ├─ --type 过滤 (comment/like 不匹配)             → skip           │
│  ├─ --days N 天数窗口                           → 天数检测          │
│  │  ├─ 超过 N 天 → 累计连续过期计数                                │
│  │  │  └─ 连续 ≥ 3 条 → stopDueToOldRelevant → break              │
│  │  └─ 在窗口内 → 重置连续计数为 0                                  │
│  ├─ --max-count M 条数限制                      → 条数检测          │
│  │  └─ seenItemKeys ≥ M → stopDueToOldRelevant → break            │
│  │                                                                 │
│  └─ 按通知类型分发:                                                 │
│     ├─ comment_on_my_work（评论我的作品）                           │
│     │  ├─ 作品级去重 → 已采集              → skip                  │
│     │  └─ 未采集:                                                  │
│     │     点击缩略图 → 等待作品弹窗                                 │
│     │     └─ collectCommentsFromNotificationWork                   │
│     │        ├─ extractWorkModalContext → 作品上下文                │
│     │        ├─ upsert work_contexts                               │
│     │        ├─ findUnrepliedCommentsInModal (作品内滚动采集)       │
│     │        │  └─ 连续 3 条过期 → 停止作品内滚动                   │
│     │        ├─ upsert work_comments (评论级去重)                   │
│     │        └─ 标记作品已采集                                     │
│     │     关闭作品弹窗 → 恢复通知面板                               │
│     │     ├─ 轻量恢复: Escape → waitForNotificationPanelStable      │
│     │     │  ├─ 面板幸存（原位恢复）→ 继续                          │
│     │     │  └─ 面板丢失 → 降级 page.goto + 重新打开面板            │
│     │     └─ 恢复失败 → stopDueToOldRelevant → break               │
│     │                                                              │
│     ├─ like（赞我的作品）                                           │
│     │  └─ 写入 interaction_events                                  │
│     │                                                              │
│     ├─ reply_to_my_comment（回复我的评论）→ skip（暂不处理）         │
│     └─ unknown（其他）                  → skip                     │
│                                                                   │
│  ── 一批处理完毕 ──                                                │
│  stopDueToOldRelevant?                          → break            │
│  noMoreData（面板显示"暂无更多数据"）?            → break            │
│  连续 2 轮无新通知 (consecutiveEmptyRounds ≥ 2)? → break            │
│  本轮全部重复 (allDuplicate)?                    → break            │
│                                                                   │
│  scrollPanelDown(600px)  (wheel 滚动)                              │
│  └─ 滚动失败? → break                                              │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
 ↓
生成待回复评论 JSON / 生成待回访 JSON
```

### 1.3 通知识别与分类

通知分类以 `src/domain/notification-action-router.mjs` 为准，只匹配固定短语：

| 通知内容 | `notificationAction` | `eventType` | 后续动作 |
|---|---|---|---|
| 评论了你的作品 / 视频 | `comment_on_my_work` | `comment` | 点击缩略图采集作品评论 |
| 回复了你的评论 | `reply_to_my_comment` | `comment` | 暂不后续处理 |
| 赞了你的作品 / 视频 / 评论 | `like_received` | `like` | 入库记录，不进入待回复 JSON |
| 无法识别 | `unknown` | `unknown` | 打印日志 |

可识别动作列表：

```text
赞了你的作品  赞了你的评论  赞了你的视频  点赞了你的作品
评论了你的作品  评论了你的视频  回复了你的评论
```

类型判断：包含"赞了"或"点赞" → `like`；其他已匹配评论类短语 → `comment`。

**约束**：`interaction_events.event_type` 只允许 `comment` / `like`。出现未知通知类型时，复用最接近的现有处理方式，或在代码中加 TODO 标明需要人工确认是否扩表。

### 1.4 去重机制

通知采集有三级去重：

**通知级去重**（来源表 `interaction_events`）：
- 优先 key: `platform_event_id`
- 其次: `fingerprint`
- 再次: `target_work_id` + `actor_profile_key` + `event_type` 组合

**作品级去重**（来源表 `work_contexts`）：
- key: `work_id` / `modal_id` / `thumbnail_key` / `work_url`

**评论级去重**（来源表 `work_comments`）：
- 优先 key: `comment_key`
- 无稳定 ID 时组合生成: `work_id/modal_id + actor_profile_key + comment_text + event_time_text`

**本次扫描内去重**：
- 使用 `seenItemKeys`，优先 `notificationItemKey`，其次 `platformEventId`，再次组合 key
- **`seenItemKeys` 是本次扫描级别去重，不是每轮去重**

**入库去重**（`upsertNotificationEvent`）：
1. `platformEventId` 精确匹配
2. `fingerprint` 匹配
3. 有 `workId` 时做 partial match
4. 都不匹配则插入新事件

入库结果: `inserted` / `enriched` / `duplicate` / `ambiguous`

### 1.5 采集字段

每条通知解析为：

```text
username  relation  eventType  action  content  timeText  rawText
actorProfileUrl  actorProfileKey  profileResolveMethod
workUrl  workId  workTitle  thumbnailSrc  thumbnailAlt  thumbnailKey
platformEventId  notificationItemKey
```

其中 `eventType = comment | like`。

### 1.6 跳过日志

所有 `continue` / `return` / `skip` 前必须打印详细日志，格式示例：

```text
[通知跳过] index=12 eventType=comment actorName=张三 targetWorkId=video-987
dedupeKey=work:video-987 reason=该作品评论已采集过 rawText=张三评论了你的作品
```

### 1.7 数据表

采集事件写入 `interaction_events`（事件类型只支持 `comment` / `like`）：

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
| `SCAN_JSON_READY` | JSON `workflow_status_code` | 采集完成，JSON 可编辑 |
| `COLLECT_PENDING_REPLY` | `works[].comments[].collect_status_code` | 评论已入库，等待填写回复 |
| `SKIP_DUPLICATE_NOTIFICATION` | 日志 | 通知重复，跳过 |
| `SKIP_WORK_COLLECTED` | 日志 | 作品评论已采集，跳过 |
| `LIKE_EVENT_STORED` | `interaction_events` | 点赞通知已入库 |
| `NOTIFY_OWNER_STORED` | 现有表 | 回复我的/关注我的记录，暂不处理 |
| `UNKNOWN_LOGGED` | 日志 | 未知通知已记录 |

---

## 二、评论回复模块（`comments:prepare` / `comments:execute-all`）

### 2.1 评论回复内部流程

```text
JSON (含 reply_text)
 ↓
comments:prepare（准备阶段）
 ├─ 加载 JSON，提取评论项
 ├─ 逐条校验：
 │  ├─ 缺少 work_comments.id                              → PREPARE_FAILED
 │  ├─ reply_text 为空                                     → EMPTY_REPLY_TEXT
 │  ├─ 策略字段无效 (decision/riskLevel/
 │  │   relevance/replyMode/commentCategory)               → BLOCKED
 │  ├─ 回复文本过长 / 命中模板黑名单                          → BLOCKED
 │  └─ 通过 → 查找 work_comments
 │     ├─ 不存在 → PREPARE_FAILED
 │     └─ 存在 → markCommentReplyPrepared
 │        reply_status = prepared
 └─ 回写 JSON 状态码
    ├─ 全部成功 → workflow_status_code: PREPARE_JSON_UPDATED
    └─ 部分失败 → 逐条记录 prepare_status_code
 ↓
comments:execute-all（执行阶段）
 ├─ dry-run（不带 --execute）
 │  └─ 逐条校验（id / reply_status=prepared /
 │     workUrl / reply_text）→ 输出校验报告
 │
 └─ --execute 真实执行
    启动浏览器
    ↓
    遍历每条已 prepare 的评论（上限 --max-items 条）:
    ├─ 校验失败 → blocked
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
    │  └─ 已发送未确认 → markCommentSentUnverified
    │     reply_status = sent_unverified
    │
    └─ 回写 JSON 状态码
       ├─ 全部成功 → EXECUTE_JSON_DONE
       └─ 部分失败 → EXECUTE_JSON_PARTIAL
```

### 2.2 状态码（回评阶段）

| 状态码 | 位置 | 含义 |
|---|---|---|
| `PREPARE_WAIT_REPLY_TEXT` | JSON / 评论字段 | 等待填写 `reply_text` |
| `PREPARE_JSON_UPDATED` | JSON `workflow_status_code` | 准备完成，JSON 已回写 |
| `PREPARE_READY` | `works[].comments[].prepare_status_code` | 已写入 `reply_text`，`reply_status=prepared` |
| `PREPARE_FAILED` | `works[].comments[].prepare_status_code` | 准备失败，查看 `prepare_error` |
| `EXECUTE_JSON_DONE` | JSON `workflow_status_code` | 全部执行成功 |
| `EXECUTE_JSON_PARTIAL` | JSON `workflow_status_code` | 有失败或未确认 |
| `EXECUTE_CONFIRMED` | `works[].comments[].execute_status_code` | 已确认回复成功 |
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
回评模块 (comments:prepare/execute-all) — 只消费待回评 JSON
回访模块 (return-visit:prepare/execute) — 只消费待回访 JSON

actions:pending 不属于主流程；第一步已拿到按作品分组的评论 JSON。
return-visit:prepare 不属于评论回复默认流程。
只有用户明确要求回访时，才在评论回复结束后单独执行回访流程。
```

用户意图 → 命令映射：

```text
只看互动:   interactions:scan --display-only
评论回复:   interactions:scan --generate-reply-json
           → comments:prepare --items-file <JSON>
           → comments:execute-all --items-file <JSON> --execute
明确回访:   interactions:scan --generate-visit-json
           → return-visit:prepare --items-file <JSON>
           → return-visit:execute --execute
评论+回访:  interactions:scan --generate-reply-json --generate-visit-json
           → 先回评，再按用户明确意图走回访
```

### B. 开发约束

1. 采集类型只有 `all` / `comment` / `like`，暂无 `follow`
2. 新互动采集入口以通知中心为准
3. 采集业务数据通过 `upsertNotificationEvent()` 写入 `interaction_events`
4. 评论回复由 `comments:prepare` 基于 JSON 更新 `work_comments`
5. 回访任务由 `return-visit:prepare` 创建或更新
6. `comments:prepare` 不更新 `interaction_events.status`
7. `return-visit:prepare` 默认读取 `new`，可通过 `--event-status` 覆盖
8. 日志里 `newInBatch` 不是"新入库数量"，是"本次扫描内未见过且通过过滤"
9. `seenItemKeys` 是本次扫描级别去重，不是每轮去重

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
