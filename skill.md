# 礼尚往来主入口 Skill

## 职责

这是 `li_shang_wang_lai` 的 Hermes / OpenClaw 主入口 Skill，只负责识别用户意图并路由到正确文件或子 Skill。

本文件不写完整安装教程、不写详细互动流程、不写评论生成细则。回答或执行前必须读取当前真实文件和命令结果，不能凭记忆补流程。

## 文档路由

- 安装、环境要求、首次初始化、常用入口命令：读取 `README.md`。
- 命令参数、默认值、兼容入口、调试入口：读取 `docs/COMMANDS.md`，必要时核对 `package.json` scripts。
- 互动执行流程：读取 `skills/creator-interaction-executor/SKILL.md`。
- 评论回复建议生成：读取 `skills/creator-comment-suggestion/SKILL.md`。

## 意图路由

### 安装、更新、卸载、依赖、环境准备

先读取 `README.md`，按当前 README 中的安装路径和命令执行。不要凭空编安装步骤。

### 检查状态

必须实际检查：

- 当前目录是否是项目根目录。
- 是否存在 `package.json`、`README.md`、`skill.md`、`skills.json`、`skills/`、`docs/COMMANDS.md`。
- `package.json` scripts 是否包含 `auth`、`db:init`、`interactions:scan`、`actions:pending`、`comments:prepare`、`comments:execute-all`、`actions:reset-blocked`、`return-visit:prepare`、`return-visit:execute`。
- `node_modules/` 是否存在。
- Node/npm 是否可用。

### 登录认证

当用户说“开始认证”“扫码登录”“登录抖音”“重新登录”等：

1. 确认当前在项目目录。
2. 读取 `package.json` 的 `auth` script。
3. 执行当前认证入口，现为 `npm run auth`。
4. 如果失败，读取真实错误并继续诊断。

认证细节以 `src/auth-douyin.mjs` 和 `docs/COMMANDS.md` 为准。

### 扫描互动、采集互动、回复评论、回访

路由到 `skills/creator-interaction-executor/SKILL.md`，并核对 `docs/COMMANDS.md` 与 `package.json` scripts。

### 生成评论回复建议

路由到 `skills/creator-comment-suggestion/SKILL.md`。该 Skill 只输出一条回复，不负责执行命令。

### 查询命令

读取 `docs/COMMANDS.md` 或 `package.json` scripts 后回答。

## 当前主流程摘要

主流程必须以真实 CLI 为准。当前项目保留的主流程是：

```text
评论回复：interactions:scan -> actions:pending -> comments:prepare -> comments:execute-all --execute
回访：interactions:scan -> return-visit:prepare -> return-visit:execute --execute
```

没有 `--execute` 时不得执行真实点赞、评论或回复。

旧回赞、旧手动审批、旧二次确认、旧导出应用链路不得作为主流程入口；它们如仍存在，只能按 `docs/COMMANDS.md` 中的兼容或调试分类处理。

## 执行原则

- 不要根据记忆判断安装状态或流程。
- 不要说“正在执行”但不调用命令。
- 执行 npm 命令前先确认当前位于项目目录。
- 命令失败后必须读取错误并诊断。
- 不绕过登录、验证码、滑块或平台风控。
- 真实动作必须遵循 CLI 的 `--execute` 门禁、状态判断、重复判断和失败阻断。
