# 礼尚往来 · li_shang_wang_lai

基于 Node.js、Playwright 和 SQLite 的抖音创作者互动助手，支持 Hermes / OpenClaw Skill 加载。

项目用于辅助创作者扫描互动、准备评论回复、准备回访任务，并在显式执行模式下完成评论回复或回访点赞 + 评论。评论回复默认真实执行；回访需 `--execute`。

## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、首次初始化、常用入口命令。
- `SKILL.md`：Hermes / OpenClaw 主入口调度，不写完整流程细节。
- `docs/COMMANDS.md`：命令参考手册，和 `package.json` scripts、实际 CLI 参数保持一致。
- `skills/creator-interaction-executor/SKILL.md`：互动执行流程。
- `skills/creator-comment-suggestion/SKILL.md`：只生成一条评论回复建议，不执行命令。

根目录只保留 `SKILL.md`。不要同时创建 `skill.md` 和 `SKILL.md`，macOS 默认 APFS 大小写不敏感，两个文件名容易互相覆盖。

## 环境要求

| 环境 | 要求 |
|---|---|
| Node.js | 20+ |
| npm | 随 Node.js 安装 |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 账号 | 抖音创作者账号，需完成浏览器登录 |

## Skill 入口

Hermes / OpenClaw 安装后应能识别三个 Skill：

- `li-shang-wang-lai`：根入口，负责路由。
- `creator-interaction-executor`：互动采集、评论回复、回访执行流程。
- `creator-comment-suggestion`：只生成一条评论回复建议。

主入口不维护完整流程细节。互动执行请看 `skills/creator-interaction-executor/SKILL.md`，评论回复建议请看 `skills/creator-comment-suggestion/SKILL.md`。

## 安装到 Hermes

macOS / Linux：

```bash
mkdir -p ~/.hermes/skills
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.hermes/skills/li-shang-wang-lai
cd ~/.hermes/skills/li-shang-wang-lai
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\hermes\skills"
git clone https://github.com/breezePeak/li_shang_wang_lai.git "$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai"
cd "$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai"
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

## 安装到 OpenClaw

macOS / Linux：

```bash
mkdir -p ~/.openclaw/skills
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.openclaw/skills/li-shang-wang-lai
cd ~/.openclaw/skills/li-shang-wang-lai
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.openclaw\skills"
git clone https://github.com/breezePeak/li_shang_wang_lai.git "$env:USERPROFILE\.openclaw\skills\li-shang-wang-lai"
cd "$env:USERPROFILE\.openclaw\skills\li-shang-wang-lai"
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

## 首次初始化

```bash
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

`npm run auth` 会打开浏览器检测抖音登录态。检测到已登录后自动关闭浏览器并返回认证成功；60 秒未检测到登录态时提示扫码登录；最多等待 5 分钟。

## 常用入口命令

| 功能 | 命令 |
|---|---|
| 登录认证 | `npm run auth` |
| 初始化数据库 | `npm run db:init` |
| 清空表数据 | `npm run db:reset`（交互选择表），`--all` 全部，`--force` 跳过确认 |
| 只看互动 | `npm run interactions:scan -- --type all --days 7 --max-count 100 --display-only` |
| 扫描并生成待回评 | `npm run interactions:scan -- --type comment --days 7 --max-count 100 --generate-reply-json` |
| 扫描并生成待回访 | `npm run interactions:scan -- --type all --days 7 --max-count 100 --generate-visit-json` |
| 填写评论回复 | Agent 生成并填写 `data/pending-replies/pending-comments-xxx.json` 的 `reply_text` |
| 批量准备评论回复 | `npm run comments:prepare -- --items-file data/pending-replies/pending-comments-xxx.json` |
| 批量执行评论回复 | `npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json` |
| 准备回访 | `npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json` |
| 执行回访 | `npm run return-visit:execute -- --execute` |
| 运行默认测试 | `npm test` |

完整命令参数见 `docs/COMMANDS.md`。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
