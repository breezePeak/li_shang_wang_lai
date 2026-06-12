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

```bash
# 默认 Hermes
npm run comments:execute -- --days 7 --limit 50
```

```bash
# 切换 OpenClaw
AGENT_PROVIDER=openclaw npm run comments:execute -- --days 7 --limit 50
```

Windows PowerShel：

```powershell
$env:AGENT_PROVIDER="openclaw"; npm run comments:execute -- --days 7 --limit 50
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_PROVIDER` | `hermes` | 可选 `hermes` / `openclaw` |
| `HERMES_BIN` | `hermes` | Hermes 命令路径 |
| `OPENCLAW_BIN` | `openclaw` | OpenClaw 命令路径 |
| `HERMES_ARGS` | `chat -Q -q {prompt}` | Hermes 参数模板 |
| `OPENCLAW_ARGS` | `chat -Q -q {prompt}` | OpenClaw 参数模板 |
| `COMMENT_MAX_LENGTH` | `30` | 回访评论最大长度 |
| `REPLY_MIN_LENGTH` | `15` | 回评回复最小长度 |
| `REPLY_MAX_LENGTH` | `60` | 回评回复最大长度 |
| `AGENT_TIMEOUT_MS` | `60000` | 通用超时 |

## Agent 传输模式

默认不设置任何新变量时，仍然使用现有 CLI 调用 `hermes` / `openclaw`，主流程行为不变。

```bash
# 默认 CLI
npm run comments:execute -- --days 7 --limit 50
```

```bash
# 配置 Hermes WebSocket 常驻调用
HERMES_WS_URL=ws://127.0.0.1:3001 npm run comments:execute -- --days 7 --limit 50
HERMES_WS_URL=ws://127.0.0.1:3001 npm run visit:run -- --execute
```

`HERMES_WS_URL` 必须指向 Hermes 自身提供的 WebSocket 常驻服务，不是本项目的 `npm run agent-server`。当前 `agent-server` 仅提供 HTTP 调试接口（`/generate-comment`、`/generate-reply`、`/generate-replies`、`/health`），不实现 `agent.prompt` WebSocket 协议。

```bash
# 强制退回 CLI
AGENT_TRANSPORT=cli npm run comments:execute -- --days 7 --limit 50
```

```bash
# 强制 WebSocket 且关闭 fallback
AGENT_TRANSPORT=ws AGENT_WS_FALLBACK=none HERMES_WS_URL=ws://127.0.0.1:3001 npm run comments:execute -- --days 7 --limit 50
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_TRANSPORT` | 自动判断 | `cli` / `ws`。未设置且存在 `HERMES_WS_URL` 时默认优先 `ws` |
| `HERMES_WS_URL` | `''` | Hermes WebSocket 地址，例如 `ws://127.0.0.1:3001`；需连接外部 Hermes WS 服务，不是 `npm run agent-server` |
| `AGENT_WS_TIMEOUT_MS` | `60000` | WebSocket 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `AGENT_WS_FALLBACK` | `cli` | `cli` / `none`。WebSocket 失败时默认自动回退到原 CLI |
| `REPLY_BATCH_SIZE` | `8` | 回评批量生成时每批请求条数 |

## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、命令速查。
- `SKILL.md`：主 Skill，完整互动流程与 Agent 约束。
- `references/comment-safety-rules.md`：评论安全规则。
- `docs/COMMANDS.md`：命令参考手册。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
