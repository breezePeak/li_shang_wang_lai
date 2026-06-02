# AGENTS.md

## 项目概述

礼尚往来 — 抖音创作者互动助手 Hermes / OpenClaw Skill 执行引擎。Node.js + Playwright + SQLite。

## 常用命令

```bash
npm test                    # 运行全部测试
npm run test:watch          # watch 模式
npm run db:init             # 初始化数据库
npm run auth                # 浏览器扫码登录
```

## 提交规范

写完代码后，**确认测试通过**再提交：

```bash
npm test && git add -A && git commit -m "<描述>" && git push
```

- 提交信息用中文，简洁描述改动原因
- 不提交 `.env`、`config/local.json`、`.playwright/`、`data/` 下的内容（已在 .gitignore）
- **每次改动完成后自动提交并 push，不需要用户提醒**

## TODO

- `clickLike` 后续必须复用 `checkLikeState` 的 action bar 定位（`.t5VMknM2 .MinpposV > .AOWKbsTg` 第一个），先确认已赞态再决定是否点击。暂不实现真实 clickLike。
