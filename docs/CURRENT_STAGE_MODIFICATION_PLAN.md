# 礼尚往来：现阶段修改计划

> 文档用途：明确当前仓库从"Playwright 执行引擎"推进到"Agent 可调用 Skill"之前，必须优先修改的内容。
> 当前阶段目标：先锁住风险，再补 Skill 入口与结构化命令契约，最后打通评论回复的最小闭环。

---

## 1. 当前判断

当前项目已经具备一套可复用的本地执行引擎，包括：

* Playwright 持久化登录态；
* 评论页面扫描、入库与去重；
* 点赞/通知页面扫描探索；
* 评论回复计划生成；
* 评论回复 dry-run 与单条 execute 路径；
* SQLite 事件、计划、动作记录；
* 运行摘要、异常证据与部分防重复逻辑。

但项目还不能直接作为 Agent Skill 使用，主要原因是：

1. 根目录缺少 `SKILL.md`；
2. CLI 输出仍偏人类控制台日志，缺少稳定 `--json` 契约；
3. 缺少给 Skill 读取的待处理事项报告命令；
4. 评论回复审批仍依赖手工编辑 JSON；
5. 真实点赞回访虽然文档标记为禁用，但代码层仍存在执行路径，必须先加硬阻断。

---

## 2. 当前阶段原则

本阶段不继续扩展新能力，优先完成以下三件事：

```text
先安全封口 → 再 Skill 化入口 → 再结构化闭环
```

具体原则：

| 原则      | 要求                                |
| ------- | --------------------------------- |
| 默认只读    | Agent 默认只能扫描、汇总、生成候选、dry-run      |
| 真实动作最小化 | MVP 只允许单条评论回复，不开放真实回访点赞           |
| 用户明确审批  | 任何公开动作必须展示目标、内容、风险后再执行            |
| 结构化输出   | Agent 调用命令必须能拿到稳定 JSON，而不是解析控制台日志 |
| 状态未知即阻断 | 页面定位、点赞状态、身份绑定不确定时必须停止            |
| 可追溯     | 扫描、计划、审批、执行、失败都要有本地记录             |

---

## 3. S0.5：真实点赞回访硬阻断

### 3.1 修改目标

在正式 Skill 暴露之前，先确保任何真实点赞回访不会被默认执行。

当前风险点：

* `src/config/defaults.mjs` 中 `likes.enabled` 当前为 `true`；
* `src/cli/execute-reciprocal-likes.mjs` 中存在 `--execute` 后真实点击点赞的路径；
* README 虽然标记"默认禁用"，但必须由代码层保证，而不是只靠说明。

### 3.2 修改文件

优先修改：

```text
src/config/defaults.mjs
src/cli/execute-reciprocal-likes.mjs
README.md
```

可选新增：

```text
src/domain/feature-policy.mjs
```

### 3.3 具体任务

* [ ] 将默认配置改为：

```js
likes: {
  enabled: false,
  experimentalExecuteEnabled: false,
  mode: 'preview',
  allowedRelations: ['friend', 'mutual'],
  maxPerRun: 5,
  skipPinned: true,
  requireLatestWorkConfirmed: true,
}
```

* [ ] 在 `execute-reciprocal-likes.mjs` 入口增加硬阻断：

```text
只要检测到 --execute，且实验开关未显式开启，立即退出。
不启动浏览器。
不读取计划执行。
不点击任何页面元素。
返回清晰的 FEATURE_DISABLED 错误。
```

* [ ] 明确保留 `likes:plan` 作为候选预览能力；
* [ ] README 中保持"真实回访点赞 MVP 禁用"的描述；
* [ ] 增加测试，验证 `likes:reciprocate --execute` 默认必定失败。

### 3.4 验收标准

执行：

```bash
npm run likes:reciprocate -- --plan data/plans/xxx.json --execute
```

应得到：

```json
{
  "ok": false,
  "code": "FEATURE_DISABLED",
  "message": "真实回访点赞在 MVP 阶段默认禁用"
}
```

并且：

* 不打开浏览器；
* 不访问目标主页；
* 不点击点赞按钮；
* 不写入成功动作记录。

---

## 4. S1：新增 Skill 根入口 `SKILL.md`

### 4.1 修改目标

让 OpenClaw Agent 能理解：

* 什么时候使用本 Skill；
* 可以调用哪些命令；
* 哪些命令只读；
* 哪些命令需要用户审批；
* 哪些动作当前禁止执行。

### 4.2 新增文件

```text
SKILL.md
```

### 4.3 `SKILL.md` 必须包含的内容

* Skill 名称：`礼尚往来`
* 适用场景：

  * 查看新评论；
  * 汇总互动通知；
  * 生成评论回复建议；
  * dry-run 定位评论；
  * 经用户确认后执行单条评论回复；
  * 查看好友/互关回访候选。
* 禁止场景：

  * 批量自动点赞；
  * 批量自动评论；
  * 无人值守循环执行；
  * 绕过验证码或登录校验；
  * MVP 阶段真实回访点赞。
* 推荐命令流程：

  * 首次登录；
  * 初始化数据库；
  * 扫描评论；
  * 生成 pending report；
  * 准备评论回复；
  * dry-run；
  * 二次确认后 execute。
* 安全规则：

  * 默认只读；
  * 真实动作必须二次确认；
  * 单轮最多执行 1 条；
  * 页面状态异常立即阻断；
  * 禁止 Agent 自行扩大执行范围。

---

## 5. S1.5：统一 CLI JSON 输出契约

### 5.1 修改目标

让 Agent 调用命令时不依赖控制台日志，而是读取稳定 JSON。

### 5.2 建议新增文件

```text
src/utils/cli-output.mjs
```

提供统一方法：

```js
printJsonResult(result)
printJsonError(error)
```

### 5.3 统一输出格式

成功：

```json
{
  "ok": true,
  "command": "actions:pending",
  "data": {},
  "summary": {},
  "warnings": []
}
```

失败：

```json
{
  "ok": false,
  "command": "likes:reciprocate",
  "code": "FEATURE_DISABLED",
  "message": "真实回访点赞在 MVP 阶段默认禁用",
  "recoverable": false,
  "evidence": null
}
```

### 5.4 优先支持 `--json` 的命令

第一批：

```text
interactions:scan
comments:plan
comments:reply
likes:plan
likes:reciprocate
```

第二批：

```text
actions:pending
comments:prepare
actions:approve
comments:execute
history
```

---

## 6. S2：新增待处理事项报告命令

### 6.1 修改目标

新增一个 Skill 可直接读取的 pending report，而不是让 Agent 去猜数据库状态或解析计划文件。

### 6.2 新增命令

```text
npm run actions:pending
```

对应新增脚本：

```text
src/cli/report-pending.mjs
```

并修改 `package.json`：

```json
"actions:pending": "node ./src/cli/report-pending.mjs"
```

### 6.3 输出内容

至少包含：

```json
{
  "ok": true,
  "command": "actions:pending",
  "data": {
    "comments": [
      {
        "eventId": 1,
        "actorName": "用户昵称",
        "workTitle": "作品标题",
        "commentText": "评论内容",
        "eventTimeText": "05-29",
        "status": "new"
      }
    ],
    "likes": [
      {
        "eventId": 2,
        "actorName": "好友昵称",
        "relation": "friend",
        "workTitle": "作品标题",
        "status": "new",
        "previewOnly": true
      }
    ]
  },
  "summary": {
    "pendingComments": 1,
    "pendingLikes": 1,
    "blocked": 0
  }
}
```

---

## 7. S3：评论回复审批闭环改造

### 7.1 修改目标

把当前"手动编辑 JSON 文件"的审批方式，升级为 Agent 可调用的命令式审批流程。

### 7.2 建议新增命令

```bash
npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" --json
npm run actions:approve -- --action-id <id> --json
npm run comments:execute -- --action-id <id> --dry-run --json
npm run comments:execute -- --action-id <id> --execute --max-items 1 --json
```

### 7.3 建议新增文件

```text
src/cli/prepare-comment-reply.mjs
src/cli/approve-action.mjs
src/cli/execute-comment-reply.mjs
src/db/action-repository.mjs
src/domain/approval-policy.mjs
```

### 7.4 最小流程

```text
用户要求回复某条评论
  ↓
Skill 展示评论原文 + 拟回复内容
  ↓
comments:prepare 创建 planned action
  ↓
用户明确确认
  ↓
actions:approve 标记 approved
  ↓
comments:execute --dry-run 定位目标评论
  ↓
用户再次确认"发送"
  ↓
comments:execute --execute --max-items 1
```

### 7.5 验收标准

Agent 能完成完整对话：

```text
用户：给第 1 条回复：谢谢支持
Agent：将回复 xxx 到 yyy 的评论，是否确认？
用户：确认
Agent：先 dry-run 定位成功，是否发送？
用户：发送
Agent：已发送 1 条，执行记录已保存
```

并且：

* 每次最多执行 1 条；
* 已回复过的 event 不重复执行；
* dry-run 失败不能进入 execute；
* execute 结果写入 `actions`；
* 异常有 evidence 目录。

---

## 8. S4：好友回访候选仅预览

### 8.1 修改目标

继续保留好友回访价值，但本阶段只做到候选预览，不做真实点赞。

### 8.2 输出要求

候选报告必须包含：

* 用户昵称；
* 关系标签：`friend` / `mutual` / `unknown`；
* 来源通知证据；
* 候选主页 URL；
* 候选视频 URL；
* 是否跳过置顶；
* 是否状态不确定；
* `previewOnly: true`；
* `executeAllowed: false`。

### 8.3 阻断规则

以下情况必须标记 blocked：

* 只靠昵称无法确认身份；
* 没有主页 URL；
* 没有候选视频 URL；
* 点赞状态未知；
* 关系不是好友或互关；
* 页面出现验证码、登录失效、异常跳转。

---

## 9. 建议提交顺序

### Commit 1：锁死真实点赞

```text
feat(safety): hard-disable reciprocal like execution by default
```

内容：

* 修改 `defaults.mjs`；
* `likes:reciprocate --execute` 增加 `FEATURE_DISABLED`；
* 补测试；
* 更新 README 小段说明。

### Commit 2：新增 Skill 根入口

```text
docs(skill): add OpenClaw SKILL entrypoint
```

内容：

* 新增 `SKILL.md`；
* 写清楚调用流程和安全边界。

### Commit 3：新增 JSON 输出工具

```text
feat(cli): add structured json output helper
```

内容：

* 新增 `src/utils/cli-output.mjs`；
* 给 1～2 个核心命令先接入 `--json`。

### Commit 4：新增 pending report

```text
feat(actions): add pending interaction report command
```

内容：

* 新增 `report-pending.mjs`；
* 修改 `package.json`；
* 支持 `--json`。

### Commit 5：评论审批命令化

```text
feat(comments): add approval-based single reply workflow
```

内容：

* 新增 prepare / approve / execute 命令；
* 替代手工编辑 JSON 的主流程；
* 保留旧 `comments:plan` 作为兼容入口。

---

## 10. 当前不建议做的事

本阶段不要做：

* 不要开放真实好友回赞；
* 不要做批量点赞；
* 不要做无人值守定时任务；
* 不要先做复杂本地管理后台；
* 不要把 Skill 设计成"自动运营工具"；
* 不要让 Agent 根据昵称直接判断唯一用户；
* 不要绕过验证码、登录校验或平台风控。

---

## 11. 当前阶段完成定义

当以下条件满足，可以认为当前阶段完成：

* [ ] `likes:reciprocate --execute` 默认被代码层硬阻断；
* [ ] 根目录存在 `SKILL.md`；
* [ ] 核心命令支持 `--json`；
* [ ] 存在 `actions:pending` 命令；
* [ ] Agent 能读取待处理评论摘要；
* [ ] Agent 能创建单条评论回复候选；
* [ ] 用户确认后可以 dry-run；
* [ ] 用户二次确认后最多发送 1 条评论回复；
* [ ] 好友回访只输出候选，不执行真实点赞；
* [ ] 执行结果和阻断原因可追溯。

---

## 12. 给 Codex 的一句话任务

```text
请按照 docs/CURRENT_STAGE_MODIFICATION_PLAN.md 推进当前阶段改造：先完成真实点赞硬阻断，再新增 SKILL.md，然后为核心 CLI 增加 --json 输出和 actions:pending 命令，最后把评论回复从手工编辑 JSON 改为 prepare → approve → dry-run → execute 的单条审批闭环。不要开放真实回访点赞。
```
