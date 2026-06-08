---
name: li-shang-wang-lai
description: 抖音互动采集、评论回复、回访准备、评论生成与回访执行入口 Skill。
---

# 礼尚往来主 Skill

这是 `li_shang_wang_lai` 项目的唯一主 Skill。

Agent 生成或填写评论时，必须遵守 `references/comment-safety-rules.md`。

## 基本原则

- 只调用项目已有 CLI，不直接写 Playwright 脚本。
- 不直接修改 SQLite。
- 不绕过登录、验证码、滑块或平台风控。
- 所有 `npm run` 参数必须放在 `--` 后面。
- 命令失败后停止后续真实动作，先读取错误并诊断。
- 评论回复由 `comments:execute --days N --limit M` 从数据库读取并执行。
- 回访必须带 `--execute` 才真实点赞和评论。
- CLI 在进程内调用 Hermes/OpenClaw 生成 `reply_text` 或回访评论文本，不控制浏览器之外的额外服务，不编辑中间文件。

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

`comments:execute` 会从 `work_comments` 查询待回评评论，在当前进程内调用 Hermes/OpenClaw 生成并写回 `reply_text`，然后打开待回复评论所属的抖音作品页，在作品评论区定位目标评论；优先结合 `cid/comment_id` 与 `/aweme/v1/web/comment/list/` 做确认，唯一命中后点击“回复”、填写、发送并校验，不再进入创作者评论管理页。

## 回访流程

先扫描入库并准备待回访 DB 任务：

```bash
npm run interactions:scan -- --days N --max-count M --prepare-visits
```

然后执行回访：

```bash
npm run visit:run -- --execute
```

执行阶段会从 `return_visit_tasks` 读取任务，打开目标用户主页一次，监听 `/aweme/v1/web/aweme/post/` 主页作品列表 API；有可用的对方作品 `workId` 时优先匹配并点击目标作品，否则选择主页首个非置顶作品，进入作品页后在当前进程内调用 Hermes/OpenClaw 生成回访评论，再由 CLI 填写并提交。

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
