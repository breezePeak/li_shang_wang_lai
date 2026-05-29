# 礼尚往来 Skill：当前剩余问题修复计划

> 文档用途：基于当前 `main` 分支最新代码复查结果，指导下一轮代码修改与验收。  
> 当前目标：不新增业务功能，集中修复 Agent 稳定调用、安全执行和可验收性问题。  
> 适用仓库：`breezePeak/li_shang_wang_lai`

---

## 1. 当前总体判断

项目已经从“执行引擎搭建阶段”进入“Skill MVP 稳定化阶段”。

当前完成度判断：

| 模块 | 当前完成度 | 判断 |
|---|---:|---|
| 基础执行引擎 | 80% | 浏览器、SQLite、扫描、动作记录框架已具备 |
| 评论回复 Skill MVP | 70% | 审批链路基本完整，但唯一定位仍需加强 |
| Agent 结构化调用能力 | 50% | `--json` 输出契约尚未真正稳定 |
| 点赞候选预览 | 45% | 已有页面探索逻辑，但 Skill 输出和文案未收口 |
| 正式可交付程度 | 60% | 尚不建议开放真实账号自动发送 |

当前可以继续验证的能力：

```text
登录态复用
评论扫描与入库
待处理评论摘要
创建评论回复候选
首次审批
dry-run 定位目标评论
二次发送确认
单条评论发送主路径（仅测试账号、人工观察下验证）
```

当前不应开放的能力：

```text
真实账号无人值守自动评论
任何真实好友回赞
批量互动执行
```

---

## 2. 最新一轮已经完成的内容

### 2.1 评论回复目标文本定位已修正

此前执行器错误地使用“准备发送的回复文本”去定位用户原评论，存在定位失败或误发送风险。

当前代码已经调整为：

```text
读取 action 及原始 event
  ↓
切换目标作品
  ↓
使用 commentText 定位评论回复框
  ↓
dry-run 只定位，不发送
  ↓
execute 时将 actionText 写入已打开的回复框并发送
```

相关文件：

```text
src/cli/execute-comment-reply.mjs
src/db/action-repository.mjs
```

### 2.2 发送前二次确认已代码化

当前已新增命令：

```bash
npm run actions:confirm-execute -- --action-id <id> --json
```

状态链已调整为：

```text
prepared
  → approved
  → dry_run_ok
  → execute_confirmed
  → succeeded
```

真实发送现在要求 action 状态必须为：

```text
execute_confirmed
```

否则禁止执行。

相关文件：

```text
package.json
src/cli/confirm-execute.mjs
src/cli/execute-comment-reply.mjs
src/db/action-repository.mjs
src/db/migrations.mjs
SKILL.md
```

### 2.3 数据库状态与防重复能力已加强

当前已完成：

- `actions.status` 支持 `execute_confirmed`；
- 旧数据库支持重建迁移；
- 同一评论只能存在一个活跃回复 action 的唯一索引；
- 真实发送成功后同步更新事件状态。

当前评论回复流程骨架可视为：

```text
scan
  → pending
  → prepare
  → approve
  → dry-run
  → confirm-execute
  → execute
```

---

## 3. 本轮必须继续修复的问题

以下问题按照优先级排序。**P0 未完成前，不应把 Skill 交给 Agent 执行真实动作。**

---

# P0-1：彻底完成纯净 `--json` 输出契约

## 问题说明

项目已经定义了 JSON 输出原则：

```text
启用 --json 时：
stdout 只能输出一次最终 JSON；
stderr 输出调试日志、迁移日志、页面日志和进度信息；
成功和失败都必须在 stdout 返回结构化 JSON；
失败通过非 0 exitCode 标识。
```

但当前多个模块仍直接向 stdout 输出普通日志，导致 Agent 无法直接执行：

```js
JSON.parse(stdout)
```

仍会污染 stdout 的文件包括：

```text
src/browser/run-context.mjs
src/adapters/comment-page.mjs
src/cli/scan-interactions.mjs
src/cli/plan-likes.mjs
```

典型污染输出：

```text
[run] 运行 ID: ...
[comment-page] 导航到评论管理页...
[scan] 发现 3 条评论
{"ok":true,"command":"interactions:scan",...}
[run] 摘要已保存: ...
```

## 修改目标

所有 Skill 主流程命令在 `--json` 模式下必须满足：

```bash
node -e "JSON.parse(require('fs').readFileSync(0, 'utf8'))"
```

可直接解析 stdout。

## 修改建议

### 1. 新增统一日志工具

建议新增：

```text
src/utils/cli-logger.mjs
```

参考接口：

```js
export function createCliLogger({ json = false } = {}) {
  return {
    info: (...args) => json ? console.error(...args) : console.log(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args),
  };
}
```

### 2. 给运行上下文传入 JSON 模式

修改：

```text
src/browser/run-context.mjs
```

将以下输出在 `run.options.json === true` 时改为 stderr：

```text
运行 ID
命令
输出目录
执行参数
摘要保存路径
保留浏览器提示
```

### 3. 页面 adapter 禁止固定写 stdout

修改：

```text
src/adapters/comment-page.mjs
```

不要在 adapter 内部直接执行无条件：

```js
console.log(...)
```

可选方案：

- 注入 logger；
- 或统一将 adapter 调试日志改为 `console.error()`；
- 或通过 `debug/json` 上下文控制输出。

### 4. 扫描命令失败路径必须返回 JSON

修改：

```text
src/cli/scan-interactions.mjs
```

当前 phase 失败时不能只 `return`，应在 `--json` 模式下输出：

```json
{
  "ok": false,
  "command": "interactions:scan",
  "code": "COMMENT_REPLY_BUTTON_NOT_FOUND",
  "message": "具体失败原因",
  "recoverable": true,
  "data": {
    "step": "comment-scan"
  }
}
```

## 验收标准

必须通过以下测试：

```bash
npm run interactions:scan -- --type comment --json > /tmp/scan.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/scan.json','utf8'))"

npm run comments:prepare -- --event-id <id> --reply-text "测试" --json > /tmp/prepare.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/prepare.json','utf8'))"

npm run actions:approve -- --action-id <id> --json > /tmp/approve.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/approve.json','utf8'))"

npm run comments:execute -- --action-id <id> --dry-run --json > /tmp/dryrun.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/dryrun.json','utf8'))"
```

同时补充严格测试：

```js
expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
```

禁止测试通过“只解析 stdout 最后一行”规避日志污染。

---

# P0-2：实现 `likes:plan --json`，并删除真实点赞执行引导

## 问题说明

`SKILL.md` 已经把以下命令定义为回访候选预览流程：

```bash
npm run likes:plan -- --json
```

但当前 `src/cli/plan-likes.mjs`：

- 没有实现 `--json` 结果输出；
- 仍然大量输出人类可读日志；
- 仍然提示用户编辑计划并执行真实点赞：

```bash
npm run likes:reciprocate -- --plan <文件> --execute --max-items 1
```

这与 MVP 安全边界冲突：当前真实回访点赞必须禁用，Skill 只能预览候选。

## 修改目标

`likes:plan --json` 应成为 Agent 可读取的只读候选报告命令，且不得输出任何引导真实点赞执行的内容。

## 建议输出结构

```json
{
  "ok": true,
  "command": "likes:plan",
  "data": {
    "candidates": [
      {
        "eventId": 1,
        "actorName": "昵称",
        "relation": "friend",
        "actorProfileUrl": "https://...",
        "targetVideoUrl": "https://...",
        "targetVideoTitle": "标题",
        "alreadyLiked": false,
        "status": "planned",
        "previewOnly": true,
        "executeAllowed": false,
        "reason": ""
      }
    ],
    "blockedItems": [],
    "skippedItems": []
  },
  "summary": {
    "candidateCount": 1,
    "blockedCount": 0,
    "skippedCount": 0
  },
  "warnings": [
    "真实回访点赞在 MVP 阶段禁用，本命令仅输出预览候选。"
  ]
}
```

## 具体任务

- [ ] `plan-likes.mjs` 引入 `printJsonResult` / `printJsonError`；
- [ ] 每个候选对象增加：

```js
previewOnly: true,
executeAllowed: false
```

- [ ] `--json` 模式输出单个合法 JSON；
- [ ] 普通文本模式删除真实执行命令引导；
- [ ] 替换提示为：

```text
当前仅支持候选预览，真实回访点赞在 MVP 阶段禁用。
```

- [ ] 为 `likes:plan --json` 增加测试。

## 验收标准

执行：

```bash
npm run likes:plan -- --json
```

输出中的每个 candidate 必须满足：

```json
{
  "previewOnly": true,
  "executeAllowed": false
}
```

并且输出内容中不得出现：

```text
likes:reciprocate --execute
```

---

# P1-1：`actions:pending` 返回 blocked 明细，而不是只返回数量

## 问题说明

当前 `report-pending.mjs` 会排除所有 `blocked` 事件，只保留：

```json
{
  "blocked": 3
}
```

Agent 因此无法报告：

- 哪一条评论失败；
- 是什么原因失败；
- 对应哪个 action；
- 是否可以重试；
- 是否存在证据文件。

## 修改目标

保留正常待办列表，同时新增完整的阻断项明细列表。

## 建议输出结构

```json
{
  "ok": true,
  "command": "actions:pending",
  "data": {
    "comments": [],
    "likes": [],
    "blockedItems": [
      {
        "eventId": 3,
        "eventType": "comment",
        "actorName": "昵称",
        "myWorkTitle": "作品标题",
        "commentText": "原评论文本",
        "eventStatus": "blocked",
        "latestActionStatus": "blocked",
        "reason": "滚动查找后未找到目标评论",
        "evidence": null
      }
    ]
  },
  "summary": {
    "pendingComments": 0,
    "pendingLikes": 0,
    "blocked": 1
  }
}
```

## 具体任务

- [ ] 查询 `interaction_events.status = 'blocked'` 的事件详情；
- [ ] 关联最近一条 `actions` 的：

```text
status
reason
evidence_json
screenshot_path
```

- [ ] 将 `blockedItems` 输出到 JSON；
- [ ] 非 JSON 模式下显示阻断详情；
- [ ] `openReplyBox()` 失败路径也同步更新 `interaction_events.status = 'blocked'`，保持一致。

## 验收标准

当某条评论定位失败后：

```bash
npm run actions:pending -- --json
```

必须能读取该条失败记录及其原因，而不是仅看到阻断数量。

---

# P1-2：评论定位必须支持唯一匹配，禁止只靠评论文本发送

## 问题说明

当前 `openReplyBox(page, commentText)` 已经能用原评论文本定位，但仍然采用：

```js
text.includes(target)
```

如果同一个作品下存在两个用户评论内容相同，例如：

```text
用户甲：求教程
用户乙：求教程
```

仅靠 `commentText` 无法保证回复到目标用户。

## 修改目标

将评论定位从“文本命中”升级为“多条件唯一命中”，无法唯一确认时必须阻断。

## 修改建议

### 1. 扩展调用参数

将：

```js
openReplyBox(page, commentText)
```

改为：

```js
openReplyBox(page, {
  commentText,
  actorName,
  eventTimeText
})
```

执行器调用：

```js
const openResult = await openReplyBox(page, {
  commentText: action.commentText,
  actorName: action.actorName,
  eventTimeText: action.eventTimeText
});
```

### 2. repository 返回时间字段

修改：

```text
src/db/action-repository.mjs
```

在 `getActionWithEvent()` 中追加：

```sql
e.event_time_text as eventTimeText
```

### 3. 唯一匹配规则

页面候选项需要同时尽量满足：

```text
评论文本匹配
用户昵称匹配
时间文本匹配（页面存在且可稳定取得时）
```

判断规则建议如下：

| 匹配结果 | 行为 |
|---|---|
| 仅 1 条满足评论文本 + 用户昵称 | 可定位 |
| 多条满足相同组合 | blocked |
| 只有评论文本匹配，无法匹配昵称 | blocked |
| 完全无匹配 | blocked |

### 4. 输出阻断原因

例如：

```json
{
  "ok": false,
  "code": "COMMENT_MATCH_NOT_UNIQUE",
  "message": "发现多条相同评论内容，无法唯一确认目标用户，已阻断发送。",
  "recoverable": true
}
```

## 验收标准

构造同作品下两条相同文本评论：

```text
用户甲：求教程
用户乙：求教程
```

执行回复用户乙时，必须：

- 精确定位用户乙；或
- 无法确认时返回 blocked；

绝不能默认点击第一条匹配评论。

---

# P1-3：重写评论工作流测试，使其真正验证安全契约

## 问题说明

当前新增了：

```text
tests/unit/comment-workflow.test.mjs
```

但测试可靠性不足：

1. 测试直接依赖本地已有数据库中的 `eventId = 2`；
2. 事件不存在时，错误 JSON 也可能被当作“测试已跑”；
3. 测试通过解析 stdout 最后一行来容忍日志污染：

```js
JSON.parse(stdout.trim().split('\n').pop())
```

这与纯净 JSON 输出契约相冲突。

## 修改目标

测试必须独立、可重复，并且能够真正阻断回归。

## 具体任务

- [ ] 测试使用独立临时数据库，不依赖开发者本地数据；
- [ ] 在测试 setup 中主动插入评论事件；
- [ ] 每个关键步骤都验证明确结果，而不是只判断“不为空”；
- [ ] 输出测试严格使用：

```js
JSON.parse(result.stdout.trim())
```

- [ ] 增加以下覆盖：

```text
prepare 创建成功
重复 prepare 被阻断
approve 只能处理 prepared
dry-run 不接受未审批 action
confirm-execute 不接受未 dry-run action
execute 不接受未 execute_confirmed action
成功发送后 event 状态更新为 succeeded
blockedItems 可以查询失败详情
likes:plan --json 返回 executeAllowed:false
--json stdout 不包含任何日志
```

---

## 4. P2：同步 README 当前进度

## 问题说明

README 仍显示：

```text
待处理摘要：待新增
评论候选回复：待 Skill 化
```

但目前已经存在：

```text
actions:pending
comments:prepare
actions:approve
actions:confirm-execute
comments:execute
```

## 修改建议

将能力状态表改为：

| 功能 | 状态 | 说明 |
|---|---|---|
| 待处理摘要 | 初版可用 | `actions:pending` 支持结构化输出，待补 blocked 明细 |
| 评论候选回复 | 初版可用 | 通过 `comments:prepare` 创建单条候选 |
| 评论审批闭环 | 开发验证中 | 已具备 `approve → dry-run → confirm-execute → execute` |
| JSON Agent 契约 | 修复中 | 部分浏览器流程仍存在 stdout 日志污染 |
| 好友回访候选 | 开发验证中 | 待补 `likes:plan --json`，仅预览 |
| 真实回访点赞 | 默认禁用 | MVP 不允许真实执行 |

---

## 5. 本轮建议修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/utils/cli-logger.mjs` | 新增统一 JSON 模式日志分流工具 |
| `src/browser/run-context.mjs` | JSON 模式日志改到 stderr |
| `src/adapters/comment-page.mjs` | 日志分流；支持昵称/时间联合定位 |
| `src/cli/scan-interactions.mjs` | 纯净 JSON 输出；失败路径结构化返回 |
| `src/cli/plan-likes.mjs` | 新增 `--json`；删除真实点赞引导 |
| `src/cli/report-pending.mjs` | 输出 `blockedItems` 详情 |
| `src/cli/execute-comment-reply.mjs` | 传入联合定位参数；补 openReplyBox 失败时 event 状态同步 |
| `src/db/action-repository.mjs` | 查询关联事件时返回时间字段 |
| `src/domain/result-codes.mjs` | 增加 `COMMENT_MATCH_NOT_UNIQUE` 等错误码 |
| `tests/unit/comment-workflow.test.mjs` | 使用临时 DB，严格验证工作流 |
| `tests/unit/json-output.test.mjs` | 新增纯净 JSON 输出测试 |
| `tests/unit/like-plan-safety.test.mjs` | 新增点赞预览安全测试 |
| `README.md` | 同步功能进展与限制 |
| `SKILL.md` | 在 likes JSON 与 blocked 明细完成后校对最终调用说明 |

---

## 6. 建议提交顺序

### Commit 1：修复纯净 JSON 契约

```text
fix(cli): enforce clean json stdout for agent commands
```

范围：

```text
src/utils/cli-logger.mjs
src/browser/run-context.mjs
src/adapters/comment-page.mjs
src/cli/scan-interactions.mjs
tests/unit/json-output.test.mjs
```

### Commit 2：收口点赞候选预览

```text
feat(likes): expose preview-only json candidate report
```

范围：

```text
src/cli/plan-likes.mjs
tests/unit/like-plan-safety.test.mjs
SKILL.md
```

### Commit 3：补充阻断明细报告

```text
feat(actions): include blocked item details in pending report
```

范围：

```text
src/cli/report-pending.mjs
src/cli/execute-comment-reply.mjs
tests/unit/comment-workflow.test.mjs
```

### Commit 4：加强评论目标唯一定位

```text
fix(comments): block ambiguous reply target matching
```

范围：

```text
src/adapters/comment-page.mjs
src/db/action-repository.mjs
src/domain/result-codes.mjs
tests/unit/comment-workflow.test.mjs
```

### Commit 5：同步文档与最终验收

```text
docs: align skill and readme with stabilized mvp workflow
```

范围：

```text
README.md
SKILL.md
docs/
```

---

## 7. 当前阶段完成标准

当以下事项全部完成后，可认为“评论回复 Skill MVP”进入测试试用状态：

- [x] 真实回访点赞默认硬阻断；
- [x] 存在根目录 `SKILL.md`；
- [x] 存在 `actions:pending`；
- [x] 评论回复支持 `prepare → approve → dry-run → confirm-execute → execute`；
- [x] 同一评论活跃回复 action 防重复；
- [ ] 所有 Skill 主命令在 `--json` 模式下 stdout 只包含最终 JSON；
- [ ] `likes:plan --json` 返回仅预览候选，且不引导真实执行；
- [ ] `actions:pending` 返回 blocked 明细；
- [ ] 评论回复支持多条件唯一定位，歧义目标自动阻断；
- [ ] 关键测试不依赖本地已有数据库；
- [ ] README 与 SKILL 文档和实际代码一致；
- [ ] 使用测试账号、人工观察完成一次完整评论回复流程验证。

---

## 8. 给 Codex 的直接任务说明

```text
请继续基于当前 main 分支修复“礼尚往来”Skill MVP 的剩余问题，不要新增业务功能：

1. 彻底实现 --json 输出契约：所有 Agent 主流程命令在 --json 模式下 stdout 只能输出一次最终 JSON；运行日志、页面日志和迁移日志全部转 stderr；scan-interactions 的失败路径必须返回结构化 JSON。

2. 为 likes:plan 实现 --json 输出；所有候选必须包含 previewOnly:true 和 executeAllowed:false；删除任何引导执行 likes:reciprocate --execute 的提示，明确 MVP 阶段只允许预览。

3. 改造 actions:pending，使其返回 blockedItems 详情，包括 eventId、评论/点赞类型、用户昵称、作品、原评论、最近 action 状态、reason 和 evidence；同时确保 openReplyBox 失败时 event 状态同步为 blocked。

4. 加强评论回复唯一定位：openReplyBox 不再只接受 commentText，而应联合 actorName 与 eventTimeText 做匹配；多个候选或无法唯一确认时必须返回 blocked，不允许发送。

5. 重写关键测试：使用临时数据库建立测试数据；严格校验 stdout 整体可被 JSON.parse；覆盖二次确认、重复拦截、blockedItems、likes 仅预览和评论歧义阻断。

6. 更新 README 和 SKILL.md，使文档与实际代码能力、命令和安全限制一致。

修改完成后运行全部测试，输出修改文件清单、测试结果和剩余风险。不要开放真实回访点赞。
```

---

## 9. 当前结论

本轮最新提交已经有效完成：

```text
发送前二次确认代码化
execute_confirmed 状态接入
状态迁移与活跃 action 唯一索引
基础评论工作流测试文件
```

但仍需优先完成：

```text
纯净 JSON 输出
点赞候选仅预览 JSON
blocked 明细输出
评论唯一目标定位
可靠测试与文档同步
```

在这些问题修复前，项目适合继续由测试账号进行人工观察验证，不适合交给 Agent 对真实账号自动执行公开互动。
