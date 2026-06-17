[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-3C873A.svg)](https://nodejs.org/)
[![LINUX DO](https://img.shields.io/badge/LINUX-DO-FFB003.svg)](https://linux.do)

# 礼尚往来 · li_shang_wang_lai

基于 Node.js、Playwright 和 SQLite 的抖音创作者互动助手。

## 初衷
每天下班路上总是边走边头看某音,看看谁和我互动了， 然后回评回访一下。但是，随着好友增多，互动量越来越大，走到家还没回访完，所以我决定做个工具，让它帮我回一些不是那么重要的评论以及回访。


## 项目定位

- 扫描抖音通知页中的真实点赞与评论
- 只处理“别人评论了我的作品”这类可回评对象
- 借助 Hermes / OpenClaw / Direct API 生成回评文案
- 在回评异常时支持人工介入、重置待执行、忽略锁定
- 按规则对好友或互关用户执行作品回访
- 用本地控制台统一查看扫描、回评、回访三条时间线

## 适合谁

- 想把“回评 + 回访”流程做成可重复工具的创作者
- 想研究 Playwright + SQLite + 本地自动化工作流的人
- 想给 Hermes / OpenClaw Skill 生态提供可复用项目样板的人

## 不适合什么

- 不适合刷量、引流、群控、批量互关
- 不承诺绕过风控
- 不承诺对任意平台变更长期稳定

## 功能概览

| 模块 | 能力 |
|---|---|
| 互动扫描 | 从通知页抓取点赞/评论，去重并落库 |
| 回评执行 | 为待回评评论生成回复，并以 API 成功回执为准确认发送结果 |
| 异常处理 | 支持把异常评论重置为 `pending`，或忽略为 `skipped`；已忽略/已成功状态会锁定 |
| 回访流程 | 基于互动关系和作品上下文，生成并执行回访任务 |
| Web 控制台 | 查看扫描时间表、回评时间表、回访时间表与异常卡片 |
| 本地存储 | 使用 SQLite 保存评论、任务、作品、状态流转 |

## 环境要求

| 环境 | 要求 |
|---|---|
| Node.js | 24+ |
| npm | 随 Node.js 安装 |
| 浏览器 | Playwright Chromium |
| 数据库 | SQLite |
| 账号 | 抖音创作者账号，需完成浏览器登录 |

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/breezePeak/li_shang_wang_lai.git
cd li_shang_wang_lai
```

### 2. 安装依赖

```bash
npm install
npx playwright install chromium
```

### 3. 初始化数据库

```bash
npm run db:init
```

### 4. 登录账号

```bash
npm run auth
```

`npm run auth` 会先检查登录态；未登录时才打开浏览器等待扫码，最长等待 5 分钟。

### 5. 开始跑一轮最小流程

```bash
npm run interactions:scan -- --hours 6
npm run comments:execute
npm run visit:run -- --execute
```

## Skill / 引擎安装

如果你是把它作为 Hermes / OpenClaw Skill 使用，可以放到这些目录：

| 引擎 | 安装目录 |
|---|---|
| Hermes (macOS/Linux) | `~/.hermes/skills/li-shang-wang-lai` |
| Hermes (Windows) | `$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai` |
| OpenClaw (macOS/Linux) | `~/.openclaw/skills/li-shang-wang-lai` |
| OpenClaw (Windows) | `$env:USERPROFILE\.openclaw\skills\li-shang-wang-lai` |

示例：

```bash
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.hermes/skills/li-shang-wang-lai
cd ~/.hermes/skills/li-shang-wang-lai
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

## 常用命令

| 功能 | 命令 |
|---|---|
| 登录认证 | `npm run auth` |
| 初始化数据库 | `npm run db:init` |
| 清空表数据 | `npm run db:reset` |
| 只看互动 | `npm run interactions:scan -- --display-only` |
| 扫描互动入库 | `npm run interactions:scan -- --days 7` |
| 扫描最近几小时 | `npm run interactions:scan -- --hours 6` |
| 评论回复 | `npm run comments:execute` |
| 准备回访任务 | `npm run interactions:scan -- --days 7 --prepare-visits` |
| 执行回访 | `npm run visit:run -- --execute` |
| 三条主链路调试 | 在扫描 / 回评 / 回访命令后追加 `--debug` |
| 启动控制台 | `npm run server` |
| 运行测试 | `npm test` |

完整参数见 [docs/COMMANDS.md](docs/COMMANDS.md)，完整 Skill 约束见 [SKILL.md](SKILL.md)。

## Web 控制台

启动方式：

```bash
npm run server
```

默认地址：

```text
http://localhost:3000
```

控制台目前主要覆盖：

- 扫描时间表
- 回评时间表
- 回访时间表
- 异常卡片处理
- 回评详情与回访详情

## 浏览器模式

项目默认使用有头浏览器，方便登录、观察页面变化和人工接管。

- 临时启用无头模式：在命令后追加 `--headless`
- 长期启用无头模式：在 `config/local.json` 中设置 `"browser": { "headless": true }`
- CLI 参数优先于配置文件；不传时默认仍是 `false`

示例：

```bash
npm run interactions:scan -- --days 7 --headless
npm run comments:execute -- --headless
npm run visit:run -- --execute --headless
```

## 调试取证

扫描、回评、回访三个主执行命令都支持 `--debug`：

```bash
npm run interactions:scan -- --days 7 --debug
npm run comments:execute -- --debug
npm run visit:run -- --execute --debug
```

开启后会在 `data/runs/<runId>/debug/` 下保存：

- `logs/execution.log`：完整执行日志
- `steps/<序号>_<步骤名>/dom.html`：当前页面 DOM 快照
- `steps/<序号>_<步骤名>/screenshot.png`：当前页面截图
- `steps/<序号>_<步骤名>/step.json`：步骤时间、URL、动作参数摘要

## Agent 配置

默认不设置任何新环境变量时，仍然走现有 CLI 调用，不会自动切到 API 或 direct-api。

三种模式：

- `CLI`
  - `AGENT_TRANSPORT=cli`
  - 默认模式
  - 直接调用 `hermes chat` / `openclaw chat`
- `Hermes API`
  - `AGENT_TRANSPORT=api`
  - 调用本机 `hermes gateway`
  - 使用 `HERMES_API_KEY`
- `Direct API`
  - `AGENT_TRANSPORT=direct-api`
  - 直接调用模型供应商的 OpenAI-compatible `/v1/chat/completions`
  - 使用 `DIRECT_API_KEY`

示例：

```bash
npm run comments:execute
```

```bash
AGENT_PROVIDER=openclaw npm run comments:execute
```

Windows PowerShell：

```powershell
$env:AGENT_PROVIDER="openclaw"
npm run comments:execute
```

```powershell
$env:AGENT_TRANSPORT="api"
$env:HERMES_API_BASE_URL="http://127.0.0.1:8642/v1"
$env:HERMES_API_KEY="和 Hermes 本地 API_SERVER_KEY 相同"
$env:HERMES_API_MODEL="hermes-agent"
npm run comments:execute
```

```powershell
$env:AGENT_TRANSPORT="direct-api"
$env:DIRECT_API_PROVIDER="openrouter"
$env:DIRECT_API_BASE_URL="https://openrouter.ai/api/v1"
$env:DIRECT_API_KEY="<模型供应商 API key>"
$env:DIRECT_API_MODEL="<模型名>"
npm run comments:execute -- --agent-only
```

更多配置细节保留在旧文档和 Skill 内：

- [SKILL.md](SKILL.md)
- [references/comment-safety-rules.md](references/comment-safety-rules.md)

## 项目结构

```text
src/
  adapters/      页面交互与平台适配
  cli/           扫描、回评、回访等命令入口
  db/            SQLite 表、迁移与仓储
  services/      业务流程编排
  agent/         Hermes / OpenClaw / Direct API 集成
public/          Web 控制台静态资源
tests/unit/      单元测试
docs/            补充文档
references/      规则与参考资料
```

## 文档边界

- `README.md`：项目介绍、安装方式、环境要求、命令速查
- `SKILL.md`：主 Skill，完整互动流程与 Agent 约束
- `references/comment-safety-rules.md`：评论安全规则
- `docs/COMMANDS.md`：命令参考手册

## 开源说明

本项目以 [Apache License 2.0](LICENSE) 开源。

你可以：

- 使用
- 修改
- 分发
- 在保留许可证与声明的前提下二次开发

提交贡献前建议先阅读：

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CHANGELOG.md](CHANGELOG.md)

## 免责声明

本项目仅用于辅助创作者处理正常互动，不用于刷量、引流、骚扰、批量互关或规避平台规则。

使用本项目时，请遵守平台规则和相关法律法规。因账号操作、平台风控、规则变化或不当使用造成的风险，由使用者自行承担。
