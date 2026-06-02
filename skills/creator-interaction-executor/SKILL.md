---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。当前主流程基于真实 CLI：interactions:scan、actions:pending、comments:prepare、comments:execute-all、return-visit:prepare、return-visit:execute。
---

# 创作者互动执行

本 Skill 只写互动执行流程：采集、待处理、评论回复准备、评论回复执行、回访准备、回访执行。

执行前必须读取当前 `package.json` scripts，并在必要时核对 `docs/COMMANDS.md`。不得凭提示词或记忆进入旧流程。

## 基本规则

- 只调用项目已有 CLI，不直接写 Playwright 脚本。
- 不直接修改 SQLite。
- 不绕过登录、验证码、滑块或平台风控。
- 所有 `npm run` 参数必须放在 `--` 后面。
- 没有 `--execute` 时不得执行真实点赞、评论或回复。
- 命令失败后停止后续真实动作，先读取错误并诊断。

## 当前主流程命令

| 阶段 | npm script | 说明 |
|---|---|---|
| 登录认证 | `auth` | 打开浏览器并检测登录态 |
| 扫描互动 | `interactions:scan` | 采集评论和点赞互动 |
| 查看待处理 | `actions:pending` | 输出 eventId、actionId、状态和分类摘要 |
| 准备评论回复 | `comments:prepare` | 批量创建 prepared action |
| 执行评论回复 | `comments:execute-all` | 批量处理 prepared action；带 `--execute` 才真实发送 |
| 恢复 blocked | `actions:reset-blocked` | 将 blocked 评论动作恢复为 prepared |
| 准备回访 | `return-visit:prepare` | 采集主页、作品内容、参考评论并生成回访评论 |
| 执行回访 | `return-visit:execute` | 带 `--execute` 才真实点赞 + 评论 |

## 不属于主流程的入口

| 入口 | 分类 | 处理规则 |
|---|---|---|
| `likes:reciprocate` | 兼容旧 Agent | 真实回赞已禁用，不推荐使用 |
| `likes:plan` | 只读预览 | 可查看点赞候选，不执行 |
| `actions:plan` | 只读辅助 | 可查看候选，不作为执行链路入口 |
| `comments:classify` | 本地辅助 | 可分类评论，不执行 |
| `notify:inspect` / `interactions:inspect` / `debug:*` / `dev:inspect-page` | 调试命令 | 只在排查问题时使用 |

旧评论导出/应用/手动审批/二次确认流程已删除。不要调用不存在的旧命令，也不要编造审批或确认步骤。

## 评论回复流程

1. 扫描互动：

```bash
npm run interactions:scan -- --type all --days 7
```

2. 查看待处理：

```bash
npm run actions:pending
```

3. 为每条评论生成一条回复建议。

回复文本必须通过 `skills/creator-comment-suggestion/SKILL.md` 生成。不要读取 `prompts/` 里的旧策略文件来生成评论。

4. 批量创建 prepared action：

```bash
npm run comments:prepare -- --items-file replies.json
```

也可以直接传 JSON：

```bash
npm run comments:prepare -- --items-json '[{"eventId":1,"replyText":"小虾先记下啦"},{"eventId":2,"replyText":"这个小虾也觉得挺有意思"}]'
```

单条 `--event-id` + `--reply-text` 只用于兼容或临时调试，主流程不要逐条准备。

`comments:prepare` 默认值：

```text
--decision reply
--risk-level low
--relevance neutral
--reply-mode auto_natural
--comment-category unclear
```

5. 先批量校验可执行性：

```bash
npm run comments:execute-all -- --action-ids 1,2,3
```

6. 批量真实执行：

```bash
npm run comments:execute-all -- --action-ids 1,2,3 --execute
```

也可以执行全部 prepared：

```bash
npm run comments:execute-all -- --all-prepared --max-items 20 --execute
```

## 回访流程

1. 扫描互动：

```bash
npm run interactions:scan -- --type all --days 7
```

2. 准备回访任务：

```bash
npm run return-visit:prepare
```

该命令会从互动事件创建或更新回访任务，进入用户主页，采集作品内容和参考评论，生成回访评论。它不会点赞，也不会发表评论。

3. 先 dry-run 检查：

```bash
npm run return-visit:execute
```

4. 真实执行点赞 + 评论：

```bash
npm run return-visit:execute -- --execute
```

## blocked 恢复

浏览器崩溃、页面定位失败或 profile lock 导致评论 action 变成 `blocked` 后，不要手改数据库。

```bash
npm run actions:reset-blocked -- --action-id <action_id>
npm run comments:execute-all -- --action-id <action_id> --execute
```

## ID 规则

- 扫描产生 `eventId`。
- `comments:prepare` 产生 `actionId`。
- 准备回复时批量传入 `eventId` 和对应 `replyText`。
- 执行评论回复时批量传入 `actionId`，或用 `--all-prepared`。
- 回访任务使用 `return-visit:prepare` 内部生成的 taskId，通常不需要手动传入。

## 安全限制

- 不发送空评论、广告、引流、互关、互赞、辱骂或骚扰内容。
- 不在命令失败后继续执行后续真实动作。
- 评论回复必须先有 prepared action。
- 回访必须先经过 `return-visit:prepare`，不得跳过上下文采集直接执行。
- 页面未稳定、登录失效、点赞状态未知、重复执行风险或发送结果未确认时必须阻断。
