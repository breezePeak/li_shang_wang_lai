# 礼尚往来 `interactions:live` 总体开发计划

> 当前版本目标：不再以 `comments:plan -> approve -> reply -> verify -> resume` 作为主链路。主链路改为：**通知页实时采集入库，数据库去重，按作品集中生成回复，集中执行评论回复，最后统一回访**。
>
> 本计划只围绕真实可跑通的主流程设计，不再把 `npm test` 作为验收标准。

---

## 1. 核心结论

通过清库重扫和页面实际验证，当前事实如下：

1. 通知页可以读到真实通知信息，包括：
   - 用户名 `actor_name`
   - 评论内容 `comment_text`
   - 用户主页 `actor_profile_url`
   - 通知原文 `raw_payload_json.rawText`
2. 通知页中**作品缩略图不是普通 a 链接**，不能直接从 `href` 中拿到作品地址。
3. 评论通知需要点击作品缩略图或通知卡片主体，通过前端事件进入作品 modal。
4. 点击评论通知缩略图后，会进入作品 modal，页面 URL 中出现 `modal_id`。
5. 作品 modal 右侧评论区结构与创作者后台评论管理页不同：
   - modal 容器：`.modal-video-container`
   - 评论区：`.comment-mainContent`
   - 评论项：`.comment-item-info-wrap`
   - 回复入口：`span` 文本为 `回复`
   - 回复输入框：`input[type="text"]`
6. 评论回复不能依赖提前生成的 plan 文件，因为作品信息必须点击通知进入 modal 后才能拿到。
7. 所有采集到的信息必须入库，防止重复处理。内存 Map 只能作为本轮运行的加速缓存，不能作为最终去重依据。
8. 回访只能在通知页扫描和评论回复处理完成后统一执行，不能边扫通知边回访。
9. `回复了你的评论` 不自动回复，也不加入回访列表，只提醒主人。

---

## 2. 最终主流程

```txt
interactions:live
  ↓
第一阶段：通知页扫描与入库
  ├─ 所有通知先 upsert 到 interaction_events
  ├─ 评论了你的作品：评论人加入 revisit_candidates
  ├─ 点赞通知：点赞人加入 revisit_candidates
  ├─ 回复了你的评论：只记录 skip / notify_owner
  ├─ unknown：只记录 skip / notify_owner
  ├─ 同一作品缩略图 / modalId / workId 只采集一次
  ├─ 进入作品 modal 后，作品信息入 works
  └─ 滚动评论区，待回复评论入 work_comments
  ↓
第二阶段：生成回复内容
  ├─ 从 work_comments 查询 pending 评论
  ├─ 按作品分组
  ├─ template 或 AI 批量生成回复
  └─ 回复内容写回 work_comments，状态变为 prepared
  ↓
第三阶段：执行评论回复
  ├─ 查询 prepared 评论
  ├─ 按作品打开 modal / workUrl
  ├─ 定位评论
  ├─ 点击 span 回复
  ├─ input[type=text] 输入并发送
  ├─ 更新 work_comments 状态
  └─ 写 actions.reply_comment
  ↓
第四阶段：统一回访
  ├─ 如果带 --no-revisit，则跳过
  ├─ 查询 revisit_candidates.status = pending
  ├─ 按用户去重
  ├─ 打开用户主页
  ├─ 打开最近作品
  ├─ 点赞
  └─ 更新 revisit_candidates 与 actions.like_work
```

一句话概括：

```txt
先扫通知并入库；同一作品只打开一次；作品评论集中采集入库；扫完后集中生成回复；集中回复；最后统一回访。
```

---

## 3. 命令总览

### 3.1 主命令：实时处理

```bash
npm run interactions:live -- --max-items 5 --preview --keep-open --no-revisit
```

```bash
npm run interactions:live -- --max-items 5 --execute --keep-open
```

建议新增或保留脚本：

```json
{
  "interactions:live": "node ./src/cli/live-interactions.mjs"
}
```

### 3.2 页面调试采集工具

```bash
npm run dev:inspect-page -- --keep-open --label work-modal
```

建议新增脚本：

```json
{
  "dev:inspect-page": "node ./src/cli/dev-inspect-page.mjs"
}
```

### 3.3 初始化数据库

```bash
npm run db:init
```

### 3.4 查询数据库状态

查看所有表：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all())"
```

查看通知事件分布：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT event_type,status,COUNT(*) count FROM interaction_events GROUP BY event_type,status ORDER BY count DESC\").all())"
```

查看作品采集：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT id,work_id,modal_id,work_title,work_url,thumbnail_key,last_seen_at FROM works ORDER BY id DESC LIMIT 20\").all())"
```

查看待回复评论：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT id,work_id,actor_name,comment_text,reply_status,reply_text FROM work_comments ORDER BY id DESC LIMIT 20\").all())"
```

查看回访候选：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT id,actor_name,revisit_key,status,reasons_json,updated_at FROM revisit_candidates ORDER BY id DESC LIMIT 20\").all())"
```

---

## 4. `interactions:live` 参数设计

### 4.1 基础参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--dry-run` | false | 只扫描、打印，不发送回复、不点赞；是否入库可以由实现决定，建议仍允许入库采集信息 |
| `--preview` | false | 评论回复阶段打开回复框并填入内容，但不点击发送 |
| `--execute` | false | 执行真实发送和真实点赞 |
| `--max-items N` | 10 | 本轮最多处理的评论回复数量，避免一次跑太多 |
| `--max-notifications N` | 50 | 最多扫描通知条数，可选新增 |
| `--max-scroll-rounds N` | 5 | 通知面板最多滚动轮数 |
| `--keep-open` | false | 执行后保持浏览器打开，方便人工检查 |
| `--keep-open-on-error` | false | 失败时保持浏览器打开 |
| `--pause-on-error` | false | 失败时暂停等待人工观察 |
| `--no-revisit` | false | 不收集回访候选，不执行回访阶段 |

### 4.2 回复生成参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--reply-mode template|ai` | `template` | 回复生成模式 |
| `--ai-reply` | false | 等价于 `--reply-mode ai` |
| `--ai-max-comments N` | 10 | 单个作品一次最多发给模型的评论数量 |
| `--ai-timeout-ms N` | 30000 | 模型调用超时时间 |
| `--reply-max-length N` | 40 | 回复最大长度建议 |

### 4.3 回访参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--no-revisit` | false | 禁止回访收集和回访执行 |
| `--max-revisits N` | 20 | 最多回访人数 |
| `--revisit-like-only` | true | 回访阶段只点赞，不评论 |

### 4.4 开发调试参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--debug-page` | false | 关键阶段保存页面调试信息，可选 |
| `--debug-dir <path>` | `data/debug` | 调试输出目录 |
| `--label <name>` | 空 | 用于调试目录命名 |

---

## 5. 数据库设计

现有表继续保留：

- `interaction_events`：记录通知事件。
- `actions`：记录最终执行过的动作，如评论回复、点赞回访、跳过。

需要新增三张核心表：

- `works`：记录已采集过的作品。
- `work_comments`：记录作品下采集到的评论，以及回复状态。
- `revisit_candidates`：记录需要回访的人。

### 5.1 `works`

用于防止同一个作品重复打开、重复采集。

```sql
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'douyin',

  work_id TEXT,
  modal_id TEXT,
  work_url TEXT,
  work_title TEXT,
  work_type TEXT,

  thumbnail_key TEXT,
  thumbnail_src TEXT,

  author_name TEXT,
  author_profile_url TEXT,
  author_profile_key TEXT,

  raw_context_json TEXT,

  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

索引：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_works_work_id
ON works(work_id)
WHERE work_id IS NOT NULL AND work_id != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_works_modal_id
ON works(modal_id)
WHERE modal_id IS NOT NULL AND modal_id != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_works_thumbnail_key
ON works(thumbnail_key)
WHERE thumbnail_key IS NOT NULL AND thumbnail_key != '';
```

### 5.2 `work_comments`

用于记录作品 modal 下所有需要回复或已经回复过的评论。

```sql
CREATE TABLE IF NOT EXISTS work_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  work_id TEXT,
  work_url TEXT,
  modal_id TEXT,

  actor_name TEXT,
  actor_profile_url TEXT,
  actor_profile_key TEXT,

  comment_text TEXT NOT NULL,
  event_time_text TEXT,
  comment_key TEXT NOT NULL,

  source_event_id INTEGER,
  source_notification_key TEXT,

  reply_status TEXT NOT NULL DEFAULT 'pending',
  reply_text TEXT,
  reply_reason TEXT,

  raw_comment_json TEXT,

  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  replied_at TEXT
);
```

状态设计：

| 状态 | 含义 |
|---|---|
| `pending` | 已采集，尚未生成回复 |
| `prepared` | 已生成回复，待发送 |
| `succeeded` | 已确认回复成功 |
| `sent_unverified` | 已发送但页面未确认 |
| `blocked` | 阻塞，需要人工处理 |
| `skipped` | 已跳过 |

唯一索引：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_comments_unique
ON work_comments(work_id, comment_key)
WHERE work_id IS NOT NULL AND work_id != '';
```

`comment_key` 初版可用：

```txt
actorName + "::" + commentText.slice(0, 80)
```

如果后续拿到真实评论 ID，再升级。

### 5.3 `revisit_candidates`

用于记录待回访的人，防止重复回访。

```sql
CREATE TABLE IF NOT EXISTS revisit_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  actor_name TEXT,
  actor_profile_url TEXT,
  actor_profile_key TEXT,

  revisit_key TEXT NOT NULL UNIQUE,

  reasons_json TEXT NOT NULL,
  event_ids_json TEXT,
  comments_json TEXT,

  status TEXT NOT NULL DEFAULT 'pending',
  last_reason TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  visited_at TEXT
);
```

状态设计：

| 状态 | 含义 |
|---|---|
| `pending` | 待回访 |
| `succeeded` | 已回访成功 |
| `skipped` | 跳过 |
| `blocked` | 阻塞 |

`revisit_key` 优先级：

```txt
actorProfileKey > normalize(actorProfileUrl) > actorName
```

允许进入回访表的来源只有：

```txt
comment_on_my_work
like_received
```

不允许进入回访表：

```txt
reply_to_my_comment
unknown
```

---

## 6. Repository 层计划

新增文件：

```txt
src/db/work-repository.mjs
src/db/work-comment-repository.mjs
src/db/revisit-repository.mjs
```

### 6.1 `work-repository.mjs`

需要函数：

```js
export function upsertWorkContext(db, workContext) {}
export function findWorkByThumbnailKey(db, thumbnailKey) {}
export function findWorkByModalId(db, modalId) {}
export function findWorkByWorkId(db, workId) {}
export function listRecentlySeenWorks(db, limit = 20) {}
```

`upsertWorkContext` 要求：

1. 有 `workId` 时优先以 `workId` 去重。
2. 没有 `workId` 但有 `modalId` 时以 `modalId` 去重。
3. 没有前两者但有 `thumbnailKey` 时以 `thumbnailKey` 去重。
4. 已存在则更新：`work_title / work_url / author_* / raw_context_json / last_seen_at`。
5. 不存在则插入。

### 6.2 `work-comment-repository.mjs`

需要函数：

```js
export function upsertWorkComment(db, comment) {}
export function listPendingCommentsGroupedByWork(db, options = {}) {}
export function markCommentReplyPrepared(db, commentId, replyText, reason) {}
export function markCommentReplied(db, commentId) {}
export function markCommentSentUnverified(db, commentId, reason) {}
export function markCommentBlocked(db, commentId, reason) {}
export function markCommentSkipped(db, commentId, reason) {}
```

`upsertWorkComment` 要求：

1. 根据 `work_id + comment_key` 去重。
2. 已存在则更新 `last_seen_at`、`actor_profile_url`、`raw_comment_json`。
3. 如果已是 `succeeded`，不能重置成 `pending`。
4. 如果已是 `prepared`，不要覆盖已有 `reply_text`，除非显式传 `force`。

### 6.3 `revisit-repository.mjs`

需要函数：

```js
export function getRevisitKey(candidate) {}
export function upsertRevisitCandidate(db, candidate) {}
export function listPendingRevisitCandidates(db, options = {}) {}
export function markRevisitDone(db, candidateId) {}
export function markRevisitSkipped(db, candidateId, reason) {}
export function markRevisitBlocked(db, candidateId, reason) {}
```

`upsertRevisitCandidate` 要求：

1. 只允许 reason 为 `comment_on_my_work` 或 `like_received`。
2. 同一 `revisit_key` 只保留一条。
3. 新 reason 合并进 `reasons_json`。
4. 新 eventId 合并进 `event_ids_json`。
5. 新 comment 合并进 `comments_json`。
6. 已经 `succeeded` 的候选默认不重新变成 `pending`。

---

## 7. 通知分类规则

新增或保留：

```txt
src/domain/notification-action-router.mjs
```

核心函数：

```js
export function classifyNotificationAction(rawText) {}
```

返回：

```js
{
  notificationAction: 'comment_on_my_work' | 'like_received' | 'reply_to_my_comment' | 'unknown',
  eventType: 'comment' | 'like' | 'unknown',
  nextAction: 'collect_work_comments' | 'collect_revisit' | 'notify_owner',
  clickTarget: 'thumbnail' | 'avatar' | null,
  reason: '...'
}
```

分类规则：

| rawText 包含 | notificationAction | eventType | nextAction | 说明 |
|---|---|---|---|---|
| `评论了你的作品` | `comment_on_my_work` | `comment` | `collect_work_comments` | 进入作品 modal 采集评论 |
| `回复了你的评论` | `reply_to_my_comment` | `comment` | `notify_owner` | 不回复、不回访 |
| `赞了你的作品` | `like_received` | `like` | `collect_revisit` | 加入回访候选 |
| `赞了你的视频` | `like_received` | `like` | `collect_revisit` | 加入回访候选 |
| `点赞了你的作品` | `like_received` | `like` | `collect_revisit` | 加入回访候选 |
| `赞了你的评论` | `like_received` | `like` | `collect_revisit` | 加入回访候选 |
| 其他 | `unknown` | `unknown` | `notify_owner` | 提醒主人 |

---

## 8. 通知页扫描阶段详细流程

### 8.1 初始化

启动后初始化：

```js
const seenNotifications = new Set();
const visitedThumbnailKeys = new Set(); // 本轮缓存；最终以 works 表为准
const runStats = {
  notificationsSeen: 0,
  commentsCollected: 0,
  worksCollected: 0,
  revisitCandidatesCollected: 0,
};
```

如果没有 `--no-revisit`，启用回访收集。

### 8.2 打开通知页

```txt
ensureNotificationPageReady(page)
openNotificationPanel(page)
waitForNotificationPanelStable(page)
moveMouseIntoPanel(page, panelBox)
```

### 8.3 滚动读取通知

伪代码：

```js
for (let round = 0; round < maxScrollRounds; round++) {
  const batch = await extractVisibleNotifications(page);

  for (const notification of batch.notifications) {
    const event = upsertNotificationEvent(db, notification);
    notification.eventId = event.id;

    const action = classifyNotificationAction(notification.rawText || notification.text || '');

    if (action.notificationAction === 'comment_on_my_work') {
      await handleCommentNotificationCollection(page, notification, db, options);
      await returnToNotificationPanel(page);
      continue;
    }

    if (action.notificationAction === 'like_received') {
      if (!options.noRevisit) {
        upsertRevisitCandidate(db, {
          actorName: notification.actorName || notification.username,
          actorProfileUrl: notification.actorProfileUrl,
          actorProfileKey: notification.actorProfileKey,
          eventId: notification.eventId,
          reason: 'like_received',
          rawText: notification.rawText,
        });
      }
      continue;
    }

    if (action.notificationAction === 'reply_to_my_comment') {
      recordSkipAction(db, event.id, 'reply_to_my_comment_requires_owner_review');
      continue;
    }

    recordSkipAction(db, event.id, 'unknown_notification_requires_owner_review');
  }

  await scrollPanelDown(page);
}
```

---

## 9. 评论通知采集流程

函数建议：

```js
async function handleCommentNotificationCollection(page, notification, db, options) {}
```

流程：

```txt
1. 如果没有 --no-revisit，把评论人 upsert 到 revisit_candidates，reason=comment_on_my_work。
2. 从通知卡片提取 thumbnailKey。
3. 查 works 表：findWorkByThumbnailKey(thumbnailKey)。
4. 如果已存在：
   - 不再点开 modal。
   - 只记录该通知已经关联到已有作品。
   - 返回通知页继续扫描。
5. 如果不存在：
   - 点击当前通知对应的作品缩略图。
   - 等待作品 modal。
   - extractWorkModalContext。
   - upsert works。
   - 滚动评论区，收集所有需要回复的评论。
   - upsert work_comments。
```

### 9.1 `thumbnailKey` 设计

建议新增函数：

```js
extractNotificationThumbnailInfo(notificationCard)
```

返回：

```js
{
  thumbnailKey,
  thumbnailSrc,
  thumbnailAlt,
  cardTextPreview
}
```

`thumbnailKey` 优先级：

```txt
1. 缩略图 src 的稳定部分
2. 缩略图 alt
3. 图片父级特征 + 通知 action 文本
4. notificationItemKey 兜底
```

注意：`notificationItemKey` 是通知级别，不一定代表作品。只适合作兜底。

### 9.2 采集作品信息

从 modal 中提取：

```js
{
  currentUrl,
  modalId,
  workId,
  workUrl,
  workType,
  workTitle,
  authorName,
  authorProfileUrl,
  authorProfileKey
}
```

入库到 `works`。

### 9.3 采集待回复评论

从 `.comment-mainContent` 滚动采集 `.comment-item-info-wrap`。

采集结构：

```js
{
  workId,
  workUrl,
  modalId,
  actorName,
  actorProfileUrl,
  actorProfileKey,
  commentText,
  eventTimeText,
  commentKey,
  sourceEventId,
  sourceNotificationKey,
  rawCommentJson
}
```

入库到 `work_comments`。

先不要在这个阶段回复，只采集。

---

## 10. 回复生成阶段

通知页扫描完成后执行。

### 10.1 查询待回复评论

```sql
SELECT * FROM work_comments
WHERE reply_status = 'pending'
ORDER BY first_seen_at ASC;
```

按作品分组。

### 10.2 模板模式

默认使用：

```js
generateReplyText(comment.comment_text)
```

生成后：

```txt
reply_status = prepared
reply_text = xxx
reply_reason = template:xxx
```

### 10.3 AI 模式

当开启：

```bash
--ai-reply
```

或：

```bash
--reply-mode ai
```

按作品批量请求模型。

输入：

```json
{
  "work": {
    "workId": "...",
    "workUrl": "...",
    "workTitle": "..."
  },
  "comments": [
    {
      "commentId": 1,
      "commentKey": "张三::支持支持",
      "actorName": "张三",
      "commentText": "支持支持",
      "eventTimeText": "12:30"
    }
  ],
  "rules": {
    "tone": "自然、简短、像真人",
    "maxLength": 40,
    "avoid": ["不要说自己是AI", "不要过度营销", "不要重复模板"]
  }
}
```

输出必须是 JSON：

```json
{
  "replies": [
    {
      "commentId": 1,
      "commentKey": "张三::支持支持",
      "action": "reply",
      "replyText": "感谢支持，一起交流。",
      "reason": "正向评论"
    }
  ]
}
```

解析失败、超时、返回不合法时，fallback 到模板模式。

---

## 11. 评论回复执行阶段

查询：

```sql
SELECT * FROM work_comments
WHERE reply_status = 'prepared'
ORDER BY first_seen_at ASC;
```

按作品分组。

流程：

```txt
1. 打开该作品 workUrl。
2. 等待 modal。
3. 对该作品下 prepared 评论逐条处理。
4. 根据 actorName + commentText 定位评论。
5. 点击该评论下 span 文本“回复”。
6. 等待 input[type=text]。
7. 填入 replyText。
8. preview：只填入不发送。
9. execute：点击发送或按 Enter。
10. 验证评论区出现 replyText 或 replyText 前缀。
11. 更新 work_comments.reply_status。
12. 写 actions.reply_comment。
```

状态更新：

| 结果 | work_comments.reply_status | actions.status |
|---|---|---|
| 发送并确认 | `succeeded` | `succeeded` |
| 发送但未确认 | `sent_unverified` | `sent_unverified` |
| 打不开回复框 | `blocked` | `blocked` |
| 内容为空/不适合回复 | `skipped` | `skipped` |
| preview 填入成功 | 保持 `prepared` 或标记 `skipped` | 可不写 actions，或写 `skipped` |

注意：`actions.status` 不允许使用 `preview`、`revisit` 这类非法状态。

---

## 12. 统一回访阶段

只有在通知扫描和评论回复阶段完成后才执行。

如果有：

```bash
--no-revisit
```

则跳过整个阶段。

查询：

```sql
SELECT * FROM revisit_candidates
WHERE status = 'pending'
ORDER BY updated_at ASC;
```

流程：

```txt
1. 打开 actorProfileUrl。
2. 等待用户主页稳定。
3. 找最近作品链接 /video 或 /note。
4. 打开作品。
5. 检测是否已点赞。
6. 未点赞则点击点赞。
7. 更新 revisit_candidates.status。
8. 写 actions.like_work。
```

回访只点赞，不评论。

---

## 13. 页面调试工具

新增通用页面采集命令：

```bash
npm run dev:inspect-page -- --keep-open --label work-modal
```

作用：

```txt
启动浏览器
用户手动操作到目标页面
终端按 Enter
采集当前页面截图、DOM、按钮、链接、输入框、modal、评论候选等信息
保存到 data/debug/page-inspect/<timestamp-label>/
```

输出文件：

```txt
page-info.json
screenshot-full.png
screenshot-viewport.png
dom.html
visible-text.txt
interactables.json
links.json
images.json
inputs.json
buttons.json
modal-candidates.json
comment-candidates.json
storage.json
dom-stats.json
```

限制：

```txt
不回复
不点赞
不改数据库
不采集 cookies
localStorage/sessionStorage 只保存 key 和 valuePreview
```

---

## 14. 旧命令处理建议

当前主流程不再依赖以下命令：

```txt
comments:plan
comments:approve-plan
comments:prepare
comments:execute
comments:reply
comments:verify
comments:resume
likes:plan
likes:reciprocate
visits:plan
visits:discover
visits:review
visits:live-review
```

建议先不物理删除，改成 legacy 或从 README 主流程中移除。

主流程只保留：

```txt
db:init
interactions:live
dev:inspect-page
notify:inspect
history
auth
```

---

## 15. 开发分阶段计划

### 阶段 1：数据库与 repository

目标：所有采集信息可入库、可去重。

任务：

```txt
1. migrations 增加 works / work_comments / revisit_candidates。
2. 新增 work-repository.mjs。
3. 新增 work-comment-repository.mjs。
4. 新增 revisit-repository.mjs。
5. 确保 db:init 后表存在。
```

验收命令：

```bash
npm run db:init
```

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all())"
```

### 阶段 2：通知扫描入库，不执行动作

目标：通知、作品、评论、回访候选都能入库。

命令：

```bash
npm run interactions:live -- --max-notifications 20 --dry-run --keep-open
```

预期：

```txt
interaction_events 有通知
works 有作品
work_comments 有待回复评论
revisit_candidates 有点赞/评论人
```

验收查询：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT COUNT(*) works FROM works\").all()); console.table(db.prepare(\"SELECT COUNT(*) comments FROM work_comments\").all()); console.table(db.prepare(\"SELECT COUNT(*) revisit FROM revisit_candidates\").all())"
```

### 阶段 3：回复生成入库

目标：`work_comments.pending` 变成 `prepared`。

命令：

```bash
npm run interactions:live -- --dry-run --reply-mode template --no-revisit --keep-open
```

或未来拆出命令：

```bash
npm run comments:prepare-live -- --reply-mode template
```

验收查询：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT reply_status,COUNT(*) count FROM work_comments GROUP BY reply_status\").all())"
```

### 阶段 4：preview 回复

目标：打开 modal，定位评论，填入回复，但不发送。

命令：

```bash
npm run interactions:live -- --preview --max-items 1 --keep-open --no-revisit
```

验收：

```txt
浏览器中能看到 input[type=text] 被填入回复内容。
不点击发送。
```

### 阶段 5：execute 回复

目标：真实回复一条评论。

命令：

```bash
npm run interactions:live -- --execute --max-items 1 --keep-open --no-revisit
```

验收：

```txt
页面上出现回复。
work_comments 对应记录为 succeeded 或 sent_unverified。
actions 中有 reply_comment 记录。
```

查询：

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('data/lishangwanglai.db'); console.table(db.prepare(\"SELECT id,actor_name,comment_text,reply_status,reply_text,replied_at FROM work_comments ORDER BY id DESC LIMIT 10\").all()); console.table(db.prepare(\"SELECT action_type,status,target_title,action_text,executed_at FROM actions ORDER BY id DESC LIMIT 10\").all())"
```

### 阶段 6：统一回访

目标：通知页处理完成后统一回访候选用户。

命令：

```bash
npm run interactions:live -- --execute --max-revisits 3 --keep-open
```

如果只测回复不回访：

```bash
npm run interactions:live -- --execute --max-items 1 --keep-open --no-revisit
```

验收：

```txt
通知扫描阶段不会立即打开用户主页。
扫描完成后才开始回访。
同一用户只回访一次。
revisit_candidates 状态更新。
actions 中有 like_work 记录。
```

---

## 16. 运行建议

### 16.1 调试页面 DOM

```bash
npm run dev:inspect-page -- --keep-open --label notify-panel
```

手动打开通知面板后，回到终端按 Enter。

```bash
npm run dev:inspect-page -- --keep-open --label work-modal
```

手动进入作品 modal 后，回到终端按 Enter。

### 16.2 只采集不执行

```bash
npm run interactions:live -- --dry-run --max-notifications 20 --keep-open --no-revisit
```

### 16.3 只测评论填入，不发送

```bash
npm run interactions:live -- --preview --max-items 1 --keep-open --no-revisit
```

### 16.4 真实回复一条，不回访

```bash
npm run interactions:live -- --execute --max-items 1 --keep-open --no-revisit
```

### 16.5 完整跑：回复 + 最后统一回访

```bash
npm run interactions:live -- --execute --max-items 5 --max-revisits 5 --keep-open
```

---

## 17. 注意事项

1. 不再把 `npm test` 作为验收命令。
2. 不要手工补 plan。
3. 不要再使用 `comments:plan` 作为主流程。
4. 不要边扫描通知边回访。
5. 不要只把采集结果存在内存中。
6. 所有通知、作品、评论、回访候选都必须入库。
7. 评论回复必须先从数据库查询 `prepared` 评论，再执行。
8. AI 回复生成必须返回结构化 JSON，解析失败要 fallback 到模板。
9. `actions.status` 只能使用数据库允许的状态，不要写 `preview`、`revisit`。
10. `reply_to_my_comment` 不回复、不回访，只提醒主人。

---

## 18. 本轮最小落地顺序

优先做这四件事：

```txt
1. 数据库新增 works / work_comments / revisit_candidates。
2. interactions:live 第一阶段只采集入库，不急着发送。
3. 从 work_comments 生成 prepared 回复。
4. 执行 prepared 回复一条，跑通 modal 回复。
```

跑通后再做：

```txt
5. AI 批量生成回复。
6. 统一回访点赞。
7. 加固 owner check、重复检测、失败恢复。
```

---

## 19. 最终目标

最终工具应该做到：

```txt
打开通知页
  ↓
自动读取评论和点赞
  ↓
同一个作品只打开一次
  ↓
作品信息、评论信息、回访对象全部入库
  ↓
按作品批量生成回复
  ↓
自动回复评论
  ↓
最后统一回访点赞
  ↓
全程可追踪、可查询、可避免重复
```
