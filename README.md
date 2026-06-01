# 礼尚往来 · li_shang_wang_lai

一个基于 Playwright 的抖音创作者互动助手。

用于帮助创作者扫描评论和点赞互动，整理待处理任务，准备评论回复，生成回访任务，并在用户确认后执行评论回复或作品回访。

> 礼尚往来：别人给你点赞或评论，你可以回看对方作品，并进行自然、克制、可追踪的互动。

---

## 项目能做什么

当前项目主要支持：

- 扫描抖音通知中心；
- 采集评论互动；
- 采集点赞互动；
- 查看待处理互动；
- 准备评论回复；
- 执行已确认的评论回复；
- 从互动事件生成回访任务；
- 进入互动用户主页；
- 查找最近合适作品；
- 采集作品内容和参考评论；
- 生成回访评论；
- 执行回访：点赞 + 评论；
- 记录执行结果；
- 保存失败截图和调试信息。

---

## 环境要求

| 环境 | 要求 |
|---|---|
| Node.js | 24+ |
| npm | 随 Node.js 安装 |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 账号 | 已完成抖音登录 |

安装 Playwright Chromium：

```bash
npx playwright install chromium
```

---

## 如何安装

### 安装到 Hermes

macOS / Linux：

```bash
mkdir -p ~/.hermes/skills
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.hermes/skills/creator-interaction-executor
cd ~/.hermes/skills/creator-interaction-executor
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hermes\skills"
git clone https://github.com/breezePeak/li_shang_wang_lai.git "$env:LOCALAPPDATA\hermes\skills\creator-interaction-executor"
cd "$env:LOCALAPPDATA\hermes\skills\creator-interaction-executor"
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

---

### 安装到 OpenClaw

macOS / Linux：

```bash
mkdir -p ~/.openclaw/skills
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.openclaw/skills/creator-interaction-executor
cd ~/.openclaw/skills/creator-interaction-executor
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.openclaw\skills"
git clone https://github.com/breezePeak/li_shang_wang_lai.git "$env:USERPROFILE\.openclaw\skills\creator-interaction-executor"
cd "$env:USERPROFILE\.openclaw\skills\creator-interaction-executor"
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

---


---

## 常用命令

| 功能 | 命令 | 说明 |
|---|---|---|
| 登录账号 | `npm run auth` | 打开浏览器，手动完成抖音登录 |
| 扫描互动 | `npm run interactions:scan -- --type all --days 7` | 扫描最近 7 天的评论和点赞互动 |
| 查看待处理 | `npm run actions:pending` | 查看数据库中等待处理的互动任务 |
| 准备评论回复 | `npm run comments:prepare -- --event-id <id> --reply-text "xxx" --decision approve` | 为单条评论准备回复 |
| 审批回复 | `npm run actions:approve -- --action-id <id>` | 审批指定动作 |
| dry-run 定位 | `npm run comments:execute -- --dry-run` | 预演定位目标评论 |
| 确认执行 | `npm run actions:confirm-execute -- --action-id <id>` | 确认执行指定动作 |
| 执行评论回复 | `npm run comments:execute -- --execute --max-items 1` | 真实执行评论回复 |
| 准备回访 | `npm run return-visit:prepare` | 进入好友主页，采集上下文，生成回访评论 |
| 执行回访 | `npm run return-visit:execute -- --execute` | 执行点赞 + 评论回访 |

更多命令参数见：

```text
docs/COMMANDS.md
```

---

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
