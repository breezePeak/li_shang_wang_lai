# 礼尚往来

面向抖音创作者的 **OpenClaw 互动助手 Skill 执行引擎**。

它用于扫描真实评论与互动通知、生成处理建议，并在本人明确确认后执行单条评论回复。好友回访功能目前仅提供候选预览，真实点赞仍处于实验禁用状态。

> 本项目定位为 OpenClaw Skill 的执行引擎层。Skill 负责理解用户意图、组织流程、展示候选、请求审批；执行引擎（本仓库）负责浏览器操作、页面采集、本地记录和经批准后的最小动作执行。

---

## 两层架构

```text
用户（自然语言）
  ↓
OpenClaw Agent + SKILL.md（待新增）
  ├── 理解意图、调用命令、展示候选
  ├── 收集明确审批
  └── 限制真实动作范围
        ↓ 调用本地命令
Node.js + Playwright + SQLite 执行引擎（本仓库）
  ├── 浏览器登录态复用
  ├── 页面读取与元素定位
  ├── 事件入库与去重
  ├── dry-run 定位
  ├── 经批准后的单条动作
  └── 证据与审计记录
```

---

## 功能定位

你可能每天都会遇到这些情况：

- 有人给作品留言，但容易漏回；
- 有好友给作品点赞，想回访对方最近的视频；
- 互动数量多了以后，不记得哪些已经处理过；
- 不希望把账号交给完全自动、不可控的脚本。

**礼尚往来**遵循以下原则：

```text
默认只观察和定位 → 不默认执行真实互动
真实动作必须审批 → 可验证、可追溯、可停止
页面状态不明确时 → 必须阻断
单轮真实执行 → 默认最多 1 条
```

---

## 当前版本状态

当前版本：`0.1.0`

| 功能 | 状态 | 说明 |
|---|---|---|
| 浏览器登录态复用 | 已实现 | 使用 Playwright 持久化 Profile |
| 页面诊断采集 | 已实现 | 可保存页面文本、DOM、截图等诊断材料 |
| 评论扫描与入库 | 初版可用 | 从通知中心统一采集评论和点赞、入库去重 |
| 点赞/通知扫描 | 初版验证中 | 通知面板 hover 铃铛、滚动提取点赞事件 |
| 待处理摘要 | 初版可用 | `actions:pending --json` 支持结构化输出 + blocked 明细 |
| 评论候选回复 | 初版可用 | 通过 `comments:prepare` 创建单条候选 |
| 评论 dry-run | 已有逻辑 | 定位目标评论但不发送（默认 `dryRun: true`） |
| 评论审批闭环 | 开发验证中 | `prepare → approve → dry-run → confirm-execute → execute` |
| 单条评论真实发送 | 实验可用 | 需双确认 + dry-run，每轮最多 1 条 |
| JSON Agent 契约 | 修复中 | 大部分命令已实现纯净 stdout JSON |
| 好友回访候选 | 开发验证中 | `actions:plan --json` + `visits:discover --json` 三阶段预览 |
| 真实回访点赞 | **默认禁用** | MVP 代码层硬阻断，`FEATURE_DISABLED` |

---

## 技术栈

- [Node.js](https://nodejs.org/) `>= 20`
- [Playwright](https://playwright.dev/)：控制浏览器、复用登录态、页面采集与互动操作
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)：本地数据持久化
- [Vitest](https://vitest.dev/)：测试框架

---

## 安装

### 1. 克隆项目

```bash
git clone https://github.com/breezePeak/li_shang_wang_lai.git
cd li_shang_wang_lai
```

### 2. 安装依赖

```bash
npm install
```

### 3. 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

### 4. 初始化本地数据库

```bash
npm run db:init
```

数据库默认保存在：

```text
data/lishangwanglai.db
```

---

## 快速开始

### 第一步：登录抖音创作者中心

```bash
npm run auth
```

命令会打开浏览器。请在浏览器中完成扫码登录。

登录状态将保存在本地目录：

```text
.playwright/douyin-profile/
```

下次执行扫描时会复用该登录状态，无需反复扫码。

> 请勿将 `.playwright/` 目录上传到公开仓库，其中可能包含账号登录状态信息。

---

### 第二步：探测页面结构

在正式扫描之前，建议先使用页面探测命令检查当前账号页面是否能够被识别。

#### 探测评论页面

```bash
npm run interactions:inspect -- --page comment
```

#### 探测点赞/通知相关页面

```bash
npm run interactions:inspect -- --page like
```

或：

```bash
npm run interactions:inspect -- --page notice
```

探测过程会打开浏览器，等待你进入目标页面后开始采集。输出结果位于：

```text
interactions-output/inspect/
```

通常包含：

```text
page-info.json
visible-text.txt
keyword-elements.json
clickable-users.json
screenshot-full.png
dom-fragment.html
```

这些文件用于分析页面结构变化、元素定位失败等问题。

---

### 第三步：扫描评论和点赞

所有新互动统一从通知中心采集：

```bash
npm run interactions:scan -- --type all --json    # 采集评论和点赞
npm run interactions:scan -- --type comment --json # 只采集评论
npm run interactions:scan -- --type like --json    # 只采集点赞
```

程序打开通知中心，滚动加载通知列表，逐批解析并去重入库。评论管理页面**不再**承担发现新评论的职责，仅用于后续定位原评论并执行回复。

---

### 第四步：生成评论回复计划

```bash
npm run comments:plan
```

程序会读取尚未回复的评论，生成计划文件：

```text
data/plans/comments-plan-<时间戳>.json
```

计划中的每条评论结构类似：

```json
{
  "eventId": 1,
  "actorName": "用户昵称",
  "workTitle": "作品标题",
  "commentText": "写得不错",
  "commentTime": "05-28",
  "replyText": "",
  "approved": false
}
```

你需要手动完成两件事：

1. 在 `replyText` 中填写希望发送的回复；
2. 只将确认要执行的条目修改为：

```json
"approved": true
```

---

### 第五步：执行已确认的评论回复

```bash
npm run comments:reply -- --plan data/plans/comments-plan-<时间戳>.json
```

程序只会处理计划文件中：

```json
"approved": true
```

的评论条目。

> **重要提醒：** 评论真实回复前，请务必先使用 `--dry-run` 定位目标评论并人工核对结果。当前默认模式为 dry-run（不发送），使用 `--execute` 才会触发真实发送，且每轮最多 1 条。已成功回复过的评论不会重复发送。

---

## 通知与点赞扫描

可以尝试扫描点赞类通知：

```bash
npm run interactions:scan -- --type like
```

也可以同时尝试扫描评论和点赞通知：

```bash
npm run interactions:scan -- --type all
```

当前通知扫描能力主要用于页面验证和事件采集。

### 好友回访候选预览（三阶段）

```bash
# 阶段 1: 候选分流（纯数据，不进主页）
npm run actions:plan -- --json

# 阶段 2 (phase3): 主页发现（浏览器进入主页/视频页）
npm run visits:discover -- --json --max-items 5

# 阶段 3: 真实执行（MVP 阶段硬阻断）
npm run likes:reciprocate -- --execute
```

> **三阶段说明：**
> - `actions:plan`：只做候选分流，不进主页；从 new 事件生成 replyCommentCandidates + visitWorkCandidates；
> - `visits:discover`：phase3，浏览器进入好友/互关主页，找最近非置顶作品，检查点赞状态；
> - `likes:reciprocate`：真实点赞继续 `FEATURE_DISABLED` 硬阻断。

### 真实回访点赞（默认禁用）

> **⚠️ 真实回访点赞在 MVP 阶段默认禁用。** 该功能需要实验开关 + 身份核验 + 审批 + dry-run 全部通过后才允许执行。当前阶段任何 `likes:reciprocate --execute` 调用都应被拦截。

---

## 常用命令

| 命令 | 说明 | 当前状态 |
|---|---|---|
| `npm run auth` | 打开浏览器扫码登录并保存登录态 | 可用 |
| `npm run db:init` | 初始化 SQLite 数据库 | 可用 |
| `npm run interactions:inspect -- --page comment` | 采集评论页诊断信息 | 可用 |
| `npm run interactions:inspect -- --page like` | 采集点赞相关页面诊断信息 | 可用 |
| `npm run interactions:scan -- --type comment` | 扫描评论并写入数据库 | 初版可用 |
| `npm run interactions:scan -- --type like` | 扫描点赞通知 | 验证阶段 |
| `npm run comments:plan` | 生成待回复评论计划（JSON） | 初版可用 |
| `npm run comments:reply -- --plan <路径> --dry-run` | 定位目标评论，不发送 | 已有逻辑 |
| `npm run comments:reply -- --plan <路径> --execute --max-items 1` | 真实发送单条回复（需审批） | 实验可用 |
| `npm run actions:plan` | 候选分流：从 new 事件生成评论候选 + 回访候选 | 只读 |
| `npm run visits:discover` | phase3：进入好友主页，发现最新作品并检查点赞状态 | 只读预览 |
| `npm run likes:plan` | 旧版浏览器回访计划 | 不推荐 |
| `npm run likes:reciprocate` | 好友回赞执行 | **默认禁用** |
| `npm test` | 运行测试 | 已配置 |

> **⚠️ 点赞回访**：`likes:reciprocate --execute` 在 MVP 阶段默认禁用。好友回访功能仅支持候选预览，不执行真实点赞。

---

## 本地数据目录

项目运行后可能产生以下本地数据：

```text
.playwright/
  douyin-profile/          # 浏览器登录态，敏感数据

data/
  lishangwanglai.db        # SQLite 数据库
  plans/                   # 评论或互动处理计划

interactions-output/
  inspect/                 # 页面诊断截图、文本与 DOM
```

这些目录默认用于本地调试和记录，不建议提交到公开仓库。

---

## 使用边界与安全提醒

本项目定位为创作者互动助手，不鼓励无审核、无边界的批量自动操作。

### 安全规则

| 规则 | 约束 |
|---|---|
| 默认只读 | 默认仅允许扫描、汇总、生成候选和 dry-run |
| 明确审批 | 真实动作必须由用户针对具体条目明确确认 |
| 单条执行 | 真实执行默认最多 1 条 |
| 先预览后执行 | 在执行前展示目标、内容和动作 |
| 状态未知即阻断 | 页面定位、关系判断或点赞状态不确定时不得继续 |
| 防重复 | 已成功执行过的事件或目标不得重复操作 |
| 可追溯 | 保存计划、执行结果、运行摘要和异常证据 |
| 风控停止 | 遇到验证码、登录失效、页面异常时立刻停止 |

请遵守以下原则：

- 首次使用只进行页面探测和少量评论扫描；
- 执行回复前，人工核对目标评论与回复内容；
- 不要将浏览器登录态目录分享给他人；
- 页面定位异常时立即停止真实操作；
- 出现登录校验、验证码、页面结构变化时，不要继续批量执行；
- **MVP 阶段禁止真实点赞回访**（代码层需 `FEATURE_DISABLED` 硬阻断）；
- 使用者应自行确认并遵守平台规则及账号安全要求。

---

## 当前已知限制

- 抖音页面结构可能更新，导致文本定位或通知解析失效；
- 评论回复默认 dry-run，真实发送需 `--execute --max-items 1` 且通过审批；
- 好友回访仅支持候选预览，真实点赞在 MVP 阶段默认禁用；
- **相对时间限制**：当评论仅显示相对时间（如"3分钟前"）且页面 DOM 未提供稳定评论 ID（`data-comment-id` 等属性）时，同一用户同作品下相同文本的评论可能被保守合并为一条事件。时间稳定后重新扫描可自动拆分；
- **审批策略**：`comments:prepare` 要求 Agent 先完成评论决策（`--decision reply`、`--risk-level low`），仅低风险可进入候选流程；高风险或需人工审核的评论必须阻断；
- 暂无可视化管理界面；
- 暂无完整运行历史查看能力；

## 相关文档

| 文档 | 说明 |
|---|---|
| `docs/SKILL_PRODUCT_PLAN.md` | 产品定位、MVP 范围与路线图 |
| `docs/PROJECT_SKILL_REFACTOR_PLAN.md` | Skill 化改造实施计划与 PR 策略 |
| `礼尚往来-详细开发计划与执行边界.md` | 执行引擎细则、安全门、状态机、错误码 |

---

## 开发路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 | 文档与能力状态统一 | ✅ 完成 |
| S0.5 | 真实点赞代码层硬阻断 | ✅ 完成 |
| S1 | `SKILL.md` + JSON 结构化输出 | ✅ 完成 |
| S2 | 只读互动收件箱 + `actions:pending` | ✅ 完成 |
| S3 | 评论审批闭环（prepare→approve→dry-run→confirm→execute） | ✅ 完成 |
| S4 | 好友回访候选预览（三阶段） | ✅ 完成 |

### 已完成

- [x] 浏览器登录态复用、评论/通知扫描与去重
- [x] dry-run / execute 模式隔离、防重复执行
- [x] 真实点赞 `FEATURE_DISABLED` 硬阻断
- [x] 根目录 `SKILL.md` 入口
- [x] 核心命令 `--json` 输出（Agent 可解析）
- [x] `actions:pending` 待处理报告（关联 action 状态）
- [x] 评论审批闭环：prepare → approve → dry-run → confirm-execute → execute
- [x] 代码层双确认（`execute_confirmed` 状态机）
- [x] 评论唯一定位（多字段匹配防错配）
- [x] 点赞回访候选预览（三阶段：actions:plan + visits:discover + likes:reciprocate 硬阻断）

### 下一步

- [ ] S5: 实验性单条回访验证（需身份核验 + 实验开关）

---

## 项目说明

“礼尚往来”是一款面向抖音创作者的 OpenClaw 互动助手 Skill 执行引擎。

> 别人认真评论了你，你不想漏回；  
> 好友给你点了赞，你也想回访一下；  
> 但所有互动都应该看得见、控得住、查得到。

项目的价值是"不漏掉值得回应的人"，而非"自动刷互动"。建议从页面探测和评论扫描开始使用。
