# 礼尚往来主入口 Skill

## 1. 项目定位

这是“礼尚往来”抖音创作者互动助手的 Hermes / OpenClaw 主入口 Skill。

本项目通过 Playwright 和本地 CLI 帮助创作者处理抖音互动：扫描评论和点赞互动，准备评论回复，执行已确认的评论回复，准备回访任务，并在用户确认后执行回访。

## 2. 根目录 skill.md 的职责

本文件只负责入口调度，不负责完整教程，不复制具体业务流程。

- 安装、更新、卸载、依赖安装、环境准备：阅读并遵循 `README.md`。
- 命令索引、参数说明、脚本入口：优先查看 `docs/COMMANDS.md`，必要时核对 `package.json` scripts。
- 互动采集、评论回复、回访、评论建议生成：转到 `skills/` 目录下的专门 Skill。
- 不要把安装文档、互动流程、评论回复流程、回访流程全部塞进本文件。
- 不要凭记忆判断项目状态；必须读取当前文件和实际命令结果。

## 3. 用户意图路由规则

### 安装、更新、卸载、依赖、环境准备

当用户说“安装这个技能”“怎么安装”“更新一下”“卸载”“依赖没装”“环境准备”等，先阅读 `README.md`，按 README 中 Hermes / OpenClaw 的安装位置和命令执行。

不要凭空编安装步骤。不要根据记忆说“已经安装好了”。

### 安装是否成功、当前状态

当用户说“安装好了吗”“现在状态怎样”“检查一下”等，必须实际检查：

- 当前目录是否是项目根目录。
- 是否存在 `package.json`、`README.md`、`skill.md`、`skills.json`、`skills/`、`docs/COMMANDS.md`。
- `package.json` 是否包含关键 scripts，例如 `auth`、`db:init`、`interactions:scan`、`comments:prepare`、`comments:execute`、`return-visit:prepare`、`return-visit:execute`。
- `node_modules/` 是否存在，依赖是否已安装。
- Node/npm 是否可用。

检查后基于证据回答，不要说“根据我的记忆”。

### 开始认证、扫码登录、登录抖音

当用户说“开始认证”“扫码登录”“登录抖音”“重新登录”等：

1. 先确认当前位于项目目录；如果不是，切换到 README 中对应的安装目录。
2. 查看 `package.json` 中的 `auth` script。
3. 执行 `package.json` 里的认证脚本，当前为 `npm run auth`。
4. 如果执行失败，读取错误输出并继续诊断，不要只重复“正在执行”。

认证入口的具体脚本以 `src/auth-douyin.mjs` 和 `docs/COMMANDS.md` 为准。

### 浏览器没弹出来

当用户说“浏览器没弹出来”“没有弹窗”“还没让我认证呢”“还是没有弹出来”等，进入认证诊断，不要重复说“这次真的来”。

至少检查：

- 当前是否在项目目录。
- Node/npm 是否可用。
- 依赖是否安装。
- Playwright Chromium 是否安装。
- 当前运行环境是否支持 GUI 浏览器窗口。
- `npm run auth` 的真实错误输出。

根据错误继续诊断；如果是 GUI 不可用或浏览器依赖缺失，要明确说明证据和下一步。

### 扫描互动、采集互动

当用户说“扫描互动”“采集互动”“扫描评论”“扫描点赞”“采集通知”等，路由到互动采集相关流程。

具体步骤以 `skills/creator-interaction-executor/SKILL.md` 和 `docs/COMMANDS.md` 为准。命令细节优先核对 `docs/COMMANDS.md` 和 `package.json` scripts。

### 生成回复、回复评论

当用户说“生成回复”“回复评论”“准备评论回复”“执行评论回复”等，路由到评论回复相关流程。

评论文案生成必须遵守 `skills/creator-comment-suggestion/SKILL.md`。评论回复执行流程以 `skills/creator-interaction-executor/SKILL.md`、`docs/COMMANDS.md` 和当前 CLI 为准。

### 回访、点赞评论

当用户说“回访”“开始回访”“点赞评论”“执行回访”等，路由到回访相关流程。

回访规则以 `skills/creator-interaction-executor/SKILL.md` 为准。不能凭空生成评论，不能只点赞，不能跳过回访准备阶段直接执行回访。

### 有哪些命令

当用户问“有哪些命令”“怎么运行”“命令参数是什么”等，查看 `docs/COMMANDS.md` 或 `package.json` scripts 后回答。

## 4. 执行原则

- 不要根据记忆判断安装状态。
- 不要说“正在执行”但不调用命令。
- 不要只输出命令让用户自己执行，除非用户明确要求手动命令。
- 执行 npm 命令前，必须先确认当前位于项目目录。
- 如果当前目录不是项目目录，需要切换到正确安装目录。
- 如果命令失败，要根据错误继续诊断，而不是重复同一句话。
- 如果浏览器没有弹出，要检查运行环境是否支持 GUI、Playwright Chromium 是否安装、Node/npm 是否正常。
- 真实点赞、评论、回复等平台动作必须遵循子 Skill 和 CLI 的确认规则，不要绕过登录、验证码、滑块或平台风控。

## 5. 认证入口

“开始认证 / 登录 / 扫码登录”是高频入口，但本文件只保留最小调度说明：

- 进入项目目录。
- 读取 `package.json` 的 `auth` script。
- 执行 `npm run auth`。
- 如果失败，读取错误并诊断。

不要在本文件堆叠所有认证排查命令；必要时查看 `src/auth-douyin.mjs`、`docs/COMMANDS.md` 和 README。

## 6. 主流程摘要

完整互动流程通常是：

```text
采集互动数据 -> 生成回复建议 -> 执行评论回复 -> 准备回访 -> 执行回访
```

这只是摘要。具体流程、状态流转、审批要求和命令参数必须转到 `skills/` 下对应 Skill，并核对 `docs/COMMANDS.md`。

## 7. 回访提醒

回访规则以回访相关 Skill 为准。不能凭空生成评论，不能只点赞，不能跳过准备阶段，也不能在信息不足、页面异常或状态不确定时继续执行。
