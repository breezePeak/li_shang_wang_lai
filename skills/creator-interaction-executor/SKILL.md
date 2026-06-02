---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。当前主流程基于真实 CLI：interactions:scan、comments:prepare、comments:execute-all、return-visit:prepare、return-visit:execute。
---

# 创作者互动执行

本 Skill 只写互动执行流程：采集、评论回复准备、评论回复执行、回访准备、回访执行。

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
| 扫描互动 | `interactions:scan` | 采集评论和点赞互动，并输出按作品分组的待回复评论 JSON |
| 准备评论回复 | `comments:prepare` | 读取第一步 JSON 的 `reply_text`，更新 `work_comments` |
| 执行评论回复 | `comments:execute-all` | 读取同一个 JSON 执行回复；带 `--execute` 才真实发送 |
| 准备回访 | `return-visit:prepare` | 用户明确要求回访时，从数据库按时间窗口和条数查询待回访用户 |
| 执行回访 | `return-visit:execute` | 带 `--execute` 才真实点赞 + 评论 |

## 不属于评论回复主流程的入口

| 入口 | 分类 | 处理规则 |
|---|---|---|
| `actions:pending` | 只读辅助 | 可查看历史动作状态，但评论回复主流程不使用 |
| `actions:reset-blocked` | 历史动作恢复 | 不用于 JSON 评论回复主流程 |
| `likes:reciprocate` | 兼容旧 Agent | 真实回赞已禁用，不推荐使用 |
| `likes:plan` | 只读预览 | 可查看点赞候选，不执行 |
| `actions:plan` | 只读辅助 | 可查看候选，不作为执行链路入口 |
| `comments:classify` | 本地辅助 | 可分类评论，不执行 |
| `notify:inspect` / `interactions:inspect` / `debug:*` / `dev:inspect-page` | 调试命令 | 只在排查问题时使用 |

旧评论导出/应用/手动审批/二次确认流程已删除。评论回复只使用第一步 JSON 和 `work_comments.id`。

## 评论回复流程

1. 扫描互动，生成按作品分组的待回复评论 JSON：

```bash
npm run interactions:scan -- --type all --days 7
```

扫描结果会写入 `data/pending-replies/pending-comments-xxx.json`。该 JSON 的评论项来自 `work_comments`，必须包含 `id`，并带有状态码字段。

2. 为每条要回复的评论填写 `reply_text`。

回复文本必须通过 `skills/creator-comment-suggestion/SKILL.md` 生成。不要读取 `prompts/` 里的旧策略文件来生成评论。

3. 使用同一个 JSON 准备回复并更新数据库：

```bash
npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json
```

`comments:prepare` 默认值：

```text
--decision reply
--risk-level low
--relevance neutral
--reply-mode auto_natural
--comment-category unclear
```

准备成功后：

```text
work_comments.reply_status = prepared
work_comments.reply_text = JSON 中填写的 reply_text
prepare_status_code = PREPARE_READY
execute_status_code = EXECUTE_WAIT_CONFIRM
```

4. 先批量校验可执行性：

```bash
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json
```

5. 使用同一个 JSON 批量真实执行：

```bash
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json --execute
```

每条回复发送后必须确认结果，再更新数据库和 JSON：

```text
确认成功：work_comments.reply_status = succeeded，execute_status_code = EXECUTE_CONFIRMED
发送后未确认：work_comments.reply_status = sent_unverified，execute_status_code = EXECUTE_SENT_UNVERIFIED
定位或发送失败：work_comments.reply_status = blocked，execute_status_code = EXECUTE_BLOCKED
```

## 回访流程

只有用户明确要求回访时，才在评论回复结束后进入本流程。不要把回访准备作为评论回复的默认后置步骤。

1. 扫描互动：

```bash
npm run interactions:scan -- --type all --days 7
```

2. 准备回访任务：

```bash
npm run return-visit:prepare -- --days 7 --max-items 5
```

该命令会从数据库中的互动事件创建或更新回访任务，进入用户主页，采集作品内容和参考评论，生成回访评论。它不会点赞，也不会发表评论。

回访准备必须同时受边界约束：

```text
--days N       只读取过去 N 天扫描到的互动用户，并只处理该窗口内更新的回访任务
--event-limit  从数据库读取的来源事件上限
--max-items    本轮实际准备的待回访用户上限
```

3. 先 dry-run 检查：

```bash
npm run return-visit:execute
```

4. 真实执行点赞 + 评论：

```bash
npm run return-visit:execute -- --execute
```

## ID 规则

- 评论回复主流程使用 `work_comments.id`，即第一步 JSON 里每条评论的 `id`。
- 准备回复时只传 `--items-file`，不传 `eventId`。
- 执行评论回复时只传 `--items-file`。
- 回访任务使用 `return-visit:prepare` 内部生成的 taskId，通常不需要手动传入。

## 安全限制

- 不发送空评论、广告、引流、互关、互赞、辱骂或骚扰内容。
- 不在命令失败后继续执行后续真实动作。
- 评论回复必须先由 `comments:prepare -- --items-file <json>` 更新为 `prepared`。
- 回访必须先经过带边界约束的 `return-visit:prepare`，不得跳过上下文采集直接执行。
- 页面未稳定、登录失效、点赞状态未知、重复执行风险或发送结果未确认时必须阻断。
