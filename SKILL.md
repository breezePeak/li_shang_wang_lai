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
- 评论回复由 `comments:execute` 读取 JSON 执行。
- 回访必须带 `--execute` 才真实点赞和评论。
- Agent 只填写 JSON 中的 `reply_text` 或 `comment`，不能改 `id`，不能删条目。

## 用户意图映射

| 用户意图 | 采集命令 | 后续动作 |
|---|---|---|
| 只看互动 | `npm run interactions:scan -- --type all --days N --max-count M --display-only` | 只展示互动数据 |
| 评论回复 | `npm run interactions:scan -- --type comment --days N --max-count M --generate-reply-json` | Agent 填 `reply_text`，然后 `comments:execute` |
| 明确回访 | `npm run interactions:scan -- --type all --days N --max-count M --generate-visit-json` | `return-visit:prepare`，然后 Agent 填 `comment`，再 `return-visit:execute --execute` |
| 评论回复并回访 | `npm run interactions:scan -- --type all --days N --max-count M --generate-reply-json --generate-visit-json` | 先回评，再按用户明确要求回访 |

## 评论回复流程

先扫描并生成待回评 JSON：

```bash
npm run interactions:scan -- --type comment --generate-reply-json
```

生成文件：

```text
data/pending-replies/pending-comments-xxx.json
```

Agent 读取 JSON，根据评论内容、作品上下文和共享规则填写 `reply_text` 字段。

然后执行：

```bash
npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json
```

执行阶段会直接打开待回复评论所属的抖音作品页，在作品评论区定位目标评论；优先结合 `cid/comment_id` 与 `/aweme/v1/web/comment/list/` 做确认，唯一命中后点击“回复”、填写 `reply_text`、发送并校验，不再进入创作者评论管理页。

## 回访流程

先扫描并生成最小待回访 JSON：

```bash
npm run interactions:scan -- --generate-visit-json
```

生成文件：

```text
data/pending-visits/pending-visits-xxx.json
```

该 JSON 只包含类似：

```json
[
  {
    "id": "数据库记录ID",
    "homepage_url": "https://www.douyin.com/user/xxx"
  }
]
```

然后执行回访准备：

```bash
npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json
```

该命令负责：
- 读取待回访 JSON 中的 id，从数据库加载对应 return_visit_tasks（任务创建已在 interactions:scan --generate-visit-json 阶段完成）
- 逐个打开用户主页
- 监听 `/aweme/v1/web/aweme/post/`
- 过滤置顶作品 `is_top = 1`
- 选择第一条非置顶作品
- 记录作品 ID、作品 URL、描述等元数据
- 输出：

```text
data/pending-visits/pending-visit-comments-xxx.json
```

Agent 读取该 JSON，根据作品描述和共享规则填写：

```text
comment
```

最后执行：

```bash
npm run return-visit:execute -- --execute --items-file data/pending-visits/pending-visit-comments-xxx.json
```

不带 `--execute` 时只能 dry-run，不得真实点赞或评论。

## ID 规则

- 评论回复使用 `work_comments.id`。
- 回访执行使用 `return_visit_tasks.taskId`。
- Agent 不能改 JSON 中的 `id`。
- Agent 不能删除 JSON 条目。
- Agent 只填写 `reply_text` 或 `comment` 字段。

## 安全限制

- 不发送空评论。
- 不发送广告、引流、互关、互赞、骚扰内容。
- 不在命令失败后继续真实动作。
- 不跳过 `return-visit:prepare` 直接执行回访。

- 页面未稳定、登录失效、点赞状态未知、重复执行风险或发送结果未确认时必须阻断。
