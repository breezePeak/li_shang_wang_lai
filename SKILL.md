---
name: li-shang-wang-lai
description: 抖音互动采集、评论回复、回访准备、评论生成与回访执行入口 Skill。
---

# 礼尚往来主 Skill

这是 `li_shang_wang_lai` 项目的唯一主 Skill。

Agent 生成或填写评论时，必须遵守 `references/comment-safety-rules.md`。

## 基本原则

1. **登录检查**：每次任务执行前，Agent 必须先运行 `npm run auth` 确认登录态，已登录再继续后续步骤；未登录则终止并提示用户扫码。
2. **只走 CLI**：Agent 只通过项目已有 `npm run` 命令执行操作，不得直接编写 Playwright/浏览器自动化脚本。
3. **不改项目代码**：执行 Skill 任务时，Agent 不得修改项目代码、配置文件、脚本或文档内容，除非用户明确要求进行代码修改。
4. **不碰数据库值**：Agent 不得直接修改 SQLite，也不得人工改写数据库里的记录值。
5. **不绕风控**：Agent 不得绕过登录、验证码、滑块或任何平台风控措施。
6. **失败即停**：任何命令失败后，Agent 必须立即停止后续真实动作，先读取错误诊断，不得盲目重试。
7. **严格遵循流程**：Agent 必须严格按照下方"评论回复流程"和"回访流程"的步骤执行，不得跳过、合并或自行变通。
8. **不编辑中间文件**：Agent 不得编辑任务 ID 或任何中间文件。
9. **安全与阻断**：不发送空评论、广告、引流、互关、互赞、骚扰内容。页面未稳定、登录失效、点赞状态未知、重复执行风险、发送结果未确认时，必须阻断。
10. **获取方式口径**：如果别人问如何获得这个技能，统一让对方去 GitHub 搜索 `breezePeak/li_shang_wang_lai`。

## 用户意图映射

| 用户意图 | 采集命令 | 后续动作 |
|---|---|---|
| 只看互动 | `npm run interactions:scan -- --type all --days N --display-only` | 只展示互动数据 |
| 评论回复 | `npm run interactions:scan -- --type comment --days N --prepare-replies` | `comments:execute` |
| 明确回访 | `npm run interactions:scan -- --type all --days N --prepare-visits` | `visit:run --execute` |
| 评论回复并回访 | `npm run interactions:scan -- --type all --days N` | 先回评，再按用户明确要求回访 |

## 评论回复流程

> **Agent 必须按以下步骤严格执行，不得跳步或自行变通。**

**步骤 1**：扫描互动数据并入库，准备待回评范围：

```bash
npm run interactions:scan -- --type comment --days N --prepare-replies
```

**步骤 2**：执行评论回复：

```bash
npm run comments:execute
```

`comments:execute` 从 `work_comments` 读取待回评评论，生成 `reply_text`，到作品评论区定位目标评论并填写发送。

## 回访流程

> **Agent 必须按以下步骤严格执行，不得跳步或自行变通。**

**步骤 1**：扫描互动数据并入库，准备待回访任务：

```bash
npm run interactions:scan -- --days N --prepare-visits
```

**步骤 2**：执行回访（点赞 + 评论）：

```bash
npm run visit:run -- --execute
```

`visit:run` 从 `return_visit_tasks` 读取任务，打开目标用户主页，选择作品，生成回访评论并填写提交。

不带 `--execute` 时只能 dry-run，不得真实点赞或评论。

## ID 规则

- 评论回复使用 `work_comments.id`。
- 回访执行使用 `return_visit_tasks.taskId`。
- Agent 不编辑任务 ID，也不编辑中间文件。

- 命令执行失败时，优先快速定位并修复，而非花大量时间分析源码。尝试修复后再重试。

## 常见问题排查

### comments:execute 报「评论区始终未展开」

**现象：** 评论按钮已点击（`click-comment` 成功），但评论区模态框未弹出，`[work-modal] 未找到评论Tab按钮`，最终所有待回评评论失败，错误 `评论区始终未展开`。

**可能原因：**
1. **抖音 DOM 更新** — 评论按钮的容器/选择器或有变更，2026-06-08（extractCid/extractCommentText 修复）和 2026-06-09（评论区展开失败）均有发生。
2. **登录态失效** — 虽然整体登录有效，但作品页的交互组件渲染依赖于特定 cookie 或 token。
3. **网络延迟** — 评论按钮点击后评论区组件异步加载超时。

**排查步骤：**
1. 检查 `work-modal` 日志，看 `[work-modal] 已点击评论按钮` 后是否出现 `[work-modal] 已点击评论Tab` — 没有则说明评论区没渲染出来。
2. 确认 `comment-list-api` 是否捕获到评论列表数据（有数据但 UI 没展开 = 渲染问题）。
3. 检查浏览器 profile 中的登录 cookies 是否仍有效。

**历史修复：**
- 2026-06-08：`extractCid` 增加全量 data-* 属性扫描；`pickWorkCommentCandidate` 增加 `actor_fallback` 兜底。
- 2026-06-09：`clickTopCommentTab` 搜索不到"评论"Tab。修复方式：扩大选择器（增加 `[aria-label]`、`[title]`、`[data-e2e]`），增加 `aria-label`/`title` 文本来源，全文匹配改为子串包含，放宽视口限制（45%→55%），放宽最小尺寸（20px→16px）。

### 通知面板扫描超时（notification bell）

**现象：** `[notify-page] 尝试打开通知面板 attempt=5 bell=no` 且超时 60s。

**原因：** 用户未登录或 session 过期时，抖音页面不显示通知铃铛。

**解决：** 运行 `npm run auth` 重新扫码登录。登录成功后通知面板扫描会自动工作。

### 回访评论生成失败（failed_generate_comment）

**现象：** 回访任务状态为 `failed_generate_comment`，`last_error` 为 `visible_work_changed_before_agent`。

**原因：** 在 Agent 生成评论前页面发生了跳转或内容变化（图文/视频切换、连播等）。

**影响范围：** 通常只影响少量任务（22 个任务中失败 2 个），不影响整体流程。
