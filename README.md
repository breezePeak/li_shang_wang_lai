# 礼尚往来 · li_shang_wang_lai

基于 Node.js、Playwright 和 SQLite 的抖音创作者互动助手，支持 Hermes / OpenClaw Skill 加载。

项目用于辅助创作者扫描互动、准备评论回复、准备回访任务，并在显式执行模式下完成评论回复或回访点赞 + 评论。评论回复默认真实执行；回访需 `--execute`。


## 环境要求

| 环境 | 要求 |
|---|---|
| Node.js | 20+ |
| npm | 随 Node.js 安装 |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 账号 | 抖音创作者账号，需完成浏览器登录 |

## Skill 入口

当前仓库按单 Skill 项目组织：仓库根目录就是 Skill 根，`SKILL.md` 和 `references/` 直接放在顶层。

- 主 Skill：`SKILL.md`
- 规则文件：`references/comment-safety-rules.md`

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

> **Agent 注意**：安装完成后，询问用户是否已完成登录认证。若用户尚未扫码登录，引导用户执行 `npm run auth` 并完成浏览器扫码。用户登录后，根据用户意图引导用户执行 `npm run interactions:scan`。

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

> **Agent 注意**：安装完成后，询问用户是否已完成登录认证。若用户尚未扫码登录，引导用户执行 `npm run auth` 并完成浏览器扫码。用户登录后，根据用户意图引导用户执行 `npm run interactions:scan`。

## 首次初始化

```bash
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

`npm run auth` 会打开浏览器检测抖音登录态。检测到已登录后自动关闭浏览器并返回认证成功；60 秒未检测到登录态时提示扫码登录；最多等待 5 分钟。

> **Agent 注意**：初始化完成后，询问用户是否已完成登录认证。若用户尚未扫码登录，引导用户执行 `npm run auth` 并完成浏览器扫码。用户登录后，根据用户意图引导用户执行 `npm run interactions:scan`。

## 常用入口命令

| 功能 | 命令 |
|---|---|
| 登录认证 | `npm run auth` |
| 初始化数据库 | `npm run db:init` |
| 清空表数据 | `npm run db:reset` |
| 只看互动 | `npm run interactions:scan -- --display-only` |
| 扫描并生成待回评 | `npm run interactions:scan -- --type comment --generate-reply-json` |
| 扫描并生成待回访 | `npm run interactions:scan -- --generate-visit-json` |
| 填写评论回复 | Agent 生成并填写 `data/pending-replies/pending-comments-xxx.json` 的 `reply_text` |
| 执行评论回复 | `npm run comments:execute -- --items-file data/pending-replies/pending-comments-xxx.json` |
| 准备回访 | `npm run return-visit:prepare -- --items-file data/pending-visits/pending-visits-xxx.json` |
| 执行回访 | `npm run return-visit:execute -- --execute --items-file data/pending-visits/pending-visit-comments-xxx.json` |
| 运行默认测试 | `npm test` |

完整命令参数见 `docs/COMMANDS.md`。

`comments:execute` 会直接打开待回复评论所属的抖音作品页，在作品评论区里定位目标评论；优先结合 `cid/comment_id` 与 `comment/list` 接口做精确确认，再在 DOM 中唯一定位后点击“回复”、填写 `reply_text`、发送并校验结果，不再进入创作者评论管理页。


## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、首次初始化、常用入口命令。
- `SKILL.md`：Hermes / OpenClaw 主 Skill，直接描述完整互动主流程。
- `references/comment-safety-rules.md`：评论回复与回访评论共用的生成规则和安全边界。
- `docs/COMMANDS.md`：命令参考手册，和 `package.json` scripts、实际 CLI 参数保持一致。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
