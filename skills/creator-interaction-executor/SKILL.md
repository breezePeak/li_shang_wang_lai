---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。基于当前真实 CLI：interactions:scan、actions:pending、comments:prepare、comments:execute-all、return-visit:prepare、return-visit:execute。
---

# 创作者互动执行

本技能用于执行 `li_shang_wang_lai` 项目的互动流程。执行前必须核对当前项目的 `package.json` scripts，并以实际 scripts 为准。

本技能只调用项目已有 CLI，不直接写 Playwright 脚本，不直接修改 SQLite，不绕过登录、验证码、滑块或平台风控。

## 项目目录

优先使用当前目录；如果当前目录没有 `package.json`，按 README 的安装目录寻找项目。

任何 `npm run` 参数都必须放在 `--` 后面。

## 当前真实命令

| 阶段 | npm script | 说明 |
|---|---|---|
| 登录认证 | `auth` | 打开浏览器并自动检测登录态 |
| 扫描互动 | `interactions:scan` | 打开通知页采集评论和点赞 |
| 查看待处理 | `actions:pending` | 输出 eventId、actionId、状态和分类摘要 |
| 准备评论回复 | `comments:prepare` | 用 eventId 和回复文本创建 prepared action |
| 执行评论回复 | `comments:execute-all` | 直接处理 prepared action，可批量真实发送 |
| 重置 blocked | `actions:reset-blocked` | 将 blocked action 恢复为 prepared |
| 准备回访 | `return-visit:prepare` | 采集对方作品上下文并生成回访评论 |
| 执行回访 | `return-visit:execute` | 真实执行回访点赞和评论 |

旧的导出/应用/手动审批/二次确认流程已经删除。不要让 agent 进入手动分段链路。

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

批量执行：

```bash
npm run comments:execute-all -- --action-ids 1,2,3 --execute
npm run comments:execute-all -- --all-prepared --max-items 20 --execute
```

回访流程：

```bash
npm run return-visit:prepare
npm run return-visit:execute
```

默认扫描最近 7 天互动。默认不要添加 `--json`，除非需要机器解析输出。

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

`auto_simple` 只能使用模板池文本。`auto_natural` 允许 Agent 生成的自然回复，但会做长度和禁用词安全检查。

如果缺少必填参数，CLI 会一次性列出所有缺失项。

## blocked 恢复

浏览器崩溃、页面定位失败或 profile lock 导致 action 变成 `blocked` 后，不要手改数据库。使用：

```bash
npm run actions:reset-blocked -- --action-id <action_id>
npm run comments:execute-all -- --action-id <action_id> --execute
```

## ID 规则

扫描产生 `eventId`，`comments:prepare` 产生 `actionId`。

准备回复时用 `eventId`；执行、重试和重置时用 `actionId`。

## 安全限制

- 不绕过登录、验证码、滑块或平台风控。
- 不直接修改数据库。
- 不发送空评论、广告、引流、互关、互赞、辱骂或骚扰内容。
- 不在命令失败后继续执行后续真实动作。
- 不调用旧的导出/应用/手动审批/二次确认命令。
