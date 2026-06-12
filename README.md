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

### 默认模式：CLI

安装 Skill 后默认可用，不需要配置 Hermes API Server，不需要 `API_SERVER_KEY`。

```bash
npm run comments:execute -- --days 7 --limit 50
npm run visit:run -- --execute
```

默认仍然调用 `hermes chat -Q -q {prompt}` 或 `openclaw chat -Q -q {prompt}`。优点是零额外配置；缺点是每次生成都会重新初始化 Hermes，批量时较慢。

### 可选加速模式：Hermes API Server

Hermes API Server 是用户手动启用的本机常驻 HTTP 服务，不是默认安装步骤，也不是本项目必需项。只有显式设置 `AGENT_TRANSPORT=api` 时，项目才会尝试走 API 模式；API 失败时默认 fallback 到现有 CLI。

Windows 可以先编辑 Hermes 本地配置：

```powershell
notepad "$env:LOCALAPPDATA\hermes\.env"
```

加入：

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=自己生成的本地访问口令
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

然后手动启动 Hermes gateway：

```bash
hermes gateway
```

项目侧启用 API 模式：

```powershell
$env:AGENT_TRANSPORT="api"
$env:HERMES_API_BASE_URL="http://127.0.0.1:8642/v1"
$env:HERMES_API_KEY="和 API_SERVER_KEY 相同"
$env:HERMES_API_MODEL="hermes-agent"

npm run comments:execute -- --days 7 --limit 5 --agent-only
```

如果未设置 `HERMES_API_KEY`，项目会尝试只读读取 Hermes 本地 `.env` 中的 `API_SERVER_KEY`。但这不会自动切换到 API 模式，你仍然需要显式设置 `AGENT_TRANSPORT=api`，并手动启动 `hermes gateway`。

`API_SERVER_KEY` 不是 OpenAI / Anthropic / OpenRouter 之类模型供应商的 API key。它是你为本机 Hermes API Server 设置的 Bearer token。Hermes 再用自己的模型供应商 key 去调模型；本项目只用 `HERMES_API_KEY` 去访问你本机的 Hermes API Server。

健康检查：

```powershell
$apiKey = "li-shang-wang-lai-local-dev"

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8642/health" `
  -Headers @{ Authorization = "Bearer $apiKey" }
```

生成测试：

```powershell
$apiKey = "li-shang-wang-lai-local-dev"

$body = @{
  model = "hermes-agent"
  stream = $false
  messages = @(
    @{
      role = "user"
      content = '只返回 JSON：{"comment":"ok"}'
    }
  )
} | ConvertTo-Json -Depth 10

$r = Invoke-RestMethod `
  -Uri "http://127.0.0.1:8642/v1/chat/completions" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $apiKey" } `
  -ContentType "application/json" `
  -Body $body

$r.choices[0].message.content
```

API fallback 测试：

```powershell
$env:AGENT_TRANSPORT="api"
$env:HERMES_API_BASE_URL="http://127.0.0.1:39999/v1"
$env:HERMES_API_KEY="wrong-local-test"
$env:AGENT_API_TIMEOUT_MS="2000"

npm run comments:execute -- --days 7 --limit 5 --agent-only
```

预期日志包含：

```text
[agent] api generateReplies failed, fallback to cli reason=...
```

### 预留模式：WebSocket adapter

WebSocket provider 仍然保留，作为未来外部 adapter 的预留模式。注意：

- Hermes 当前没有 `hermes ws` 命令。
- `hermes acp` 是 editor/ACP 的 stdio 模式，不是 WebSocket 端口服务。
- `HERMES_WS_URL` 仅用于连接外部兼容 `agent.prompt` 协议的 WebSocket adapter，不直接连接 `hermes acp`。
- `npm run agent-server` 也不是 WebSocket provider，它只提供 HTTP 调试接口。

```bash
# 强制 CLI
AGENT_TRANSPORT=cli npm run comments:execute -- --days 7 --limit 50

# 显式 API，失败时默认回退 CLI
AGENT_TRANSPORT=api HERMES_API_BASE_URL=http://127.0.0.1:8642/v1 HERMES_API_KEY=local-token npm run comments:execute -- --days 7 --limit 50

# 显式 API 且关闭 fallback
AGENT_TRANSPORT=api AGENT_API_FALLBACK=none HERMES_API_BASE_URL=http://127.0.0.1:8642/v1 HERMES_API_KEY=local-token npm run comments:execute -- --days 7 --limit 50

# 显式 WebSocket
AGENT_TRANSPORT=ws HERMES_WS_URL=ws://127.0.0.1:3001 npm run comments:execute -- --days 7 --limit 50
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_TRANSPORT` | 自动判断 | `cli` / `api` / `ws`。未设置且存在 `HERMES_WS_URL` 时默认优先 `ws`，否则走 `cli` |
| `HERMES_API_BASE_URL` | `http://127.0.0.1:8642/v1` | 本机 Hermes API Server 的 `/v1` 根路径 |
| `HERMES_API_KEY` | `''` | 访问本机 Hermes API Server 的 Bearer token；未设置时会尝试只读读取 Hermes 本地 `.env` 中的 `API_SERVER_KEY` |
| `HERMES_API_MODEL` | `hermes-agent` | API 模式下传给 Hermes gateway 的模型名 |
| `AGENT_API_TIMEOUT_MS` | `60000` | API 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `AGENT_API_FALLBACK` | `cli` | `cli` / `none`。API 失败时默认自动回退到原 CLI |
| `HERMES_WS_URL` | `''` | 外部兼容 `agent.prompt` 协议的 WebSocket adapter 地址 |
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
