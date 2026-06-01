---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。默认基于数据库状态流转调用现有 CLI 命令，采集过去 7 天内的互动记录，并完成待处理查看、评论回复、回访准备和真实回访。默认不限制记录数量，不使用中间计划文件，不添加 --json，不执行 dry-run。
---

# 创作者互动执行

本技能用于执行 `li_shang_wang_lai` 项目的默认互动流程。

本技能只负责调用项目已有 CLI 命令，不直接编写 Playwright 脚本，不修改源码，不修改数据库结构，不自由生成评论内容，也不绕过平台登录、验证码、滑块或风控。

默认流程基于数据库状态流转。

默认采集范围：

```text
过去 7 天内
不限制记录数量
```

默认不使用中间计划文件。

默认不添加 `--json`。

默认不执行 `--dry-run`。

本文件是给 agent 执行流程用的操作说明。执行前优先按当前代码和 `package.json` 校验命令，不要把这里当成面向用户的说明页。

进一步排查时，agent 可读取项目内文档作为辅助上下文：

- `docs/COMMANDS.md`
- `README.md`

## 主要目标

按照正确顺序执行创作者互动流程。

默认完整流程是：

```text
扫描互动
→ 查看待处理互动
→ 生成评论回复并入库
→ 执行真实评论回复
→ 准备回访任务
→ 执行真实回访
```

评论回复流程必须分两个阶段：

```text
读取数据库待回复评论并生成回复入库
→ 读取数据库 prepared 回复并执行真实回复
```

回访流程分两个阶段：

```text
回访准备
→ 回访执行
```

## 项目目录

项目目录不要写死成单一路径。优先遵循 `README.md` 中的安装位置；如果当前环境已经在项目根目录，就直接使用当前目录。

优先级：

1. 当前目录下存在 `package.json`，直接使用当前目录。
2. 环境变量 `PROJECT_DIR` 已设置且指向有效项目目录，使用该路径。
3. 按 `README.md` 的默认安装路径：
   - macOS / Linux：`$HOME/.openclaw/li_shang_wang_lai`
   - Windows PowerShell：`$env:USERPROFILE\.openclaw\li_shang_wang_lai`

```bash
PROJECT_DIR="${PROJECT_DIR:-$HOME/.openclaw/li_shang_wang_lai}"
```

执行任何命令前，先进入项目目录。若当前目录已经是项目根目录，则不要重复 `cd`。

```bash
if [ -f "./package.json" ]; then
  PROJECT_DIR="$(pwd)"
else
  cd "$PROJECT_DIR"
fi
```

## 何时使用此技能

当用户需要以下能力时，使用此技能：

- 执行完整礼尚往来流程
- 扫描过去 7 天内的评论和点赞互动
- 查看待处理互动任务
- 生成评论回复并入库
- 执行真实评论回复
- 准备回访任务
- 执行真实回访
- 调用项目 CLI，而不是手动操作页面

用户可能会这样说：

- “开始礼尚往来流程”
- “跑完整互动流程”
- “扫描互动并处理”
- “执行评论回复”
- “准备回访任务”
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

如果执行流程需要生成评论建议，agent 必须先读取并遵守：

```text
skills/creator-comment-suggestion/SKILL.md
```

本执行技能不应该自由发挥生成评论内容。涉及“评论回复”和“回访评论”的阶段，都必须按评论建议 skill 的输入契约、输出契约、禁用词和安全规则约束生成结果。

## 默认完整流程

当用户要求执行完整流程时，按顺序执行：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type all --days 7
cd "$PROJECT_DIR" && npm run actions:pending
cd "$PROJECT_DIR" && npm run comments:prepare-replies
cd "$PROJECT_DIR" && npm run replies:execute -- --execute
cd "$PROJECT_DIR" && npm run return-visit:prepare
cd "$PROJECT_DIR" && npm run return-visit:execute
```

流程说明：

1. `interactions:scan` 从通知中心采集过去 7 天内的点赞和评论互动，并写入数据库。
2. `actions:pending` 查看当前数据库中的待处理互动。
3. `comments:prepare-replies` 从数据库读取待回复评论，结合作品内容和参考评论生成回复，并将回复写回数据库。
4. `replies:execute -- --execute` 从数据库读取 prepared 回复，打开对应作品或评论位置，执行真实评论回复，并更新数据库结果。
5. `return-visit:prepare` 根据互动事件生成或更新回访任务，进入对方主页，采集作品上下文和参考评论，并生成回访评论。
6. `return-visit:execute` 执行真实回访，并写入执行结果。

任意一步失败，立即停止，不继续执行后续命令。

默认完整流程对应当前真实代码：

| 阶段 | npm script | 源文件 | 是否真实执行页面操作 |
|---|---|---|---|
| 扫描互动 | `interactions:scan` | `src/cli/scan-interactions.mjs` | 是，打开通知页采集 |
| 查看待处理 | `actions:pending` | `src/cli/report-pending.mjs` | 否，只读数据库 |
| 生成评论回复 | `comments:prepare-replies` | `src/cli/prepare-work-comment-replies.mjs` | 否，只读写数据库 |
| 执行评论回复 | `replies:execute` | `src/cli/execute-prepared-replies.mjs` | 是，打开作品并回复 |
| 准备回访 | `return-visit:prepare` | `src/cli/execute-return-visit-prepare.mjs` | 是，进入主页和作品采集上下文 |
| 执行回访 | `return-visit:execute` | `src/cli/execute-return-visit.mjs` | 是，打开作品点赞和评论 |

凡是阶段会生成可发布评论，agent 在执行前先读取：

```text
skills/creator-comment-suggestion/SKILL.md
```

当前会生成可发布评论的阶段：

- `comments:prepare-replies`
- `return-visit:prepare`

## 工作流一：扫描互动

扫描全部互动：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type all --days 7
```

只扫描评论：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type comment --days 7
```

只扫描点赞：

```bash
cd "$PROJECT_DIR" && npm run interactions:scan -- --type like --days 7
```

扫描完成后，数据写入数据库。

如果用户只要求扫描，执行完本工作流即可停止。

## 工作流二：查看待处理互动

查看全部待处理互动：

```bash
cd "$PROJECT_DIR" && npm run actions:pending
```

查看待处理评论：

```bash
cd "$PROJECT_DIR" && npm run actions:pending -- --type comment
```

该步骤只查看数据库中的待处理任务，不创建中间计划文件。

## 工作流三：生成评论回复并入库

评论回复指的是：

```text
别人评论了我的作品
→ 我在评论管理页或作品评论区回复这条评论
```

执行命令：

```bash
cd "$PROJECT_DIR" && npm run comments:prepare-replies
```

该阶段负责：

- 从数据库读取待回复评论
- 读取评论所属作品的内容信息
- 读取作品下已采集的参考评论
- 读取并遵守 `skills/creator-comment-suggestion/SKILL.md`
- 综合待回复评论、作品内容和参考评论生成回复内容
- 将生成结果写入数据库，标记为 prepared

该阶段不会打开浏览器执行真实回复。

当前真实参数：

```text
--max-items <n>          默认 100
--reply-max-length <n>   默认 40，最小 10
```

不要给该命令添加 `--execute`，当前代码不会解析这个参数。

默认不要使用 `comments:plan`。

默认不要使用 `comments:reply -- --plan <计划文件路径>`。

只有用户明确提供计划文件，或者明确要求使用计划文件流程时，才走计划文件流程。

## 工作流四：执行真实评论回复

执行命令：

```bash
cd "$PROJECT_DIR" && npm run replies:execute -- --execute
```

该阶段负责：

- 从数据库读取 prepared 状态的回复
- 打开相关作品或评论位置
- 执行评论回复
- 更新数据库结果

当前真实参数来自通用 `parseCommonArgs`，常用参数：

```text
--execute
--preview
--max-items <n>
--days <n>
--keep-open
--json
```

默认执行真实回复时必须添加 `--execute`。

默认评论回复必须按“先生成入库，再执行真实回复”的两段式流程执行。

不要把默认评论回复写成单条命令。

`interactions:reply -- --execute` 是旧的一步式兼容命令，默认完整流程不要使用它。只有用户明确要求“一步生成并执行评论回复”时，才可以使用。

默认不要使用 `comments:plan`。

默认不要使用 `comments:reply -- --plan <计划文件路径>`。

只有用户明确提供计划文件，或者明确要求使用计划文件流程时，才走计划文件流程。

## 工作流五：准备回访任务

回访准备是回访流程的第一阶段。

执行命令：

```bash
cd "$PROJECT_DIR" && npm run return-visit:prepare
```

该阶段负责：

- 从互动事件中创建或更新回访任务
- 进入互动用户主页
- 查找最近合适作品
- 打开目标作品
- 采集作品标题、正文、话题和页面可见文本
- 采集参考评论
- 读取并遵守 `skills/creator-comment-suggestion/SKILL.md`
- 生成一条回访评论
- 将任务标记为待执行

当前真实参数：

```text
--max-items <n>
--event-limit <n>
--event-status <status>
--keep-open
--headless
--json
```

准备阶段不会点赞，也不会发表评论。

准备阶段完成后，继续执行真实回访。

## 工作流六：执行真实回访

回访执行是回访流程的第二阶段。

执行命令：

```bash
cd "$PROJECT_DIR" && npm run return-visit:execute
```

该阶段负责：

- 打开准备阶段选中的目标作品
- 检查点赞状态
- 未点赞则点赞
- 已点赞则继续
- 发送已生成的回访评论
- 记录点赞状态
- 记录评论状态
- 更新任务结果

当前真实参数：

```text
--max-items <n>
--dry-run
--watch-policy <policy>
--watch-seconds <n 或 min-max>
--keep-open
--headless
--json
```

该命令没有 `--execute` 参数；默认不加 `--dry-run` 时就是真实执行。

执行完成后，向用户报告执行结果。

## 回访流程

当用户说“执行回访”时，按下面顺序执行：

```bash
cd "$PROJECT_DIR" && npm run return-visit:prepare
cd "$PROJECT_DIR" && npm run return-visit:execute
```

回访流程固定包含：

```text
准备回访任务
→ 执行真实回访
```

不要把回访写成单条命令。

不要跳过准备阶段直接执行回访。

不要在默认流程中加入 `--dry-run`。

## 评论回复与回访的区别

评论回复：

```text
别人评论了我的作品
→ 我回复这条评论
```

回访：

```text
别人给我点赞或评论
→ 我进入对方主页
→ 找到合适作品
→ 准备回访评论
→ 执行回访
```

这两个流程不是同一个流程。

## 关于默认时间范围

本技能默认只限定时间范围：

```text
--days 7
```

含义：

- `--days 7`：默认只采集和处理过去 7 天内的互动记录。
- 默认不限制采集数量。
- 默认不限制处理数量。

如果用户明确要求其他时间范围，按用户要求覆盖默认值。

## 关于 --json

`--json` 只表示命令以 JSON 格式输出结果，方便程序读取。

`--json` 不是中间文件。

本技能默认不要添加 `--json`。

只有用户明确要求 JSON 输出时，才添加 `--json`。

## 关于 dry-run

`--dry-run` 表示预演，不执行真实点赞或评论。

本技能默认不要执行 `--dry-run`。

只有用户明确要求“预演”“试运行”“先检查不执行”时，才使用 `--dry-run`。

## 关于中间计划文件

默认不要生成或读取中间计划文件。

不要默认执行：

```bash
npm run comments:plan
npm run comments:reply -- --plan <计划文件路径>
```

只有用户明确提供计划文件，或者明确要求使用计划文件流程时，才使用计划文件相关命令。

## 失败处理

命令失败时必须：

- 立即停止当前流程
- 不继续执行后续命令
- 告诉用户失败的是哪条命令
- 原样反馈错误输出
- 不猜测修复
- 不修改源码
- 不修改数据库结构

需要进一步排查时，agent 先读取：

- `docs/COMMANDS.md`：命令参数说明
- `README.md`：初始化、安装和环境说明

读取后只向用户报告结论、证据和下一步建议，不要把排查责任转交给用户。

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
- 默认添加 `--json`
- 默认执行 `--dry-run`
- 默认生成中间计划文件
- 默认读取中间计划文件
- 默认限制记录数量
- 发送空评论
- 发送广告评论
- 发送引流评论
- 发送互关评论
- 发送辱骂或骚扰评论
- 在命令失败后继续执行

`npm run` 的参数必须放在 `--` 后面。
