---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程，包括扫描互动、查看待处理任务、执行评论回复、准备回访任务、预演回访和执行回访。当用户提到礼尚往来、互动扫描、评论回复、批量回复、回访、点赞评论时使用此技能。
---

# 创作者互动执行

本技能用于执行 `li_shang_wang_lai` 项目的默认互动流程。

本技能只负责调用项目已有 CLI 命令，不直接编写 Playwright 脚本，不修改源码，不修改数据库结构，不自由生成评论内容，也不绕过平台登录、验证码、滑块或风控。

详细命令参数、配置说明和数据库状态说明应放在项目独立文档中，例如：

- `docs/COMMANDS.md`
- `docs/CONFIG.md`
- `docs/DATABASE.md`
- `README.md`

## 主要目标

按照正确顺序执行创作者互动流程。

默认流程是：

```text
扫描互动
→ 查看待处理任务
→ 执行评论回复
→ 准备回访任务
→ 预演回访
→ 执行回访
```

这个流程必须：

- 使用项目已有命令
- 基于数据库状态执行
- 按顺序执行
- 失败后立即停止
- 不自行改代码
- 不自行操作浏览器绕过 CLI

## 项目目录

项目根目录：

```bash
PROJECT_DIR="$HOME/.openclaw/li_shang_wang_lai"
```

执行任何命令前，先进入项目目录：

```bash
cd "$PROJECT_DIR"
```

## 何时使用此技能

当用户需要以下能力时，使用此技能：

- 执行完整礼尚往来流程
- 扫描评论和点赞互动
- 查看待处理互动任务
- 执行已准备好的评论回复
- 准备回访任务
- 预演回访执行
- 执行真实回访
- 调用项目 CLI，而不是手动操作页面

用户可能会这样说：

- “开始礼尚往来流程”
- “跑完整互动流程”
- “扫描互动并处理”
- “执行评论回复”
- “准备回访任务”
- “先预演一下回访”
- “执行回访”
- “采集评论并回访”
- “批量回复并回访”

## 何时不要使用此技能

不要用此技能处理以下事情：

- 直接生成评论文案
- 编写 Playwright 自动化代码
- 修改项目源码
- 修改数据库结构
- 安装依赖
- 初始化数据库
- 替用户登录
- 替用户扫码
- 绕过登录、验证码、滑块、频率限制或平台风控
- 生成垃圾评论
- 生成互关、引流、广告类评论
- 生成骚扰、辱骂、攻击性评论
- 操作 `li_shang_wang_lai` 项目 CLI 之外的流程

如果需要生成评论建议，应使用或读取：

```text
skills/creator-comment-suggestion/SKILL.md
```

本执行技能不应该自由发挥生成评论内容。

## 默认完整流程

当用户要求执行完整流程时，按顺序执行：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type all --json
cd "$PROJECT_DIR" && npm run actions:pending -- --json
cd "$PROJECT_DIR" && npm run comments:reply
cd "$PROJECT_DIR" && npm run return-visit:prepare -- --json --max-items 5
cd "$PROJECT_DIR" && npm run return-visit:execute -- --dry-run --json
cd "$PROJECT_DIR" && npm run return-visit:execute -- --json
```

如果任意命令失败，立即停止，并把失败命令和错误输出反馈给用户。

不要在失败后继续执行后续命令。

## 工作流一：扫描互动

用于从平台通知中心采集评论、点赞等互动数据。

扫描全部互动：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type all --json
```

只扫描评论：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type comment --json
```

只扫描点赞：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type like --json
```

如果用户只要求扫描，执行完本工作流即可停止。

如果用户要求完整流程，扫描完成后继续查看待处理任务。

## 工作流二：查看待处理任务

用于查看数据库中当前待处理的互动任务。

查看全部待处理任务：

```bash
cd "$PROJECT_DIR" && npm run actions:pending -- --json
```

查看待处理评论：

```bash
cd "$PROJECT_DIR" && npm run actions:pending -- --type comment --json
```

这个步骤用于确认后续要处理哪些互动。

## 工作流三：执行评论回复

评论回复指的是：

```text
别人评论了我的作品
→ 我在评论管理页回复这条评论
```

执行命令：

```bash
cd "$PROJECT_DIR" && npm run comments:reply
```

该命令应读取项目中已经准备好的回复数据，并进入评论管理页执行批量回复。

不要手动打开评论管理页。

不要自己写 Playwright 脚本替代该命令。

## 工作流四：准备回访任务

回访准备是回访流程的第一阶段。

执行命令：

```bash
cd "$PROJECT_DIR" && npm run return-visit:prepare -- --json --max-items 5
```

该阶段负责：

- 从互动事件中创建或更新回访任务
- 进入互动用户主页
- 查找最近合适作品
- 打开目标作品
- 采集作品内容
- 采集参考评论
- 生成回访评论
- 将任务标记为待执行

准备阶段不执行真实回访。

准备阶段完成后，继续执行回访预演。

## 工作流五：预演回访

真实回访前先执行 dry-run。

执行命令：

```bash
cd "$PROJECT_DIR" && npm run return-visit:execute -- --dry-run --json
```

dry-run 用于检查待执行任务和页面状态。

dry-run 不执行真实点赞，不执行真实评论。

如果 dry-run 失败，立即停止并反馈错误。

如果 dry-run 成功，并且用户要求完整流程或确认继续执行，则进入真实回访。

## 工作流六：执行回访

回访执行是回访流程的第二阶段。

执行命令：

```bash
cd "$PROJECT_DIR" && npm run return-visit:execute -- --json
```

该阶段负责：

- 打开准备阶段选中的目标作品
- 检查点赞状态
- 未点赞则点赞
- 已点赞则继续
- 发送已生成的回访评论
- 记录点赞结果
- 记录评论结果
- 更新任务结果

执行完成后，向用户报告执行结果。

## 回访快捷流程

当用户只说“执行回访”时，默认按下面顺序执行：

```bash
cd "$PROJECT_DIR" && npm run return-visit:prepare -- --json --max-items 5
cd "$PROJECT_DIR" && npm run return-visit:execute -- --dry-run --json
cd "$PROJECT_DIR" && npm run return-visit:execute -- --json
```

如果用户明确说明“回访任务已经准备好了”，可以跳过 `return-visit:prepare`，从 dry-run 开始：

```bash
cd "$PROJECT_DIR" && npm run return-visit:execute -- --dry-run --json
cd "$PROJECT_DIR" && npm run return-visit:execute -- --json
```

## 失败处理

命令失败时必须：

- 立即停止当前流程
- 不继续执行后续命令
- 告诉用户失败的是哪条命令
- 原样反馈错误输出
- 不猜测修复
- 不修改源码
- 不修改数据库结构

需要进一步排查时，提示用户查看：

- `docs/COMMANDS.md`：命令参数说明
- `docs/CONFIG.md`：配置说明
- `docs/DATABASE.md`：数据库和状态说明
- `README.md`：初始化、安装和环境说明

## 硬性限制

本技能不得：

- 绕过登录
- 绕过验证码
- 绕过滑块
- 绕过平台风控
- 替用户扫码
- 清空或替换浏览器登录态
- 编写自定义 Playwright 脚本
- 修改源码
- 修改数据库结构
- 发送空评论
- 发送广告评论
- 发送引流评论
- 发送互关评论
- 发送辱骂或骚扰评论
- 在命令失败后继续执行

`npm run` 的参数必须放在 `--` 后面。
