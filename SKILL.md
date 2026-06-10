---
name: li-shang-wang-lai
description: 抖音互动采集、评论回复、回访准备、评论生成与回访执行入口 Skill。
---

# 礼尚往来主 Skill

这是 `li_shang_wang_lai` 项目的唯一主 Skill。

Agent 生成或填写评论时，必须遵守 `references/comment-safety-rules.md`。

## 基本原则

1. **登录检查**：每次任务执行前，Agent 必须先运行 `npm run auth` 确认登录态，已登录再继续后续步骤；未登录则终止并提示用户扫码。
2. **只走 CLI**：Agent 只通过项目已有 `npm run` 命令执行操作，不得直接编写 Playwright/浏览器自动化脚本。
3. **不碰数据库**：Agent 不得直接修改 SQLite。
4. **不绕风控**：Agent 不得绕过登录、验证码、滑块或任何平台风控措施。
5. **失败即停**：任何命令失败后，Agent 必须立即停止后续真实动作，先读取错误诊断，不得盲目重试。
6. **严格遵循流程**：Agent 必须严格按照下方"评论回复流程"和"回访流程"的步骤执行，不得跳过、合并或自行变通。
7. **不编辑中间文件**：Agent 不得编辑任务 ID 或任何中间文件。
8. **安全与阻断**：不发送空评论、广告、引流、互关、互赞、骚扰内容。页面未稳定、登录失效、点赞状态未知、重复执行风险、发送结果未确认时，必须阻断。

## 用户意图映射

| 用户意图 | 采集命令 | 后续动作 |
|---|---|---|
| 只看互动 | `npm run interactions:scan -- --type all --days N --max-count M --display-only` | 只展示互动数据 |
| 评论回复 | `npm run interactions:scan -- --type comment --days N --max-count M --prepare-replies` | `comments:execute --days N --limit M` |
| 明确回访 | `npm run interactions:scan -- --type all --days N --max-count M --prepare-visits` | `visit:run --execute` |
| 评论回复并回访 | `npm run interactions:scan -- --type all --days N --max-count M` | 先回评，再按用户明确要求回访 |

## 评论回复流程

先扫描入库并查询待回评范围：

```bash
npm run interactions:scan -- --type comment --days N --max-count M --prepare-replies
```

然后执行：

```bash
npm run comments:execute -- --days N --limit M
```

`comments:execute` 从 `work_comments` 读取待回评评论，在当前进程内调用 Hermes/OpenClaw 生成并写回 `reply_text`，然后打开待回复评论所属的抖音作品页，在作品评论区定位目标评论；优先结合 `cid/comment_id` 与 `/aweme/v1/web/comment/list/` 做确认，唯一命中后点击“回复”、填写、发送并校验，不再进入创作者评论管理页。

## 回访流程

> **Agent 必须按以下步骤严格执行，不得跳步或自行变通。**

**步骤 1**：扫描互动数据并入库，准备待回访任务：

```bash
npm run interactions:scan -- --days N --max-count M --prepare-visits
```

**步骤 2**：执行回访（点赞 + 评论）：

```bash
npm run visit:run -- --execute
```

`visit:run` 从 `return_visit_tasks` 读取任务，打开目标用户主页，选择作品，生成回访评论并填写提交。

不带 `--execute` 时只能 dry-run，不得真实点赞或评论。

## ID 规则

- 评论回复使用 `work_comments.id`。
- 回访执行使用 `return_visit_tasks.taskId`。
- Agent 不编辑任务 ID，也不编辑中间文件。

## 安全限制

- 不发送空评论。
- 不发送广告、引流、互关、互赞、骚扰内容。
- 不在命令失败后继续真实动作。
- 回访默认直接执行 `visit:run --execute`，不依赖 `return-visit:prepare` 或 JSON 文件。

- 页面未稳定、登录失效、点赞状态未知、重复执行风险或发送结果未确认时必须阻断。
