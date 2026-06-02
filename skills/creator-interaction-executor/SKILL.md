---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。当前主流程基于真实 CLI：interactions:scan、comments:prepare、comments:execute、return-visit:prepare、return-visit:execute。
---

# 创作者互动执行

本 Skill 只写互动执行流程：采集、评论回复准备、评论回复执行、回访准备、回访执行。

执行前必须读取当前 `package.json` scripts，并在必要时核对 `docs/COMMANDS.md`。不得凭提示词或记忆进入旧流程。用户意图由 Agent 判断，项目 CLI 只接收明确参数，不提供自然语言意图解析入口。

## 基本规则

- 只调用项目已有 CLI，不直接写 Playwright 脚本。
- 不直接修改 SQLite。
- 不绕过登录、验证码、滑块或平台风控。
- 所有 `npm run` 参数必须放在 `--` 后面。
- 评论回复不需要 `--execute`，默认真实执行。回访仍需 `--execute`，不得在没有 `--execute` 时执行回访点赞或评论。
- 命令失败后停止后续真实动作，先读取错误并诊断。

## 当前主流程命令

| 阶段 | npm script | 说明 |
|---|---|---|
| 登录认证 | `auth` | 打开浏览器并检测登录态 |
| 扫描互动 | `interactions:scan` | Agent 根据用户意图选择参数，可只展示或生成待回评 / 待回访 JSON |
| 准备评论回复 | `comments:prepare` | 读取第一步 JSON 的 `reply_text`，更新 `work_comments` |
| 执行评论回复 | `comments:execute` | 读取同一个 JSON 执行回复；默认真实执行，不需要 `--execute` |
| 准备回访 | `return-visit:prepare` | 用户明确要求回访时，消费待回访 JSON 并生成回访任务 |
| 执行回访 | `return-visit:execute` | 带 `--execute` 才真实点赞 + 评论 |

## 用户意图映射

| 用户意图 | 采集命令 | 后续动作 |
|---|---|---|
| 只看互动 | `interactions:scan -- --type all --days N --max-count M --display-only` | 只展示互动数据，不生成待回评 / 待回访 JSON |
| 评论回复 | `interactions:scan -- --type comment --days N --max-count M --generate-reply-json` | Agent 根据评论内容、作品上下文和安全规则，生成并填写 `reply_text`，再执行 `comments:prepare` 和 `comments:execute` |
| 明确回访 | `interactions:scan -- --type all --days N --max-count M --generate-visit-json` | 执行 `return-visit:prepare -- --items-file <待回访 JSON>` 和 `return-visit:execute` |
| 评论回复并回访 | `interactions:scan -- --type all --days N --max-count M --generate-reply-json --generate-visit-json` | 先走回评模块，再按用户明确要求走回访模块 |

`N` 和 `M` 由 Agent 从用户要求或安全默认值决定。默认建议 `days=7`、`max-count=100`。评论回复默认真实执行；回访仍需 `--execute`。

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
npm run interactions:scan -- --type comment --days 7 --max-count 100 --generate-reply-json
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
work_comments.reply_text = JSON 中填写的 reply_text（不改变 reply_status）
prepare_status_code = PREPARE_READY
execute_status_code = EXECUTE_WAIT_CONFIRM
```

4. 执行评论回复（默认真实执行）：

```bash
npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
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
npm run interactions:scan -- --type all --days 7 --max-count 100 --generate-visit-json
```

2. 准备回访任务：

```bash
npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json
```

该命令消费采集阶段生成的待回访 JSON，创建或更新回访任务，进入用户主页，采集作品内容和参考评论，生成回访评论。它不会点赞，也不会发表评论。

## ID 规则

- 评论回复主流程使用 `work_comments.id`，即第一步 JSON 里每条评论的 `id`。
- 准备回复时只传 `--items-file`，不传 `eventId`。
- 执行评论回复时只传 `--items-file`。
- 回访任务使用 `return-visit:prepare` 内部生成的 taskId，通常不需要手动传入。

## 安全限制

- 不发送空评论、广告、引流、互关、互赞、辱骂或骚扰内容。
- 不在命令失败后继续执行后续真实动作。
- 评论回复必须先由 `comments:prepare -- --items-file <json>` 更新为 `prepared`。
- 回访必须先经过 `return-visit:prepare`，不得跳过上下文采集直接执行。
- 页面未稳定、登录失效、点赞状态未知、重复执行风险或发送结果未确认时必须阻断。
