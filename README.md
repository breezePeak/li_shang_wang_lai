# 礼尚往来 · li_shang_wang_lai

基于 Node.js、Playwright 和 SQLite 的抖音创作者互动助手，支持 Hermes / OpenClaw Skill 加载。

## 环境要求

| 环境 | 要求 |
|---|---|
| Node.js | 20+ |
| npm | 随 Node.js 安装 |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 账号 | 抖音创作者账号，需完成浏览器登录 |

## Skill 入口

- 主 Skill：`SKILL.md`
- 规则文件：`references/comment-safety-rules.md`

## 安装

```bash
# 以 Hermes 为例，OpenClaw 替换目录即可
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.hermes/skills/li-shang-wang-lai
cd ~/.hermes/skills/li-shang-wang-lai
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

| 引擎 | 安装目录 |
|---|---|
| Hermes (macOS/Linux) | `~/.hermes/skills/li-shang-wang-lai` |
| Hermes (Windows) | `$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai` |
| OpenClaw (macOS/Linux) | `~/.openclaw/skills/li-shang-wang-lai` |
| OpenClaw (Windows) | `$env:USERPROFILE\.openclaw\skills\li-shang-wang-lai` |

`npm run auth` 先以 headless 检查登录态，已登录直接返回；未登录才弹出浏览器供扫码，最多等待 5 分钟。

## 常用命令

| 功能 | 命令 |
|---|---|
| 登录认证 | `npm run auth` |
| 初始化数据库 | `npm run db:init` |
| 清空表数据 | `npm run db:reset` |
| 只看互动 | `npm run interactions:scan -- --display-only` |
| 扫描互动入库 | `npm run interactions:scan -- --days 7 --max-count 50` |
| 评论回复 | `npm run comments:execute -- --days 7 --limit 50` |
| 准备回访任务 | `npm run interactions:scan -- --days 7 --max-count 50 --prepare-visits` |
| 执行回访 | `npm run visit:run -- --execute` |
| 运行测试 | `npm test` |

完整参数见 `docs/COMMANDS.md`，流程细节见 `SKILL.md`。

## Agent 配置

默认不设置任何新环境变量时，仍然走现有 CLI 调用。

简单理解：

- `CLI`：每次需要生成评论时，项目直接调用一次 `hermes chat` 或 `openclaw chat`。这是默认模式，开箱即用。
- `API`：如果你本机已经手动启动了 Hermes 的常驻服务，项目就不必每次都重新拉起 Hermes，批量生成时会更快。这就是“API 加速”。
- 不想折腾就什么都别配，继续用默认 `CLI` 就行。

```bash
# 默认 Hermes
npm run comments:execute -- --days 7 --limit 50
```

```bash
# 切换 OpenClaw
AGENT_PROVIDER=openclaw npm run comments:execute -- --days 7 --limit 50
```

Windows PowerShell：

```powershell
$env:AGENT_PROVIDER="openclaw"
npm run comments:execute -- --days 7 --limit 50
```

```powershell
# 强制 CLI
$env:AGENT_TRANSPORT="cli"
npm run comments:execute -- --days 7 --limit 50
```

```powershell
# 可选 Hermes API Server 加速
$env:AGENT_TRANSPORT="api"
$env:HERMES_API_BASE_URL="http://127.0.0.1:8642/v1"
$env:HERMES_API_KEY="和 Hermes 本地 API_SERVER_KEY 相同"
$env:HERMES_API_MODEL="hermes-agent"

npm run comments:execute -- --days 7 --limit 50
```

如果你要启用 API 加速，按这个顺序理解就够了：

1. 默认模式已经能用，不需要配 API。
2. 只有你自己手动启动了 `hermes gateway`，`AGENT_TRANSPORT=api` 才有意义。
3. `HERMES_API_KEY` 不是模型厂商的 key，它只是你本机 Hermes API Server 的访问口令。
4. API 模式失败时，默认会自动退回 CLI，不会直接把流程卡死。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_PROVIDER` | `hermes` | 可选 `hermes` / `openclaw` |
| `AGENT_TRANSPORT` | `cli` | 可选 `cli` / `api` |
| `HERMES_BIN` | `hermes` | Hermes 命令路径 |
| `OPENCLAW_BIN` | `openclaw` | OpenClaw 命令路径 |
| `HERMES_ARGS` | `chat -Q -q {prompt}` | Hermes 参数模板 |
| `OPENCLAW_ARGS` | `chat -Q -q {prompt}` | OpenClaw 参数模板 |
| `HERMES_API_BASE_URL` | `http://127.0.0.1:8642/v1` | Hermes 本地 API Server 地址 |
| `HERMES_API_KEY` | `''` | Hermes 本地 API Server 的 Bearer token；未设置时会尝试读取本地 `.env` 中的 `API_SERVER_KEY` |
| `HERMES_API_MODEL` | `hermes-agent` | API 模式使用的模型名 |
| `AGENT_API_TIMEOUT_MS` | `60000` | API 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `AGENT_API_FALLBACK` | `cli` | `cli` / `none`，API 失败时默认回退到 CLI |
| `COMMENT_MAX_LENGTH` | `30` | 回访评论最大长度 |
| `REPLY_MIN_LENGTH` | `15` | 回评回复最小长度 |
| `REPLY_MAX_LENGTH` | `60` | 回评回复最大长度 |
| `AGENT_TIMEOUT_MS` | `60000` | 通用超时 |
| `REPLY_BATCH_SIZE` | `8` | 回评批量生成时每批请求条数 |

Hermes API Server 是可选加速模式，不是安装必需项。需要用户自己配置并手动启动 `hermes gateway`；如果 API 不可用，默认会 fallback 回 CLI。

## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、命令速查。
- `SKILL.md`：主 Skill，完整互动流程与 Agent 约束。
- `references/comment-safety-rules.md`：评论安全规则。
- `docs/COMMANDS.md`：命令参考手册。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
