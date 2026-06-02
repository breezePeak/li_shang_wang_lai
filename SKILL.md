---
name: li-shang-wang-lai
description: 抖音互动采集、回访、回复建议与执行入口 Skill，负责把任务路由到具体子 Skill。
---

# 礼尚往来主入口 Skill

这是 `礼尚往来 / li-shang-wang-lai` 的 Hermes / OpenClaw 主入口 Skill。它只负责由 Agent 理解用户意图、核对当前仓库文件，并把任务路由到 README、命令文档或具体子 Skill；项目代码不解析自然语言意图。

本文件不放安装流程、不重复完整互动执行流程、不维护评论回复细则。安装和初始化请看 `README.md`；详细互动执行流程请看 `skills/creator-interaction-executor/SKILL.md`；评论回复建议请看 `skills/creator-comment-suggestion/SKILL.md`。

## 适用场景

- 安装、初始化、认证、命令查询：读取 `README.md` 和 `docs/COMMANDS.md`。
- 扫描互动、准备评论回复、执行评论回复、准备回访、执行回访：路由到 `skills/creator-interaction-executor/SKILL.md`。
- 只生成一条抖音评论回复建议：路由到 `skills/creator-comment-suggestion/SKILL.md`。
- 检查项目状态或排查命令失败：先读取当前文件和命令输出，再判断下一步。

## 路由规则

- 用户问安装、Hermes、OpenClaw、依赖、首次登录：以 `README.md` 为准。
- 用户问可用命令、参数、默认值、旧命令是否存在：以 `package.json` scripts 和 `docs/COMMANDS.md` 为准。
- 用户要执行采集、评论回复或回访：进入 `skills/creator-interaction-executor/SKILL.md`，由 Agent 根据用户意图选择 `interactions:scan` 参数，真实动作必须遵守 `--execute` 门禁。
- 用户要回复某条评论但不执行平台动作：进入 `skills/creator-comment-suggestion/SKILL.md`，只输出一条自然回复。

## 常用命令

以下命令以 `package.json` scripts 为准：

```bash
npm run auth
npm run db:init
npm run interactions:scan -- --type all --days 7 --max-count 100 --display-only
npm run interactions:scan -- --type comment --days 7 --max-count 100 --generate-reply-json
npm run interactions:scan -- --type all --days 7 --max-count 100 --generate-visit-json
npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json
npm run comments:execute-all -- --items-file data/pending-replies/pending-comments-xxx.json --execute
npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json --days 7 --max-items 5
npm run return-visit:execute -- --execute
npm test
```

完整参数和调试入口见 `docs/COMMANDS.md`。

## 执行原则

- 不凭记忆回答安装状态、文件名或命令参数。
- 执行 npm 命令前确认当前在项目根目录。
- 命令失败后读取真实错误并诊断。
- 不绕过登录、验证码、滑块或平台风控。
- 没有 `--execute` 时不得执行真实点赞、评论或回复。
