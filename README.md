# 礼尚往来 · li_shang_wang_lai

基于 Node.js、Playwright 和 SQLite 的抖音创作者互动助手，支持 Hermes / OpenClaw Skill 加载。

项目用于辅助创作者扫描互动、生成并执行评论回复、生成并执行回访点赞 + 评论。浏览器控制由 CLI 完成；评论/回复文本由 CLI 在进程内直接调用 Hermes 或 OpenClaw 生成。评论回复默认真实执行；回访需 `--execute`。


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
| 扫描互动入库 | `npm run interactions:scan -- --days 7 --max-count 50` |
| 生成并执行评论回复 | `npm run comments:execute -- --days 7 --limit 50` |
| 只生成评论回复不执行 | `npm run comments:execute -- --days 7 --limit 50 --agent-only` |
| 扫描并准备待回访任务 | `npm run interactions:scan -- --days 7 --max-count 50 --prepare-visits` |
| 执行回访 | `npm run visit:run -- --execute` |
| 运行默认测试 | `npm test` |

完整命令参数见 `docs/COMMANDS.md`。

`interactions:scan` 查询待回评或待回访范围时必须手动输入 `--days` 和 `--max-count`，例如 `--days 7 --max-count 50`。扫描结果只写入数据库，不生成中间 JSON 文件。

`comments:execute` 默认从数据库查询待回评评论，必须手动输入 `--days` 和 `--limit`，直接调用 Hermes/OpenClaw 生成 `reply_text` 并写回 DB，然后打开待回复评论所属的抖音作品页，在作品评论区里定位目标评论；优先结合 `cid/comment_id` 与 `comment/list` 接口做精确确认，再在 DOM 中唯一定位后点击“回复”、填写、发送并校验结果，不再进入创作者评论管理页。

`visit:run` 会打开目标用户主页，监听主页作品列表 API，按 `workId` 匹配并点击目标作品，进入作品页后直接调用 Hermes/OpenClaw 生成回访评论，再由 CLI 填写并提交。Agent 不控制浏览器、不点击、不提交评论。

## Agent Provider

默认使用 Hermes：

```bash
npm run comments:execute -- --days 7 --limit 50
```

切换 OpenClaw：

```bash
AGENT_PROVIDER=openclaw npm run comments:execute -- --days 7 --limit 50
```

Windows PowerShell：

```powershell
$env:AGENT_PROVIDER="openclaw"; npm run comments:execute -- --days 7 --limit 50
```

`npm run agent-server` 仍保留为可选 HTTP 调试/外部集成入口，主流程不需要启动。

可配置环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_PROVIDER` | `hermes` | 可选 `hermes` / `openclaw` |
| `HERMES_BIN` | `hermes` | Hermes 命令路径 |
| `OPENCLAW_BIN` | `openclaw` | OpenClaw 命令路径 |
| `HERMES_ARGS` | `chat -Q -q {prompt}` | Hermes 参数模板，`{prompt}` 会替换为提示词 |
| `OPENCLAW_ARGS` | `chat -Q -q {prompt}` | OpenClaw 参数模板，`{prompt}` 会替换为提示词 |
| `AGENT_SERVER_PORT` | `3001` | agent-server 端口 |
| `COMMENT_MAX_LENGTH` | `30` | 默认评论/回复最大长度 |
| `AGENT_TIMEOUT_MS` | `60000` | 通用超时，优先级低于 provider 专用超时 |
| `HERMES_TIMEOUT_MS` | `60000` | Hermes 超时 |
| `OPENCLAW_TIMEOUT_MS` | `60000` | OpenClaw 超时 |


## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、首次初始化、常用入口命令。
- `SKILL.md`：Hermes / OpenClaw 主 Skill，直接描述完整互动主流程。
- `references/comment-safety-rules.md`：评论回复与回访评论共用的生成规则和安全边界。
- `docs/COMMANDS.md`：命令参考手册，和 `package.json` scripts、实际 CLI 参数保持一致。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
