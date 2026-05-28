# 礼尚往来

基于 **Playwright + SQLite** 的抖音创作者互动辅助工具。

它的目标不是做无边界的自动操作，而是帮助创作者整理真实互动：发现评论与点赞通知、保存处理记录，并在人工确认后完成安全的互动回访。

> 当前项目仍处于早期开发阶段。现阶段重点是评论扫描与评论回复流程验证；“好友点赞后访问主页并回赞”尚未完成，请勿将其视为可用功能。

---

## 功能定位

你可能每天都会遇到这些情况：

- 有人给作品留言，但容易漏回；
- 有好友给作品点赞，想回访对方最近的视频；
- 互动数量多了以后，不记得哪些已经处理过；
- 不希望把账号交给完全自动、不可控的脚本。

**礼尚往来**希望提供一套可检查、可记录、可人工确认的处理流程：

```text
扫码登录
  ↓
扫描评论 / 互动通知
  ↓
本地保存事件并去重
  ↓
生成待处理计划
  ↓
人工确认
  ↓
执行回复或回访动作
```

---

## 当前版本状态

当前版本：`0.1.0`

| 功能 | 状态 | 说明 |
|---|---|---|
| 复用浏览器登录态 | 已实现 | 使用 Playwright 持久化 Profile |
| 页面诊断采集 | 已实现 | 可保存页面文本、DOM、截图等诊断材料 |
| 评论扫描 | 初版已实现 | 从创作者评论页面尝试提取评论并入库 |
| 通知与点赞扫描 | 初版已实现 | 通知面板 hover 铃铛、滚动提取点赞事件 |
| SQLite 本地记录与事件去重 | 已实现 | 保存互动事件与动作审计 |
| 评论回复计划生成 | 初版已实现 | 生成 JSON 计划供人工填写和确认 |
| 评论回复执行 | 验证阶段 | 已有执行代码，使用前请先小范围测试 |
| 好友点赞回访计划 | 开发验证中 | 已完成通知直达主页的代码探索，尚未完成稳定身份绑定与安全审批闭环 |
| 好友作品回赞执行 | 暂不可用 | 当前仅供开发调试，请勿执行真实回赞 |
| 历史记录查看页面 | 未实现 | 当前仅保留命令入口 |
| 本地管理后台 | 未实现 | 后续规划 |

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

### 第三步：扫描评论

```bash
npm run interactions:scan -- --type comment
```

程序会尝试打开评论管理页面，提取当前可见评论，并将新事件写入本地数据库。

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

> **重要提醒：** 当前评论回复模块仍处于验证阶段，目前还没有完整的 dry-run 安全预览模式。请只对少量测试评论执行，并在浏览器中人工核对目标评论与回复结果。

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

### 尚未可用的命令

下面两个命令入口已经存在，但**暂不可用于真实回赞**：

```bash
npm run likes:plan
npm run likes:reciprocate
```

> **⚠️ 当前请勿执行真实回赞操作。** 点赞回访仍在安全重构阶段，必须等待计划审批、dry-run 隔离及目标身份绑定完成后才可正式使用。当前 `likes:reciprocate --execute` 已加硬拦截，需提供 `--plan` 且完成审批链路。

---

## 常用命令

| 命令 | 说明 | 当前状态 |
|---|---|---|
| `npm run auth` | 打开浏览器扫码登录并保存登录态 | 可用 |
| `npm run db:init` | 初始化 SQLite 数据库 | 可用 |
| `npm run interactions:inspect -- --page comment` | 采集评论页诊断信息 | 可用 |
| `npm run interactions:inspect -- --page like` | 采集点赞相关页面诊断信息 | 可用 |
| `npm run interactions:scan -- --type comment` | 扫描评论并写入数据库 | 初版可用 |
| `npm run interactions:scan -- --type like` | 尝试扫描点赞通知 | 验证阶段 |
| `npm run interactions:scan -- --type all` | 尝试同时扫描评论和点赞通知 | 验证阶段 |
| `npm run comments:plan` | 生成待回复评论计划 | 初版可用 |
| `npm run comments:reply -- --plan <路径>` | 执行已审批评论回复 | 验证阶段 |
| `npm run likes:plan` | 生成好友回赞计划（通知面板扫描） | 开发验证中 |
| `npm run likes:reciprocate` | 执行好友回赞 | 暂不可用 |
| `npm run history` | 查看处理历史 | 未实现 |
| `npm run server` | 启动本地管理页面 | 未实现 |
| `npm test` | 运行测试 | 已配置 |

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

本项目旨在辅助个人管理真实互动，不鼓励无审核、无边界的批量自动操作。

请遵守以下原则：

- 首次使用只进行页面探测和少量评论扫描；
- 执行回复前，人工核对目标评论与回复内容；
- 不要将浏览器登录态目录分享给他人；
- 页面定位异常时立即停止真实操作；
- 出现登录校验、验证码、页面结构变化时，不要继续批量执行；
- 在点赞回访功能正式完成并验证前，不要依赖相关命令执行实际回赞；
- 使用者应自行确认并遵守平台规则及账号安全要求。

---

## 当前已知限制

- 抖音页面结构可能更新，导致文本定位或通知解析失效；
- 当前评论回复执行仍需人工小规模验证；
- 失败时浏览器调试体验仍在改进中；
- 暂无可视化管理界面；
- 暂无完整运行历史查看能力；
- 好友点赞回访功能基础流程已实现，通知面板提取和页面导航仍在验证中；

---

## 开发路线

### 近期目标

- [x] 失败时保留浏览器并保存完整现场证据
- [x] 增加安全的 dry-run / execute 模式
- [x] 修复评论回复结果记录流程
- [x] 跑通单条评论审批回复闭环
- [x] 实现点赞回访基础流程（通知面板 → 主页 → 视频 → 点赞）

### 后续目标

- [ ] 稳定验证通知面板中的点赞用户与关系信息
- [ ] 经人工审批执行单条回赞
- [ ] 增加本地审核与历史管理页面

---

## 项目说明

“礼尚往来”希望解决的是创作者互动中的实际小问题：

> 别人认真评论了你，你不想漏回；  
> 好友给你点了赞，你也想回访一下；  
> 但所有互动都应该看得见、控得住、查得到。

项目仍在持续完善中，建议从页面探测和评论扫描开始使用。
