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
- 如果别人问怎么获得这个技能，直接让他去 GitHub 搜索 `breezePeak/li_shang_wang_lai`

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
| 扫描互动入库 | `npm run interactions:scan -- --days 7` |
| 评论回复 | `npm run comments:execute -- --days 7 --limit 50` |
| 准备回访任务 | `npm run interactions:scan -- --days 7 --prepare-visits` |
| 执行回访 | `npm run visit:run -- --execute` |
| 运行测试 | `npm test` |

完整参数见 `docs/COMMANDS.md`，流程细节见 `SKILL.md`。

## 浏览器模式

项目默认使用有头浏览器，方便登录、观察页面变化和人工接管。

- 临时启用无头模式：在命令后追加 `--headless`
- 长期启用无头模式：在 `config/local.json` 中设置 `"browser": { "headless": true }`
- CLI 参数优先于配置文件；不传时默认仍是 `false`

常见示例：

```bash
npm run interactions:scan -- --days 7 --headless
npm run comments:execute -- --days 7 --limit 50 --headless
npm run visit:run -- --execute --headless
```

## Agent 配置

默认不设置任何新环境变量时，仍然走现有 CLI 调用，不会自动切到 API 或 direct-api。

三种模式的区别：

- `CLI`
  - `AGENT_TRANSPORT=cli`
  - 默认模式
  - 不需要任何 API 配置
  - 直接调用 `hermes chat` / `openclaw chat`
  - 最稳定，但每次会拉起一次 Agent 进程
- `Hermes API`
  - `AGENT_TRANSPORT=api`
  - 调用本机 `hermes gateway`
  - 使用 `HERMES_API_KEY`
  - `HERMES_API_KEY` 本质上等于 Hermes 本地 `.env` 里的 `API_SERVER_KEY`
  - 不是模型供应商 key
- `Direct API`
  - `AGENT_TRANSPORT=direct-api`
  - 直接调用模型供应商的 OpenAI-compatible `/v1/chat/completions`
  - 使用 `DIRECT_API_KEY`
  - `DIRECT_API_KEY` 是模型供应商 API key，不是 `API_SERVER_KEY`
  - 不经过 Hermes gateway
  - 只会手动注入 `SOUL.md`、`references/comment-safety-rules.md` 和评论上下文
  - 不会自动加载 Hermes memory / skills / tools

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

```powershell
# direct-api：优先读 DIRECT_API_*，其次尝试读 Hermes 本地 .env 里的供应商 key / model
$env:AGENT_TRANSPORT="direct-api"

# 如果 Hermes .env 里已经有 OPENROUTER_API_KEY / HERMES_INFERENCE_MODEL，
# 可以先只设置 transport。自动推断不出来时，再显式补下面三项：
$env:DIRECT_API_PROVIDER="openrouter"
$env:DIRECT_API_BASE_URL="https://openrouter.ai/api/v1"
$env:DIRECT_API_KEY="<模型供应商 API key>"
$env:DIRECT_API_MODEL="<模型名>"

npm run comments:execute -- --days 7 --limit 20 --agent-only
```

如果你要启用 Hermes API 加速，按这个顺序理解就够了：

1. 默认模式已经能用，不需要配 API。
2. 只有你自己手动启动了 `hermes gateway`，`AGENT_TRANSPORT=api` 才有意义。
3. `HERMES_API_KEY` 不是模型厂商的 key，它只是你本机 Hermes API Server 的访问口令。
4. API 模式失败时，默认会自动退回 CLI，不会直接把流程卡死。

如果你要启用 direct-api，按这个顺序理解就够了：

1. 必须显式设置 `AGENT_TRANSPORT=direct-api` 才会启用。
2. `direct-api` 会优先读 `DIRECT_API_*`，其次读取 Hermes 本地 `.env` 中的供应商 key / 模型配置。
3. `direct-api` 不会使用 `HERMES_API_KEY`，也不会使用 `API_SERVER_KEY` 作为模型 key。
4. `direct-api` 默认失败后会 fallback 回 CLI；设置 `DIRECT_API_FALLBACK=none` 可关闭 fallback。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_PROVIDER` | `hermes` | 可选 `hermes` / `openclaw` |
| `AGENT_TRANSPORT` | `cli` | 可选 `cli` / `api` / `direct-api` |
| `HERMES_BIN` | `hermes` | Hermes 命令路径 |
| `OPENCLAW_BIN` | `openclaw` | OpenClaw 命令路径 |
| `HERMES_ARGS` | `chat -Q -q {prompt}` | Hermes 参数模板 |
| `OPENCLAW_ARGS` | `chat -Q -q {prompt}` | OpenClaw 参数模板 |
| `HERMES_API_BASE_URL` | `http://127.0.0.1:8642/v1` | Hermes 本地 API Server 地址 |
| `HERMES_API_KEY` | `''` | Hermes 本地 API Server 的 Bearer token；未设置时会尝试读取本地 `.env` 中的 `API_SERVER_KEY` |
| `HERMES_API_MODEL` | `hermes-agent` | API 模式使用的模型名 |
| `AGENT_API_TIMEOUT_MS` | `60000` | API 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `AGENT_API_FALLBACK` | `cli` | `cli` / `none`，API 失败时默认回退到 CLI |
| `DIRECT_API_PROVIDER` | 自动推断 | 可选 `openai` / `openrouter` / `deepseek` / `dashscope` / `qwen` |
| `DIRECT_API_BASE_URL` | 自动推断 | 模型供应商 `/v1` 根路径；不会读取 `HERMES_API_BASE_URL` |
| `DIRECT_API_KEY` | `''` | 模型供应商 API key；不会读取 `HERMES_API_KEY` 或 `API_SERVER_KEY` |
| `DIRECT_API_MODEL` | 自动推断 | direct-api 使用的模型名 |
| `DIRECT_API_TIMEOUT_MS` | `60000` | direct-api 请求超时，未设置时回退到 `AGENT_TIMEOUT_MS` |
| `DIRECT_API_TEMPERATURE` | `0.6` | direct-api 采样温度 |
| `DIRECT_API_MAX_TOKENS` | 自动计算 | 单条默认 256，批量按条数自动放大 |
| `DIRECT_API_FALLBACK` | `cli` | `cli` / `none`，direct-api 失败时默认回退到 CLI |
| `DIRECT_API_SOUL_PATH` | `''` | 手动指定 `SOUL.md` 路径 |
| `DIRECT_API_REQUIRE_SOUL` | `0` | 设为 `1` 时，找不到 `SOUL.md` 直接失败 |
| `COMMENT_MAX_LENGTH` | `30` | 回访评论最大长度 |
| `REPLY_MIN_LENGTH` | `15` | 回评回复最小长度 |
| `REPLY_MAX_LENGTH` | `60` | 回评回复最大长度 |
| `AGENT_TIMEOUT_MS` | `60000` | 通用超时 |
| `REPLY_BATCH_SIZE` | `8` | 回评批量生成时每批请求条数 |

`direct-api` 的配置读取优先级是：

1. 显式传入的 options
2. `process.env`
3. Hermes 本地 `.env`
4. provider 默认推断

Hermes 本地 `.env` 候选路径：

1. Windows：`%LOCALAPPDATA%\hermes\.env`
2. Windows：`%USERPROFILE%\.hermes\.env`
3. macOS / Linux：`~/.hermes/.env`

`SOUL.md` 会按下面顺序查找：

1. `options.soul`
2. `options.soulPath`
3. `DIRECT_API_SOUL_PATH`
4. 当前工作目录 `SOUL.md`
5. `%LOCALAPPDATA%\hermes\SOUL.md`
6. `%USERPROFILE%\.hermes\SOUL.md`
7. `~/.hermes/SOUL.md`

找不到 `SOUL.md` 时默认继续运行；设置 `DIRECT_API_REQUIRE_SOUL=1` 时会直接报错。

性能上，`direct-api` 只是绕过 Hermes CLI / gateway 编排，不会减少模型本身的推理耗时。是否明显加速，仍取决于模型响应速度、prompt 大小、批量大小和网络延迟。

Hermes API Server 是可选加速模式，不是安装必需项。需要用户自己配置并手动启动 `hermes gateway`；如果 API 不可用，默认会 fallback 回 CLI。

## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、命令速查。
- `SKILL.md`：主 Skill，完整互动流程与 Agent 约束。
- `references/comment-safety-rules.md`：评论安全规则。
- `docs/COMMANDS.md`：命令参考手册。

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
