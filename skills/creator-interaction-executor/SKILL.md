---
name: creator-interaction-executor
description: 执行礼尚往来项目的创作者互动流程。默认基于数据库状态流转调用现有 CLI 命令，采集过去 7 天内的互动记录，经临时回复文件生成评论回复，再由 CLI 更新数据库和执行真实回复、回访准备、真实回访。不添加 --json，不执行 dry-run。
---

# 创作者互动执行

本技能用于执行 `li_shang_wang_lai` 项目的默认互动流程。

本技能只负责调用项目已有 CLI 命令，不直接编写 Playwright 脚本，不修改源码，不修改数据库结构，不自由生成评论内容，也不绕过平台登录、验证码、滑块或风控。

默认流程基于数据库状态流转。

## 严格工作流要求

agent 必须严格遵守本文件定义的工作流顺序。

默认完整流程必须按编号从工作流一执行到工作流七：

```text
工作流一：扫描互动
→ 工作流二：导出待回复评论临时文件
→ 工作流三：agent 填写回复结果临时文件
→ 工作流四：应用回复结果入库
→ 工作流五：执行真实评论回复
→ 工作流六：准备回访任务
→ 工作流七：执行真实回访
```

硬性要求：

- 不得跳过任意一个必需工作流。
- 不得合并多个工作流为一个命令。
- 不得用旧的一步式命令替代分段流程。
- 不得直接修改数据库。
- 不得让 agent 自己更新评论状态；状态更新必须由 CLI 完成。
- 不得在未生成并应用回复结果文件前执行真实评论回复。
- 不得跳过回访准备阶段直接执行回访。
- 只有用户明确要求执行某个单独工作流时，才只执行该工作流。

默认采集范围：

```text
过去 7 天内
```

默认不额外添加 `--max-items`，各命令处理上限以当前代码或配置默认值为准。


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
→ 导出待回复评论临时文件
→ agent 读取临时文件并填入回复内容
→ 使用 CLI 将已填回复文件更新入库
→ 执行真实评论回复
→ 准备回访任务
→ 执行真实回访
```

评论回复流程必须分两个阶段：

```text
读取数据库待回复评论并生成回复入库
→ 读取数据库 prepared 回复并执行真实回复
```

默认评论回复流程必须按临时文件分段：

```text
replies:export 导出 pending 评论临时文件
→ agent 只编辑临时结果文件，填写 action/replyText/reason
→ replies:apply -- --commit 读取结果文件并更新数据库，并在成功后自动删除结果文件
→ replies:execute -- --execute 读取数据库 prepared 回复并执行真实回复
```

agent 不直接修改数据库，不直接把回复写入数据库；所有数据库状态变更和临时结果文件删除都必须由 CLI 完成。

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
- 导出待回复评论临时文件
- 根据临时文件填写回复内容
- 使用 CLI 将回复写回数据库
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

- 脱离导出文件、作品上下文和 `skills/creator-comment-suggestion/SKILL.md` 自由生成评论文案
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
cd "$PROJECT_DIR" && npm run replies:export -- --out data/tmp/pending-replies.json --limit 20 --pretty
# agent 读取 data/tmp/pending-replies.json，生成 data/tmp/prepared-replies.json
cd "$PROJECT_DIR" && npm run replies:apply -- --input data/tmp/prepared-replies.json --commit
cd "$PROJECT_DIR" && npm run replies:execute -- --execute
cd "$PROJECT_DIR" && npm run return-visit:prepare
cd "$PROJECT_DIR" && npm run return-visit:execute
```

流程说明：

1. `interactions:scan` 从通知中心采集过去 7 天内的点赞和评论互动，并写入数据库。
2. `replies:export` 从数据库读取 `work_comments.reply_status = pending` 的待回复评论，导出临时 JSON 文件。
3. agent 读取导出的临时文件，按 `skills/creator-comment-suggestion/SKILL.md` 为每条评论填写 `action`、`replyText`、`reason`，生成结果 JSON 文件。
4. `replies:apply -- --input <结果文件> --commit` 读取结果文件，校验 `commentId` 和 `commentKey`，并由 CLI 将数据库状态更新为 `prepared` 或 `skipped`；成功写库且无错误后自动删除该结果文件。
5. `replies:execute -- --execute` 从数据库读取 prepared 回复，打开对应作品或评论位置，执行真实评论回复，并更新数据库结果。
6. `return-visit:prepare` 根据互动事件生成或更新回访任务，进入对方主页，采集作品上下文和参考评论，并生成回访评论。
7. `return-visit:execute` 执行真实回访，并写入执行结果。

任意一步失败，立即停止，不继续执行后续命令。

评论回复的数据库状态流转必须按下面理解：

```text
work_comments.reply_status = pending
→ replies:export 导出 pending 评论临时文件
→ agent 填写 reply-result-v1 临时结果文件
→ replies:apply -- --commit 校验结果文件并由 CLI 写回数据库
→ CLI 成功写库后自动删除结果文件
→ work_comments.reply_status = prepared
→ replies:execute -- --execute 逐条读取 prepared 回复并执行真实回复
→ 成功后更新为 succeeded，无法确认则 sent_unverified，失败阻断则 blocked
```

`actions:pending` 只用于可选查看待处理概况，不属于默认主流程。默认主流程中，agent 根据 `replies:export` 生成的临时文件逐条填写回复；数据库更新和结果文件删除只能通过 `replies:apply -- --commit` 完成。

默认完整流程对应当前真实代码：

| 阶段 | npm script | 源文件 | 是否真实执行页面操作 |
|---|---|---|---|
| 扫描互动 | `interactions:scan` | `src/cli/scan-interactions.mjs` | 是，打开通知页采集 |
| 导出待回复评论 | `replies:export` | `src/cli/export-pending-replies.mjs` | 否，只读数据库并写临时文件 |
| 应用回复结果 | `replies:apply` | `src/cli/apply-prepared-replies.mjs` | 否，读取临时文件并更新数据库 |
| 执行评论回复 | `replies:execute` | `src/cli/execute-prepared-replies.mjs` | 是，打开作品并回复 |
| 准备回访 | `return-visit:prepare` | `src/cli/execute-return-visit-prepare.mjs` | 是，进入主页和作品采集上下文 |
| 执行回访 | `return-visit:execute` | `src/cli/execute-return-visit.mjs` | 是，打开作品点赞和评论 |

当前代码默认处理上限：

| 命令 | 默认上限来源 |
|---|---|
| `interactions:scan` | `maxNotifications=50`，`maxScrollRounds=5`，并受 `--days` 超期停止策略影响 |
| `replies:export` | `--limit` 默认 `20` |
| `replies:execute` | 通用 `maxItems` 默认 `1` |
| `return-visit:prepare` | 配置 `returnVisit.prepareMaxItems`，否则 `20` |
| `return-visit:execute` | 配置 `returnVisit.executeMaxItems`，否则 `20` |

凡是阶段会生成可发布评论，agent 在执行前先读取：

```text
skills/creator-comment-suggestion/SKILL.md
```

当前会生成可发布评论的阶段：

- agent 读取 `replies:export` 临时文件并填写 `replyText`
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

## 工作流二：导出待回复评论临时文件

执行命令：

```bash
cd "$PROJECT_DIR" && npm run replies:export -- --out data/tmp/pending-replies.json --limit 20 --pretty
```

该阶段负责：

- 从数据库读取 `work_comments.reply_status = 'pending'` 的待回复评论
- 按作品分组导出作品信息和评论信息
- 生成 agent 可读取的临时 JSON 文件

当前真实参数：

```text
--limit <n>       默认 20
--work-id <id>
--out <file>
--pretty
--no-pretty
```

如果导出结果没有待回复评论，停止评论回复流程；仍可继续执行回访流程。

## 工作流三：agent 填写回复结果临时文件

评论回复指的是：

```text
别人评论了我的作品
→ 我在评论管理页或作品评论区回复这条评论
```

agent 读取 `replies:export` 输出文件后，必须生成一个新的结果 JSON 文件，例如：

```text
data/tmp/prepared-replies.json
```

结果文件必须符合 `replies:apply` 的真实输入格式：

```json
{
  "schemaVersion": "reply-result-v1",
  "replies": [
    {
      "commentId": 1,
      "commentKey": "必须原样保留导出文件中的 commentKey",
      "action": "reply",
      "replyText": "自然简短的回复",
      "reason": "为什么这样回复"
    }
  ]
}
```

每条导出评论都要逐条处理：

- 可以回复时：`action = "reply"`，填写非空 `replyText` 和 `reason`。
- 不适合回复时：`action = "skip"`，`replyText` 可为空，必须填写 `reason`。
- `commentId` 和 `commentKey` 必须从导出文件原样带回，不能编造、不能修改。
- 生成回复前必须读取并遵守 `skills/creator-comment-suggestion/SKILL.md`。
- agent 只能写临时结果文件，不能直接修改数据库。

## 工作流四：应用回复结果入库

执行命令：

```bash
cd "$PROJECT_DIR" && npm run replies:apply -- --input data/tmp/prepared-replies.json --commit
```

该阶段负责：

- 读取 agent 填好的结果 JSON 文件
- 校验 `schemaVersion = reply-result-v1`
- 校验每条 `commentId` 和 `commentKey` 是否匹配数据库
- 对 `action = reply` 的记录写入 `reply_text`，并标记为 `prepared`
- 对 `action = skip` 的记录标记为 `skipped`
- 成功写库且无错误后自动删除 `--input` 指定的结果文件

当前真实参数：

```text
--input <file>   必填
--dry-run
--commit
--overwrite
```

默认真实入库必须使用 `--commit`。如果用户要求先检查，可以先用 `--dry-run`，但 dry-run 不会写数据库。

默认不要使用计划文件流程。

只有用户明确提供计划文件，或者明确要求使用计划文件流程时，才走计划文件流程。

## 工作流五：执行真实评论回复

执行命令：

```bash
cd "$PROJECT_DIR" && npm run replies:execute -- --execute
```

该阶段负责：

- 从数据库逐条读取 prepared 状态的回复
- 对每一条 prepared 回复打开相关作品或评论位置
- 在正确评论位置填写并执行评论回复
- 每执行一条都更新数据库结果

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

默认评论回复必须按“导出临时文件，agent 填写结果文件，CLI 应用入库，CLI 执行真实回复”的四段式流程执行。

不要把默认评论回复写成单条命令，也不要跳过临时文件阶段。

`interactions:reply -- --execute` 是旧的一步式兼容命令，默认完整流程不要使用它。只有用户明确要求“一步生成并执行评论回复”时，才可以使用。

默认不要使用计划文件流程。

只有用户明确提供计划文件，或者明确要求使用计划文件流程时，才走计划文件流程。

## 工作流六：准备回访任务

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

## 工作流七：执行真实回访

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

本技能默认在扫描阶段限定时间范围：

```text
--days 7
```

含义：

- `interactions:scan -- --type all --days 7`：默认只从通知页采集过去 7 天内的互动记录。
- `replies:execute` 支持 `--days <n>`，但默认完整流程不自动添加；只有用户要求按日期限制执行 prepared 回复时才添加。
- `return-visit:prepare` 和 `return-visit:execute` 当前代码没有 `--days` 参数，回访任务来源按数据库状态和配置筛选。

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

## 关于计划文件

默认不要生成或读取计划文件。

这里的计划文件不包括默认流程中的临时回复文件：

```text
data/tmp/pending-replies.json
data/tmp/prepared-replies.json
```

临时回复文件是默认评论回复工作流的必需步骤。

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
- 默认生成计划文件
- 默认读取计划文件
- 发送空评论
- 发送广告评论
- 发送引流评论
- 发送互关评论
- 发送辱骂或骚扰评论
- 在命令失败后继续执行

`npm run` 的参数必须放在 `--` 后面。
