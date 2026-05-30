# comments:reply 开发说明

## 1. 当前链路目标

批量回复抖音创作者评论管理页中已审批的评论。整体流程：

1. 读取 `plan.json`，过滤出 `approved: true` 的 item
2. 按作品分组（`groupApprovedItemsByWork`）
3. 启动一个浏览器，一次进入评论管理页
4. 每个作品只切换一次（`selectWorkByTitle`），不反复切
5. 当前作品下连续处理多条评论（`executeOneItemInCurrentWork`）
6. 执行结果写入 `actions` 表
7. 输出 `reply-result-xxx.json`

入口文件：`src/cli/execute-comment-replies.mjs`

## 2. 分组策略

`groupApprovedItemsByWork`（`execute-comment-replies.mjs:114`）：

**key 优先级**：`workId` > `workUrl` > `workTitle` > `__unknown_work__`

- 先判断 `workId` 非空 → `workId:<value>`
- 否则 `workUrl` → `workUrl:<value>`
- 否则 `workTitle` → `workTitle:<value>`
- 全空 → `__unknown_work__`

**行为**：
- 保持原始作品组顺序（插入顺序）
- 保持组内评论顺序
- 每个 group 对象保留字段：`key`, `workTitle`, `workId`, `workUrl`, `items`
- 空输入返回空数组

```javascript
// group 结构
{
  key: 'workId:w123',
  workTitle: '作品标题',
  workId: 'w123',
  workUrl: 'https://...',
  items: [{ eventId, actorName, commentText, replyText, ... }]
}
```

## 3. maxItems 语义

`run.processed` 表示本轮真实尝试处理数量（dry-run 和 execute 都会增加）：

| 阶段 | 是否消耗 processed |
|---|---|
| `validateItem` 失败 | 否 |
| `hasSucceededAction` 跳过 | 否 |
| 达到 `run.options.maxItems` | 否（前置判断，直接返回） |
| `process` 递增 | 是（干/湿运行统一） |

- `run.executed` 只表示**真实发送且校验成功**的数量
- `run.succeeded` = `run.executed`
- `run.skipped` 包含：未审批、重复、maxItems 截断
- `run.blocked` 包含：作品选择失败、定位失败、发送失败

## 4. 评论定位策略

`openReplyBoxForComment(page, item)`（`comment-page.mjs:596`）：

- **有 `actorName`**：必须 `actorName + commentText` 同时匹配，不允许 fallback 到纯 `commentText`
- **没有 `actorName`**：允许退化为纯 `commentText` 定位
- 匹配不唯一时返回 `COMMENT_MATCH_NOT_UNIQUE`，不冒险点击
- 匹配到 `actorName` 但时间偏移时阻塞 `RELATIVE_TIME_CONFLICT`
- 查找策略：
  1. 优先 `[class*="comment-content"]` 匹配文本
  2. 向上找 `[class*="operations"]` 中的回复按钮
  3. 找不到再按"回复"文本 fallback 全量扫描
  4. 未找到时滚动重试，最多 30 轮

## 5. 发送后校验策略

`verifyReplyVisible(page, item, replyText)`（`comment-page.mjs:607`）：

`sendReply` 成功后不直接记 `succeeded`，必须在目标评论容器下确认 `replyText` 出现：

- **有 `actorName`**：同一 `[class*="comment-item"]` 容器需包含 `actorName + commentText + replyText`
- **没有 `actorName`**：同一容器需包含 `commentText + replyText`
- 校验成功（`result.ok === true`）后：
  - `recordAction(db, ..., 'succeeded')`
  - `updateEventStatus(db, eventId, 'succeeded')`
  - `run.executed++`
  - `run.succeeded++`
- 校验失败（轮询超时）：
  - `status = 'sent_unverified'`
  - 不调用 `updateEventStatus` 为 `succeeded`
  - 不 `run.executed++`
  - 采集 evidence，step 为 `verify-reply`

校验轮询：默认 5 秒，每 500ms 重试一次，超时后返回 `COMMENT_SEND_UNCONFIRMED`。

## 6. 失败状态

| 状态 | 含义 | 是否消耗 processed | 是否采集 evidence |
|---|---|---|---|
| `succeeded` | 回复发送并验证成功 | 是 | 否 |
| `dry_run_ok` | dry-run 定位成功 | 是 | 否 |
| `skipped` | 未审批/重复/maxItems | 否 | 否 |
| `blocked` | 动作未完成或前置条件失败 | 是 | 是 |
| `sent_unverified` | 发送动作完成，但页面未确认 | 是 | 是 |

**`sent_unverified` vs `blocked` 的区别**：

- `blocked`：动作（定位/发送）没完成，或者前置条件（作品选择/导航）失败
- `sent_unverified`：`sendReply` 调用成功，但 `verifyReplyVisible` 未能在目标容器下找到回复文本。此时点击发送可能成功、但页面状态未达到预期，需要人工确认

## 7. evidence 机制

每条失败 item 保存现场证据，用于排查页面结构变化或定位失败原因。

### 目录结构

```
data/runs/<runId>/evidence/<step>-<随机后缀>/
├── screenshot.png        # 全页截图
├── page.html             # 净化 DOM（去 script/style/comment）
├── page-text.txt         # 可见文本（前 10000 字）
├── page-info.json        # URL + title + timestamp
└── failure.json          # 元信息：eventId, actorName, step, code, message, item meta
```

### 采集步骤

| step | 触发条件 | 频率 |
|---|---|---|
| `select-work` | 作品选择/校验失败 | 每 group 一次，组内 item 共用 |
| `dry-run-locate` | dry-run 定位失败 | 每 item |
| `open-reply-box` | 打开回复框失败 | 每 item |
| `execute-reply` | `sendReply` 失败 | 每 item |
| `verify-reply` | 发送后校验失败 | 每 item |
| `execute-error` | 整体 catch 异常 | 全局一次 |

### 不采集 evidence 的场景

- `succeeded`：成功不需要
- `duplicate`/`skipped`：未操作页面
- `validateItem` 失败：未进入页面操作
- `maxItems` 截断：未操作页面

### captureItemEvidence 行为

- 调用 `captureEvidence`（`src/browser/failure-evidence.mjs`），传入 item 元数据作为 `extra`
- 将 `evidenceDir` 推入 `run.evidenceDirectories`
- 返回 `{ evidenceDir, screenshotPath, evidenceJson }`
- 返回的 `screenshotPath` 和 `evidenceJson` 会写入 `recordAction` 的对应字段
- `captureEvidence` 自身异常时只 `console.warn`，不阻塞主流程

## 8. result 文件结构

输出文件：`data/plans/reply-result-<timestamp>.json`

```json
{
  "plan": "data/plans/xxx.json",
  "mode": "dry-run | execute",
  "results": [
    {
      "eventId": "evt_001",
      "actorName": "张三",
      "status": "succeeded | sent_unverified | blocked | skipped",
      "reason": "",
      "step": "",
      "code": "",
      "evidenceDir": "data/runs/.../evidence/verify-reply-xxx/" ,
      "screenshotPath": "data/runs/.../evidence/verify-reply-xxx/screenshot.png"
    }
  ],
  "summary": {
    "total": 10,
    "workGroups": 3,
    "processed": 5,
    "succeeded": 3,
    "sentUnverified": 1,
    "skipped": 1,
    "blocked": 1,
    "evidenceCount": 3,
    "maxItems": 5
  }
}
```

`screenshotPath` 和 `evidenceDir` 仅失败时存在，成功/skip 时为 `undefined`。

## 9. 当前限制

- **选择器依赖页面结构**：`[class*="comment-content"]`、`[class*="comment-item"]` 等 selector 依赖抖音创作者平台的 DOM 结构，平台改版可能导致定位失败。需持续用真实页面校准。
- **actorName/commentText 截断**：平台可能截断或格式化用户名/评论内容，导致精确匹配失效。
- **verifyReplyVisible 范围**：只能确认页面出现回复文本，不能保证抖音服务端最终状态。极少数场景下页面渲染和实际落库可能不一致。
- **evidence 覆盖范围有限**：`validateItem`、`duplicate`、`maxItems` 等跳过场景不采集证据，这些场景下排查需依赖日志。
- **单页评论数量**：`scrollToLoadAllComments` 的滚动策略在评论量极大时可能无法加载全部，影响全量扫描。

## 10. 开发者验证命令

```bash
# 运行全部测试
npm test

# dry-run 验证定位（不实际发送）
npm run comments:reply -- --plan data/plans/xxx.json --dry-run --max-items 2 --keep-open

# execute 实际发送
npm run comments:reply -- --plan data/plans/xxx.json --execute --max-items 2 --keep-open

# 查看 evidence
ls data/runs/<runId>/evidence/

# 生成回复计划
npm run comments:plan -- --max-items 20

# 指定待处理状态（默认 new）
npm run comments:plan -- --status new

# 允许包含缺 workTitle 的事件
npm run comments:plan -- --include-missing-work-title

# 指定输出路径
npm run comments:plan -- --output data/plans/my-plan.json
```

## 11. comments:plan

入口文件：`src/cli/plan-comment-replies.mjs`

### 链路位置

```
interaction_events → comments:plan → plan.json → comments:reply → reply-result.json
```

`comments:plan` 读取数据库中状态为 `new`（可配置）的评论事件，生成 `plan.json`，供 `comments:reply` 消费。

### 筛选逻辑

1. 只读 `event_type = 'comment'` 的事件
2. 默认只读 `status = 'new'`（通过 `--status` 可配置）
3. 排除已成功回复的事件（`actions` 表中存在 `action_type = 'reply_comment'` 且 `status = 'succeeded'`）
4. 排除没有 `comment_text` 的事件
5. 默认排除没有 `my_work_title` 的事件（`comments:reply` 选择作品依赖 `workTitle`）
6. 传 `--include-missing-work-title` 可允许缺标题的事件进入计划，但 `warnings` 中注明

### 模板回复

`src/domain/reply-template.mjs`：

| 条件 | replyText | reason |
|---|---|---|
| 含疑问词（怎么/如何/为什么/啥/什么/?/？） | 这个问题挺关键，后面我可以单独展开讲一下。 | template:question |
| 含表扬词（支持/不错/厉害/学到了/有用/赞/干货等） | 感谢支持，一起交流。 | template:praise |
| 文本极短（<=3 字）或主要为 emoji | 感谢支持。 | template:short |
| 默认 | 感谢评论，一起交流。 | template:default |

### plan 文件结构

```json
{
  "planId": "comment-reply-plan-2026-05-30_21-30-00",
  "type": "comment_reply",
  "createdAt": "2026-05-30T21:30:00.000Z",
  "source": "interaction_events",
  "items": [
    {
      "eventId": 42,
      "approved": false,
      "workId": "w123",
      "workTitle": "我的视频作品",
      "workUrl": "https://...",
      "actorName": "张三",
      "actorProfileUrl": "https://...",
      "commentText": "写得不错",
      "eventTimeText": "05-30 14:00",
      "replyText": "感谢支持，一起交流。",
      "reason": "template:praise"
    }
  ],
  "summary": {
    "totalCandidates": 10,
    "planned": 8,
    "skipped": 2,
    "maxItems": 20
  }
}
```

关键约束：
- `approved` 默认 **false**，必须人工审核后才设为 `true`
- `replyText` 是模板建议值，人工可修改
- `comments:reply` 只处理 `approved: true` 的 item

### CLI 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--max-items N` | 20 | 最多生成计划条数 |
| `--status` | new | 事件状态过滤 |
| `--output` | data/plans/<planId>.json | 自定义输出路径 |
| `--include-missing-work-title` | 无 | 允许缺 workTitle 的事件进入计划 |

### 常用命令区别

| 命令 | 作用 | 是否打开浏览器 |
|---|---|---|
| `comments:plan` | 生成评论回复计划 | 不打开浏览器 |
| `comments:approve-plan` | 审批 plan（修改 `approved`） | 不打开浏览器 |
| `comments:reply` | 执行评论回复 | 打开评论管理页 |
| `visits:*` | 回访流程 | 可能打开用户主页/作品 |
| `likes:*` | 点赞/回赞流程 | 可能打开用户主页/作品 |
