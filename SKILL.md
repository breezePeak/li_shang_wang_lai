---
name: li-shang-wang-lai
description: 礼尚往来 · 抖音创作者互动助手。发现评论与好友互动、生成回复建议，并在本人明确确认后安全执行单条评论回复。默认只预览，不自动操作。
---

# 礼尚往来 · 创作者互动助手

当用户希望查看抖音评论、互动通知、拟回复或预览好友回访候选时，使用本 Skill。

## 适用场景

以下用户请求应触发本 Skill：

| 用户说法 | Skill 应执行 |
|---|---|
| "看看有没有新评论"、"查看评论" | scan comment → 输出待处理报告 |
| "谁给我点赞了"、"看下互动通知" | scan like → 汇总候选 |
| "帮我回复这些评论" | 展示评论 + 生成回复草稿（不发送） |
| "给第 N 条拟回复：xxx" | prepare comment reply，等待确认 |
| "先预览回复位置" | dry-run 定位目标评论 |
| "确认发送这一条" | 校验审批 + execute 单条回复 |
| "看看好友回访候选"、"哪些朋友点赞了" | likes:plan，仅预览 |
| "自动给好友回赞"、"都回一下" | **拒绝**，提供候选预览和单条审批说明 |

## 禁止场景

以下请求必须拒绝，不得继续操作：

- 批量自动点赞或批量回复；
- 无人值守循环执行互动；
- 绕过验证码、滑块、登录校验或平台风控；
- MVP 阶段触发真实回访点赞（`likes:reciprocate --execute` 已被代码层硬阻断）；
- 仅凭昵称相同就执行回访点赞；
- Agent 自行决定真实发送内容（回复文本必须由用户提供）。

## 安全规则（硬约束）

| # | 规则 | 说明 |
|---|---|---|
| 1 | 默认只读 | 默认仅扫描、汇总、生成候选、dry-run |
| 2 | 真实动作必须双确认 | 评论回复需 approve + confirm_execute 两次确认 |
| 3 | 单轮最多 1 条 | MVP 每轮真实执行默认上限为 1 |
| 4 | 先 dry-run 后执行 | 真实发送前必须先 dry-run 定位成功 |
| 5 | 状态未知即阻断 | 页面定位、点赞状态、身份绑定时必须阻断 |
| 6 | 防重复 | 已成功执行过的事件不得重复操作 |
| 7 | 风控停止 | 验证码、登录失效、页面异常 → 立即停止 |
| 8 | 不泄露敏感数据 | 不将浏览器 Profile、Cookie、截图发送给第三方 |

## 可用命令

### 初始化

```bash
npm run db:init          # 初始化 SQLite 数据库
npm run auth             # 打开浏览器扫码登录（首次或登录失效时）
```

### 只读扫描（无需确认）

```bash
npm run interactions:scan -- --type comment --json    # 扫描评论，入库去重
npm run interactions:scan -- --type like --json       # 扫描点赞通知
npm run interactions:scan -- --type all --json        # 同时扫描评论和通知
npm run actions:pending -- --type comment --json      # 查看待处理评论摘要
npm run actions:pending -- --json                     # 查看全部待处理互动
```

### 评论回复流程（需逐步确认）

```bash
# 步骤 1：创建回复候选
npm run comments:prepare -- --event-id <id> --reply-text "<回复内容>" --json

# 步骤 2：用户确认回复内容后，审批该动作
npm run actions:approve -- --action-id <id> --json

# 步骤 3：dry-run 定位目标评论（不发送）
npm run comments:execute -- --action-id <id> --dry-run --json

# 步骤 4：dry-run 成功后，用户再次确认"发送"
npm run actions:confirm-execute -- --action-id <id> --json

# 步骤 5：真实发送（最多 1 条，要求状态为 execute_confirmed）
npm run comments:execute -- --action-id <id> --execute --max-items 1 --json
```

> **旧命令兼容**：`npm run comments:plan` 和 `npm run comments:reply -- --plan <文件>` 仍可用，但不作为 Skill 主流程推荐。

### 回访候选预览（仅预览）

```bash
npm run likes:plan -- --json       # 生成回访候选预览（JSON 输出）
npm run likes:plan                 # 人类可读输出
```

> **真实回访点赞**（`likes:reciprocate --execute`）在 MVP 阶段被代码层硬阻断。只会返回 `FEATURE_DISABLED`。Skill 不得尝试绕过。

## 评论回复完整流程

```text
用户请求查看评论
  ↓
npm run interactions:scan -- --type comment --json
  ↓
npm run actions:pending -- --type comment --json
  ↓
Skill 展示待处理评论摘要（昵称、作品、评论内容、当前状态）
  ↓
用户指定回复某条评论："给第 N 条拟回复：xxx"
  ↓
npm run comments:prepare -- --event-id <id> --reply-text "xxx" --json
  ↓
Skill 展示预览：目标用户 / 作品 / 原评论 / 回复文本
  ↓
用户说 "确认"
  ↓
npm run actions:approve -- --action-id <id> --json
  ↓
npm run comments:execute -- --action-id <id> --dry-run --json
  ↓
dry-run 成功 → 告知用户定位成功（原评论已找到，回复框已打开）
dry-run 失败 → 报告 blocked，停止
  ↓
用户说 "发送"
  ↓
npm run actions:confirm-execute -- --action-id <id> --json
  ↓
npm run comments:execute -- --action-id <id> --execute --max-items 1 --json
  ↓
成功 → 告知用户已发送 + 审计记录已保存
失败 → 报告原因 + 证据路径
```

## 回访候选预览流程

```text
用户请求查看好友回访候选
  ↓
npm run likes:plan -- --json
  ↓
Skill 输出候选清单（仅预览）：
  - 候选用户昵称
  - 页面识别关系（friend/mutual/unknown）
  - 目标主页 URL
  - 候选视频 URL 和标题
  - 当前点赞状态
  - 是否可预览 / 阻断原因
  ↓
明确告知：真实回访点赞在 MVP 阶段禁用
```

## 阻断场景处理

当脚本返回以下情况时，Skill 必须向用户报告并停止：

- `blocked` 状态 — 说明阻断原因（如找不到目标评论、点赞状态未知等）；
- `FEATURE_DISABLED` — 真实回访点赞默认禁用；
- `evidence` 目录中有截图或诊断文件 — 提醒用户可查看；
- 脚本异常退出或返回非 JSON — 告知用户错误信息并建议人工检查。

## 错误码速查

| 错误码 | 含义 | Skill 应 |
|---|---|---|
| `FEATURE_DISABLED` | 功能默认禁用 | 告知用户并停止 |
| `LOGIN_REQUIRED` | 需要重新登录 | 提示运行 `npm run auth` |
| `ACTION_NOT_APPROVED` | 任务未审批 | 提示需要先确认 |
| `DUPLICATE_ACTION` | 已执行过 | 告知已处理，跳过 |
| `MAX_ITEMS_REACHED` | 达到单轮上限 | 正常停止 |
| `BLOCKED` / `LIKE_STATE_UNKNOWN` | 状态不确定 | 说明原因并阻断 |
| `RATE_LIMITED` | 疑似风控 | 立即停止本轮 |

## 当前版本限制

- 评论回复流程：`prepare → approve → dry-run → confirm-execute → execute`
- 好友回访仅提供候选预览，真实点赞代码层硬阻断
