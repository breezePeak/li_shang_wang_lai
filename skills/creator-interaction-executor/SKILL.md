---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。基于当前 package.json 的真实 CLI：interactions:scan、actions:pending、comments:prepare、comments:execute-all、comments:execute、return-visit:prepare、return-visit:execute。
---

# 创作者互动执行

本技能用于执行 `li_shang_wang_lai` 项目的互动流程。执行前必须先读取当前项目的 `package.json` scripts，并以实际 scripts 为准。

本技能只调用项目已有 CLI，不直接写 Playwright 脚本，不直接修改 SQLite，不绕过登录、验证码、滑块或平台风控。

## 项目目录

优先使用当前目录；如果当前目录没有 `package.json`，按 README 的安装目录寻找项目：

```bash
cd "$PROJECT_DIR"
```

任何 `npm run` 参数都必须放在 `--` 后面。

## 当前真实命令

| 阶段 | npm script | 说明 |
|---|---|---|
| 扫描互动 | `interactions:scan` | 打开通知页采集评论和点赞 |
| 查看待处理 | `actions:pending` | 输出 event_id、action_id、状态和分类摘要 |
| 准备评论回复 | `comments:prepare` | 用 event_id 和回复文本创建 prepared action |
| 批量执行回复流 | `comments:execute-all` | 内部自动完成 approve、dry-run 数据校验、confirm、可选真实执行 |
| 审批动作 | `actions:approve` | 兼容旧流程；新流程默认不手动调用 |
| dry-run 校验 | `comments:execute -- --dry-run` | 兼容单条调试；只做数据和安全门禁校验，不打开浏览器 |
| 确认发送 | `actions:confirm-execute` | 兼容旧流程；新流程默认不手动调用 |
| 真实回复 | `comments:execute -- --execute` | 打开页面并发送单条评论回复 |
| 重置 blocked | `actions:reset-blocked` | 将 blocked action 恢复到 approved 以便重试 |
| 准备回访 | `return-visit:prepare` | 采集对方作品上下文并生成回访评论 |
| 执行回访 | `return-visit:execute` | 真实执行回访点赞和评论 |

不存在 `replies:export`、`replies:apply`、`replies:execute`。不要使用这些旧命令。

## 默认完整流程

当用户要求“跑完整礼尚往来流程”时，按顺序执行：

```bash
npm run interactions:scan -- --type all --days 7
npm run actions:pending
```

然后根据 `actions:pending` 中的待处理评论逐条或批量准备回复。评论文案必须遵守：

```text
skills/creator-comment-suggestion/SKILL.md
```

评论回复默认流程：

```bash
npm run comments:prepare -- --event-id <event_id> --reply-text "<自然简短回复>"
npm run comments:execute-all -- --action-id <action_id> --execute
```

回访流程：

```bash
npm run return-visit:prepare
npm run return-visit:execute
```

默认扫描最近 7 天互动。默认不要添加 `--json`，除非需要机器解析输出。新流程不要求 agent 手动审批；`comments:execute-all` 会在内部走完 approve、dry-run 数据校验和 confirm。

## comments:prepare 默认值

`comments:prepare` 最小可用命令：

```bash
npm run comments:prepare -- --event-id <event_id> --reply-text "<回复文本>"
```

省略时 CLI 使用这些默认值：

```text
--decision reply
--risk-level low
--relevance neutral
--reply-mode auto_natural
--comment-category unclear
```

如需使用固定模板模式：

```bash
npm run comments:prepare -- --event-id <event_id> --reply-text "谢谢认可～" --reply-mode auto_simple --comment-category praise
```

`auto_simple` 只能使用模板池文本。`auto_natural` 允许 Agent 生成的自然回复，但会做长度和禁用词安全检查。

如果缺少必填参数，CLI 会一次性列出所有缺失项。

## 批量操作

默认批量执行回复流：

```bash
npm run comments:execute-all -- --action-ids 1,2,3 --execute
npm run comments:execute-all -- --all-prepared --max-items 20 --execute
npm run comments:execute-all -- --all-ready --max-items 20 --execute
```

兼容旧流程的批量审批和确认：

```bash
npm run actions:approve -- --action-ids 1,2,3
npm run actions:approve -- --all-prepared
npm run actions:confirm-execute -- --action-ids 1,2,3
npm run actions:confirm-execute -- --all-dry-run-ok
```

`comments:execute-all` 不加 `--execute` 时只推进到 `execute_confirmed`，不会打开浏览器真实发送。加 `--execute` 才会发送。

## blocked 恢复

浏览器崩溃、页面定位失败或 profile lock 导致 action 变成 `blocked` 后，不要手改数据库。使用：

```bash
npm run actions:reset-blocked -- --action-id <action_id>
```

该命令会把 action 恢复到 `approved`，下一步重新执行：

```bash
npm run comments:execute -- --action-id <action_id> --dry-run
```

## actions:pending 的 ID 规则

扫描产生 `event_id`，`comments:prepare` 产生 `action_id`。后续审批、dry-run、确认和执行都使用 `action_id`。

`actions:pending` 会在已有 action 时同时显示：

```text
eventId
actionId
latestActionStatus
```

准备回复时用 `eventId`；后续动作流转用 `actionId`。

## 安全限制

- 不绕过登录、验证码、滑块或平台风控。
- 不直接修改数据库。
- 不发送空评论、广告、引流、互关、互赞、辱骂或骚扰内容。
- 不在命令失败后继续执行后续真实动作。
- 不用 `replies:*` 旧命令。
- 新流程默认不手动调用 approve、dry-run、confirm；这些步骤由 `comments:execute-all` 内部完成。
