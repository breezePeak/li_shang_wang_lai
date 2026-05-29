# 礼尚往来：当前项目 Skill 化改造实施计划

> 文档用途：基于现有仓库代码，指导后续开发人员或 Codex 逐步完成 Skill 化改造。  
> 建议存放路径：`docs/PROJECT_SKILL_REFACTOR_PLAN.md`  
> 文档状态：实施计划 v1.0  
> 原则：保留可复用底层能力，修正产品定位，先安全闭环，再扩展真实动作。

---

## 1. 当前项目基线

### 1.1 当前技术栈

当前项目采用：

- Node.js ESM；
- Playwright：浏览器登录态、页面访问、元素定位与交互；
- better-sqlite3：本地事件与动作记录；
- Vitest：测试框架。

除此之外，代码库已自发增加了以下组织结构（超出原始计划范围）：
- `src/config/`：配置系统（`defaults.mjs` + `user-config.mjs`，支持 `config/local.json` 覆盖）
- `src/workflows/`：工作流占位（`comment-reply-workflow.mjs`、`like-reciprocity-workflow.mjs`）
- `src/domain/`：额外域模块（`action-policy.mjs`、`relationship-policy.mjs`、`latest-work-selector.mjs`）
- `src/browser/`：额外浏览器模块（`interactive-control.mjs`、`login-guard.mjs`、`page-diagnostics.mjs`）
- `src/adapters/`：额外适配器（`interaction-page.mjs`、`selectors.mjs`）
- `src/cli/inspect-notifications.mjs`：通知诊断命令
- `src/utils/wait.mjs`：等待工具

### 1.2 当前已有命令

| 命令 | 当前用途 | 改造后归属 |
|---|---|---|
| `npm run auth` | 登录并保存浏览器 Profile | 保留为安装/首次初始化动作 |
| `npm run db:init` | 初始化本地 SQLite | 保留 |
| `npm run interactions:inspect` | 页面诊断采集 | 保留为排障命令 |
| `npm run interactions:scan -- --type comment` | 评论扫描 | 包装为 Skill 只读动作 |
| `npm run interactions:scan -- --type like` | 通知/点赞扫描 | 包装为 Skill 只读动作 |
| `npm run comments:plan` | 生成 JSON 评论计划 | 重构为审批任务生成器 |
| `npm run comments:reply` | dry-run 或执行评论回复 | 重构为受控单条动作 |
| `npm run likes:plan` | 生成点赞回访计划 | 重构为回访候选预览 |
| `npm run likes:reciprocate` | 点赞执行逻辑 | MVP 默认禁用真实执行 |
| `npm run history` | 历史查看入口 | 后续补全 |
| `npm run server` | 本地管理端入口 | 推迟 |

### 1.3 可复用资产

以下实现可以继续保留并逐步增强：

- 浏览器 Profile 和上下文创建逻辑；
- 评论页 Adapter；
- 通知面板 Adapter；
- 用户主页、视频页 Adapter；
- SQLite migrations 与 repository；
- event fingerprint 去重；
- run context、dry-run、max-items 和 evidence 采集；
- 评论回复与回访执行中的防重复逻辑。

---

## 2. 当前必须修正的问题

### 2.1 根目录缺少 `SKILL.md`

#### 问题

仓库当前不是可直接安装的 OpenClaw Skill，因为缺少 Skill 根入口文件。

#### 修正方案

在仓库根目录新增：

```text
SKILL.md
```

职责包括：

- 描述 Skill 触发条件；
- 告诉 Agent 如何调用本地脚本；
- 定义安全边界；
- 要求公开动作必须经用户明确审批；
- 明确回访点赞在 MVP 阶段仅支持预览。

---

### 2.2 README 与真实执行行为不一致

#### 问题 A：点赞功能状态冲突（严重）

README 将真实回赞描述为暂不可用，但实际代码中存在两条风险路径：

1. `src/config/defaults.mjs` 中 `likes.enabled: true` ← 默认开放
2. `src/cli/execute-reciprocal-likes.mjs` 没有 `FEATURE_DISABLED` 硬阻断门 ← 传入 `--plan --execute` 即可触发真实点赞

**现状：文档说"暂不可用"，代码没有拦截。** 这是一个安全漏洞，必须在 Skill 入口暴露之前修复。

#### 修正方案

在正式安全重构完成前，采用以下两种方案之一：

**推荐方案：代码层关闭真实回赞**

- 增加 `ENABLE_EXPERIMENTAL_RECIPROCAL_LIKE=false` 默认配置；
- 未显式开启实验开关时，即使传入 `--execute` 也直接阻断；
- README 明确说明：仅支持回访候选预览，不公开支持真实回赞。

**不推荐方案：仅修改文档暴露实验执行**

- 会扩大误操作风险；
- 会让产品过早被理解为自动回赞工具。

#### 问题 B：评论回复命令说明不准确

README 中的评论回复命令未明确区分 dry-run 和真实执行，而当前公共参数默认值为：

```text
dryRun = true
execute = false
maxItems = 1
```

#### 修正方案

README 应明确展示：

```bash
# 只定位目标、不发送
npm run comments:reply -- --plan <计划文件> --dry-run

# 用户明确确认后，真实发送最多一条
npm run comments:reply -- --plan <计划文件> --execute --max-items 1
```

---

### 2.3 当前审批依赖人工修改 JSON

#### 问题

现有流程要求用户打开计划文件、填写 `replyText`、修改 `approved: true`，再手动运行执行命令。这种方式：

- 不符合 Skill 的对话协作体验；
- 容易被误改或批量批准；
- 不利于记录“谁在何时确认了什么动作”。

#### 修正方案

新增审批层，审批结果写入数据库，而不是依赖人工编辑 JSON。

建议新增命令：

```bash
npm run actions:pending
npm run comments:prepare -- --event-id <id> --reply-text "<内容>"
npm run actions:approve -- --action-id <id>
npm run comments:execute -- --action-id <id> --dry-run
npm run comments:execute -- --action-id <id> --execute --max-items 1
```

Skill 在后台调用这些命令，用户只需要在对话中确认。

---

### 2.4 点赞目标身份绑定不足

#### 问题

当前点赞回访流程主要依赖：

- 通知文本中的“朋友/互相关注”关系字段；
- 用户昵称；
- 在通知面板中按昵称片段重新查找并点击头像。

这不足以支撑正式真实点赞，因为存在同名、昵称变动、页面提取错配和目标不唯一风险。

#### 修正方案

MVP 阶段：

- 将点赞路径限定为只读扫描和候选预览；
- 所有不确定关系或目标都标记为 `blocked`；
- 禁止真实点赞默认公开使用。

未来实验阶段必须新增：

- `actor_profile_url`；
- `actor_unique_id` 或可稳定提取的页面身份字段；
- `notification_evidence`；
- `target_video_url`；
- `target_video_title`；
- `identity_verified_at`；
- `verification_method`。

---

## 3. 目标架构

### 3.1 改造后的目录建议

```text
li_shang_wang_lai/
├── SKILL.md
├── README.md
├── 礼尚往来-详细开发计划与执行边界.md
├── docs/
│   ├── SKILL_PRODUCT_PLAN.md
│   ├── PROJECT_SKILL_REFACTOR_PLAN.md
│   ├── SAFETY_GUARDRAILS.md
│   └── COMMAND_CONTRACTS.md
├── src/
│   ├── auth-douyin.mjs
│   ├── config/                        ← 已存在（超出原计划）
│   │   ├── defaults.mjs
│   │   └── user-config.mjs
│   ├── cli/
│   │   ├── scan-interactions.mjs
│   │   ├── inspect-interactions.mjs
│   │   ├── inspect-notifications.mjs   ← 已存在
│   │   ├── report-pending.mjs
│   │   ├── prepare-comment-reply.mjs
│   │   ├── approve-action.mjs
│   │   ├── execute-comment-reply.mjs
│   │   ├── plan-comments.mjs
│   │   ├── prepare-visit-candidates.mjs
│   │   ├── plan-likes.mjs
│   │   ├── execute-reciprocal-like.mjs
│   │   └── show-history.mjs
│   ├── domain/
│   │   ├── interaction-event.mjs
│   │   ├── action-request.mjs
│   │   ├── approval-policy.mjs
│   │   ├── feature-policy.mjs
│   │   ├── result-codes.mjs
│   │   ├── event-fingerprint.mjs
│   │   ├── action-policy.mjs           ← 已存在
│   │   ├── relationship-policy.mjs     ← 已存在
│   │   └── latest-work-selector.mjs    ← 已存在
│   ├── db/
│   │   ├── migrations.mjs
│   │   ├── database.mjs
│   │   ├── interaction-repository.mjs
│   │   ├── action-request-repository.mjs
│   │   ├── approval-repository.mjs
│   │   ├── action-repository.mjs
│   │   └── plan-repository.mjs
│   ├── adapters/
│   │   ├── comment-page.mjs
│   │   ├── notification-page.mjs
│   │   ├── user-profile-page.mjs
│   │   ├── video-page.mjs
│   │   ├── interaction-page.mjs        ← 已存在
│   │   └── selectors.mjs               ← 已存在
│   ├── browser/
│   │   ├── browser-context.mjs
│   │   ├── run-context.mjs
│   │   ├── failure-evidence.mjs
│   │   ├── interactive-control.mjs     ← 已存在
│   │   ├── login-guard.mjs             ← 已存在
│   │   └── page-diagnostics.mjs        ← 已存在
│   ├── workflows/                      ← 已存在（占位）
│   │   ├── comment-reply-workflow.mjs
│   │   └── like-reciprocity-workflow.mjs
│   └── utils/
│       ├── logger.mjs
│       ├── filesystem.mjs
│       ├── wait.mjs                    ← 已存在
│       └── cli-output.mjs
└── data/
    ├── plans/
    ├── runs/
    └── lishangwanglai.db
```

### 3.2 分层职责

| 层 | 职责 |
|---|---|
| `SKILL.md` | Agent 使用规范、调用顺序、安全约束 |
| `cli/` | 提供稳定、可调用的原子动作命令 |
| `domain/` | 状态机、审批规则、防重复策略 |
| `adapters/` | 与抖音页面结构交互，处理定位和提取 |
| `db/` | 保存事件、动作、审批、证据索引 |
| `browser/` | 登录态、运行上下文、异常现场保存 |
| `docs/` | 产品边界、命令契约和开发约束 |

---

## 4. 数据模型改造

### 4.1 当前事件表的定位

`interaction_events` 继续用于保存外部发生的事实，例如：

- 某人评论了我的作品；
- 某人点赞了我的作品；
- 某条通知被扫描到。

### 4.2 新增动作请求模型

建议引入 `action_requests`，用于保存“准备做但还没做”的动作。

示例字段：

| 字段 | 说明 |
|---|---|
| `id` | 动作请求 ID |
| `event_id` | 来源互动事件 |
| `action_type` | `reply_comment` / `visit_candidate` / `like_work` |
| `target_actor_name` | 目标用户昵称 |
| `target_actor_profile_url` | 目标用户主页 |
| `target_url` | 目标评论页面或视频 URL |
| `proposed_text` | 候选回复文本 |
| `status` | `prepared` / `approved` / `dry_run_ok` / `executed` / `blocked` / `cancelled` |
| `approved_at` | 用户确认时间 |
| `executed_at` | 实际执行时间 |
| `risk_reason` | 阻断或风险说明 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### 4.3 推荐状态机

#### 评论回复

```text
new interaction
  → prepared
  → approved
  → dry_run_ok
  → executed

任意阶段出现异常
  → blocked

用户取消
  → cancelled
```

#### 回访候选

MVP：

```text
new like interaction
  → candidate_prepared
  → previewed
  → stopped
```

未来实验执行：

```text
candidate_prepared
  → identity_verified
  → approved
  → dry_run_ok
  → executed
```

---

## 5. 命令契约改造

### 5.1 命令必须支持结构化输出

Skill 调用 CLI 时，不应依赖解析控制台中文日志。所有 Skill 需要使用的命令必须支持：

```bash
--json
```

返回统一结构：

```json
{
  "ok": true,
  "command": "report-pending",
  "mode": "read-only",
  "data": {},
  "summary": {},
  "blocked": [],
  "evidence": []
}
```

日志仍可保留给开发调试，但 Agent 应只读取 JSON 输出。

---

### 5.2 建议新增/调整命令

#### 只读命令

| 命令 | 说明 |
|---|---|
| `npm run interactions:scan -- --type comment --json` | 扫描评论 |
| `npm run interactions:scan -- --type like --json` | 扫描点赞通知 |
| `npm run interactions:report -- --status pending --json` | 汇总待处理互动 |
| `npm run visits:prepare -- --json` | 生成回访候选预览 |

#### 评论动作命令

| 命令 | 说明 |
|---|---|
| `npm run comments:prepare -- --event-id <id> --reply-text "<文本>" --json` | 准备评论回复任务 |
| `npm run actions:approve -- --action-id <id> --json` | 写入用户审批 |
| `npm run comments:execute -- --action-id <id> --dry-run --json` | 只定位、不发送 |
| `npm run comments:execute -- --action-id <id> --execute --max-items 1 --json` | 真实发送一条 |

#### 实验性回访动作命令

| 命令 | MVP 状态 |
|---|---|
| `npm run visits:execute -- --action-id <id> --dry-run --json` | 可保留实验调试 |
| `npm run visits:execute -- --action-id <id> --execute --json` | 默认硬阻断 |

---

## 6. `SKILL.md` 实施要求

### 6.1 文件基础结构

根目录 `SKILL.md` 至少需要包含：

```markdown
---
name: li-shang-wang-lai
description: Review creator interactions, draft replies, and safely execute individually approved actions.
---

# 礼尚往来

当用户希望查看抖音评论、互动通知、拟回复或预览好友回访候选时，使用本 Skill。
```

### 6.2 Skill 必须写死的安全规则

- 优先执行只读扫描与汇总；
- 未经用户明确确认，不得调用带 `--execute` 的命令；
- 评论真实发送前必须先完成 dry-run；
- 每次真实发送只处理一条；
- 回访点赞真实执行在 MVP 阶段禁止调用；
- 当脚本返回 blocked、unknown 或 evidence 时，向用户报告并停止动作；
- 不把浏览器 Profile、Cookie、截图中的敏感内容发给第三方。

### 6.3 Skill 建议支持的用户意图

| 用户说法 | Skill 计划 |
|---|---|
| “查看新评论” | scan comment → report pending |
| “看谁给我点赞了” | scan like → report pending |
| “给这条评论拟回复” | prepare reply，等待确认 |
| “先预览回复位置” | dry-run |
| “确认发送这一条” | 校验 approval + execute one |
| “看看好友回访候选” | visits prepare，仅预览 |
| “自动给好友回赞” | 拒绝自动批量执行，提供预览和后续单条审批说明 |

---

## 7. 代码改造任务拆解

## Phase 0：文档与真实能力对齐

### 目标

在继续开发前，先停止定位与行为不一致的问题。

### 修改清单

- [x] 新增 `SKILL_PRODUCT_PLAN.md`（已移入 `docs/`）
- [x] 新增 `PROJECT_SKILL_REFACTOR_PLAN.md`（已移入 `docs/`）
- [ ] 新增 `docs/` 目录，将上述两份文档移入
- [ ] 修改 `README.md` 首屏定位为 OpenClaw Skill 执行引擎/互动助手
- [x] 评论回复默认 `dry-run`（代码层 `run-context.mjs` 已实现，`dryRun: true`）
- [ ] README 修正 dry-run 描述（当前 README 第 228 行错误地说"还没有完整的 dry-run 安全预览模式"，与代码矛盾）
- [ ] 明确真实发送需 `--execute --max-items 1`
- [ ] 将回访真实点赞的代码层默认禁用（当前 `defaults.mjs` 中 `likes.enabled: true`，`execute-reciprocal-likes.mjs` 缺少硬阻断门 — 见 S0.5）
- [ ] 修正文档功能状态表和命令表

### 验收

- README 中不存在"暂不可用"但代码默认允许真实操作的冲突；
- 新用户阅读文档后不会误执行真实点赞；
- README 关于 dry-run 的描述与代码默认行为一致。

---

## Phase 0.5：真实点赞默认禁用（代码层硬阻断）

> **此阶段优先级已提升。** 原计划将此任务放在 PR 2，但在 2026-05-29 代码审查中发现：
> `src/config/defaults.mjs` 中 `likes.enabled: true`，且 `execute-reciprocal-likes.mjs` 没有 `FEATURE_DISABLED` 硬阻断门。
> 这意味着即使文档提示"暂不可用"，任何有本地执行权限的人仍可通过传入 `--plan --execute` 触发真实点赞。
> **这是一个安全漏洞，必须在 Skill 入口暴露之前修复。**

### 目标

消除"文档提醒禁止，但代码仍可直接 execute 真实点赞"的风险。

### 修改清单

- [ ] `src/domain/result-codes.mjs`：新增 `FEATURE_DISABLED`、`RECIPROCAL_LIKE_DISABLED` 错误码
- [ ] `src/config/defaults.mjs`：将 `likes.enabled` 改为 `false`
- [ ] `src/cli/execute-reciprocal-likes.mjs`：在入口增加实验开关检查，未开启时返回 `FEATURE_DISABLED`
- [ ] 阻断结果支持结构化输出（为后续 `--json` 做准备）
- [ ] `--dry-run` 与候选提取能力保留
- [ ] 增加最小测试验证阻断行为
- [ ] README 对应状态说明更新

### 验收

- 未开启实验开关时，`likes:reciprocate --execute` 返回 `FEATURE_DISABLED` 并拒绝执行
- `--dry-run` 和候选预览不受影响
- 不破坏现有审计与证据保存
- 代码层防御，不依赖文档提醒

---

## Phase 1：增加 Skill 入口与 JSON 输出

### 目标

让 OpenClaw 能把现有脚本当作工具链稳定调用。

### 修改清单

- [ ] 新增根目录 `SKILL.md`
- [ ] 为核心命令增加 `--json`
- [ ] 提取统一输出工具 `src/utils/cli-output.mjs`
- [ ] 新增 `src/cli/report-pending.mjs`
- [ ] 新增 package scripts：`interactions:report`
- [ ] 将控制台日志与机器输出隔离

### 验收

- OpenClaw 可安装此仓库 Skill；
- Agent 可调用扫描并解析结果；
- 不需要解析中文 console 文本判断成功或失败。

---

## Phase 2：评论回复审批闭环

### 目标

把“改 JSON 再运行脚本”升级为“对话中批准单条动作”。

### 修改清单

- [ ] 增加 `action_requests` 数据表
- [ ] 增加 `approval_records` 或审批字段
- [ ] 新增 `prepare-comment-reply.mjs`
- [ ] 新增 `approve-action.mjs`
- [ ] 将 `execute-comment-replies.mjs` 改为按 actionId 执行
- [ ] 真实执行要求 action 状态为 `approved`
- [ ] dry-run 成功后更新状态为 `dry_run_ok`
- [ ] 真实发送要求状态为 `dry_run_ok`
- [ ] 保留历史 JSON 导入兼容能力，但不再作为主流程

### 验收用例

1. 未审批动作尝试执行：必须阻断；
2. 审批后未 dry-run 就真实执行：必须阻断；
3. dry-run 成功、用户确认后真实执行：只发一条；
4. 同一事件再次执行：必须跳过；
5. 页面定位失败：记录 blocked 和证据。

---

## Phase 3：回访候选改造成只读预览

### 目标

保留已有探索价值，但不把不稳定流程作为正式真实动作开放。

### 修改清单

- [ ] 将 `plan-likes.mjs` 重命名/包装为 `prepare-visit-candidates.mjs`
- [ ] 输出候选而非“待执行回赞计划”
- [ ] 保存候选用户主页、作品 URL、标题、当前点赞状态
- [ ] 关系无法确认时标记 `blocked`
- [ ] 对 `execute-reciprocal-likes.mjs` 增加默认禁用门
- [ ] README 删除容易引导自动回赞的描述

### 验收

- Skill 能列出回访候选；
- 用户无法通过普通指令误触发真实点赞；
- 候选身份不确定时清晰提示原因。

---

## Phase 4：实验性单条回访执行

### 目标

仅在身份校验完成后进行有限验证。

### 修改清单

- [ ] 研究并提取稳定用户身份标识
- [ ] 增加 identity verification 状态
- [ ] 增加实验配置项
- [ ] 执行前重新核对候选主页与视频
- [ ] 执行前后保存证据
- [ ] 默认单轮最多一条
- [ ] 增加回归测试记录

### 验收

- 只有开启实验配置、已核验身份、已审批且 dry-run 完成的任务可执行；
- 发现任何不确定状态立即阻断；
- 经人工测试确认目标匹配与去重有效。

---

## 8. 具体文件修改建议

### 8.1 新增文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `SKILL.md` | OpenClaw Skill 根入口 | ❌ 待新增 |
| `docs/SKILL_PRODUCT_PLAN.md` | 产品路线与边界 | ✅ 已移入 `docs/` |
| `docs/PROJECT_SKILL_REFACTOR_PLAN.md` | 本实施文档 | ✅ 已移入 `docs/` |
| `docs/SAFETY_GUARDRAILS.md` | 安全规则明细 | ❌ 待新增 |
| `docs/COMMAND_CONTRACTS.md` | CLI 输入输出契约 | ❌ 待新增 |
| `src/utils/cli-output.mjs` | 统一 JSON 返回 | ❌ 待新增 |
| `src/cli/report-pending.mjs` | 待处理报告 | ❌ 待新增 |
| `src/cli/prepare-comment-reply.mjs` | 创建回复动作 | ❌ 待新增 |
| `src/cli/approve-action.mjs` | 审批动作 | ❌ 待新增 |
| `src/cli/prepare-visit-candidates.mjs` | 回访候选报告 | ❌ 待新增 |
| `src/db/action-request-repository.mjs` | 动作请求数据层 | ❌ 待新增 |
| `src/db/approval-repository.mjs` | 审批记录数据层 | ❌ 待新增 |
| `src/domain/approval-policy.mjs` | 审批策略 | ❌ 待新增 |
| `src/domain/feature-policy.mjs` | 实验功能开关策略 | ❌ 待新增 |

> 注：以下文件已由代码库自发创建，超出原始计划范围：
> `src/config/defaults.mjs`、`src/config/user-config.mjs`、`src/workflows/comment-reply-workflow.mjs`、`src/workflows/like-reciprocity-workflow.mjs`、`src/domain/action-policy.mjs`、`src/domain/relationship-policy.mjs`、`src/domain/latest-work-selector.mjs`、`src/browser/interactive-control.mjs`、`src/browser/login-guard.mjs`、`src/browser/page-diagnostics.mjs`、`src/adapters/interaction-page.mjs`、`src/adapters/selectors.mjs`、`src/cli/inspect-notifications.mjs`、`src/utils/wait.mjs`

### 8.2 需要修改的文件

| 文件 | 修改方向 |
|---|---|
| `README.md` | 改定位、改命令说明、改能力状态、修正 dry-run 描述 |
| `package.json` | 新增 report/prepare/approve/execute 脚本 |
| `src/config/defaults.mjs` | `likes.enabled` 改为 `false`（S0.5） |
| `src/domain/result-codes.mjs` | 新增 `FEATURE_DISABLED`、`RECIPROCAL_LIKE_DISABLED` 等缺失错误码 |
| `src/db/migrations.mjs` | 增加 action request / approval 表结构 |
| `src/db/plan-repository.mjs` | 从 JSON 计划转向动作请求 |
| `src/cli/scan-interactions.mjs` | 支持统一 JSON 输出 |
| `src/cli/plan-comments.mjs` | 逐步废弃手工 JSON 审批主流程 |
| `src/cli/execute-comment-replies.mjs` | 要求审批与 dry-run 状态 |
| `src/cli/plan-likes.mjs` | 调整为候选预览语义 |
| `src/cli/execute-reciprocal-likes.mjs` | 默认硬阻断真实执行（S0.5） |
| `src/browser/run-context.mjs` | 补充 action/approval 与机器输出信息 |

---

## 9. README 改造要点

README 不需要一开始就写得非常长，但必须准确表达：

### 首屏应写

```text
礼尚往来是一款面向抖音创作者的 OpenClaw 互动助手 Skill 执行引擎。
它用于扫描真实评论与互动通知、生成处理建议，并在本人明确确认后执行单条评论回复。
好友回访功能目前仅提供候选预览，真实点赞仍处于实验禁用状态。
```

### 状态表应改为

| 能力 | 状态 |
|---|---|
| 登录态复用 | 已实现 |
| 评论扫描与入库 | 初版可用 |
| 点赞/通知扫描 | 验证中 |
| 待处理摘要 | 待新增 |
| 评论候选回复 | 待 Skill 化 |
| 评论 dry-run | 已有逻辑，待规范入口 |
| 单条评论真实发送 | 实验可用，需审批与验证 |
| 好友回访候选 | 开发验证中 |
| 真实回访点赞 | 默认禁用 |

### 命令说明必须区分

```bash
# 只扫描评论
npm run interactions:scan -- --type comment

# 评论回复仅预览定位，不发送
npm run comments:reply -- --plan <路径> --dry-run

# 明确批准后，最多发送一条
npm run comments:reply -- --plan <路径> --execute --max-items 1
```

---

## 10. 给 Codex 的执行顺序

建议不要让 Codex 一次性大改全项目。按下列顺序逐步提交，每一步都可验收、可回滚。

**⚠️ PR 1 和 PR 2 的顺序至关重要：必须在暴露 Skill 入口（PR 3）之前，先完成代码层的点赞硬阻断（PR 2）。**

### PR 1：文档与真实状态修正

- 增加两份 docs 文档；
- 修正 README（定位 + dry-run 描述 + 点赞状态）；
- 暂不改执行逻辑。

### PR 2：真实回赞默认禁用（S0.5 · 必须优先于 PR 3）

- 增加实验开关（`ENABLE_EXPERIMENTAL_RECIPROCAL_LIKE`）；
- 默认阻断点赞 `--execute`（代码层硬拦截）；
- 增加 `FEATURE_DISABLED` 错误码；
- 增加测试。

### PR 3：Skill 根入口与只读报告

- 增加 `SKILL.md`；
- 增加 `report-pending.mjs`；
- 核心只读命令支持 `--json`。

### PR 4：评论动作审批模型

- 数据库迁移；
- prepare/approve 命令；
- 兼容旧 JSON 计划但迁移主流程。

### PR 5：评论对话闭环

- 执行脚本基于审批状态运行；
- dry-run → execute 状态门；
- 单条上限和执行结果稳定返回。

### PR 6：回访候选报告

- 将点赞流程降为预览能力；
- 强化身份证据与阻断信息；
- 不开放真实执行。

---

## 11. 第一轮测试清单

### 文档与安装

- [ ] OpenClaw 能识别根目录 `SKILL.md`
- [ ] Skill 名称与触发说明清晰
- [ ] README 的功能状态与代码行为一致
- [ ] README 关于 dry-run 的描述与 `run-context.mjs` 默认值一致

### 真实回赞默认禁用（S0.5 · 必须优先验证）

- [ ] 未开启实验开关时，`likes:reciprocate --execute` 返回 `FEATURE_DISABLED`
- [ ] 未开启实验开关时，`likes:reciprocate --dry-run` 不被阻断
- [ ] 开启实验开关后，需审批 + dry-run 完成才允许执行
- [ ] 阻断结果可被 JSON 输出

### 评论扫描

- [ ] 无评论时返回空结果而非错误
- [ ] 新评论可入库
- [ ] 重复扫描不会重复新增事件
- [ ] 页面结构异常能保存证据

### 评论回复

- [ ] 未确认不能发送
- [ ] dry-run 不会发送
- [ ] 未经过 dry-run 不能真实发送
- [ ] 单次只发送一条
- [ ] 已成功回复过的评论不会再次发送

### 回访候选

- [ ] 非朋友/互关候选自动跳过
- [ ] 目标身份不明确时阻断
- [ ] 已点赞作品标记为跳过
- [ ] MVP 模式任何条件下都不会真实点赞

---

## 12. 改造完成后的判断标准

当以下条件全部满足时，可以认为项目完成了第一阶段 Skill 化改造：

- 仓库根目录存在可加载的 `SKILL.md`；
- OpenClaw 可以通过自然语言触发扫描与摘要；
- 用户不需要手改 JSON 才能批准一条评论回复；
- 评论真实发送必须先审批、先 dry-run、每轮最多一条；
- 好友回访仅提供可核对候选，不默认执行真实点赞；
- 所有真实动作都有状态、结果和异常证据；
- README 对能力边界的描述与代码严格一致。
