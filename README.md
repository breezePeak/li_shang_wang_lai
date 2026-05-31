# 礼尚往来 · li_shang_wang_lai

一个基于 Playwright 的抖音创作者互动助手。

用于帮助创作者扫描评论和点赞互动，整理待处理任务，准备评论回复，生成回访任务，并在用户确认后执行评论回复或作品回访。

> 礼尚往来：别人给你点赞或评论，你可以回看对方作品，并进行自然、克制、可追踪的互动。

---

## 项目能做什么

当前项目主要支持：

- 扫描抖音通知中心；
- 采集评论互动；
- 采集点赞互动；
- 查看待处理互动；
- 准备评论回复；
- 执行已确认的评论回复；
- 从互动事件生成回访任务；
- 进入互动用户主页；
- 查找最近合适作品；
- 采集作品内容和参考评论；
- 生成回访评论；
- 执行回访：点赞 + 评论；
- 记录执行结果；
- 保存失败截图和调试信息。

---

## 项目不是什么

本项目不是刷量工具，也不是无人值守批量互动工具。

不建议用于：

- 批量点赞；
- 批量评论；
- 批量互关；
- 批量引流；
- 绕过验证码、滑块或平台风控；
- 无人值守循环执行互动。

本项目的目标是：

```text
不漏掉值得回应的人
```

而不是：

```text
批量制造互动痕迹
```

---

## 环境要求

需要：

```text
Node.js >= 20
```

安装依赖：

```bash
npm install
```

安装 Playwright Chromium：

```bash
npx playwright install chromium
```

初始化数据库：

```bash
npm run db:init
```

首次登录抖音：

```bash
npm run auth
```

该命令会打开浏览器，请手动完成登录。

---

## 快速开始

### 1. 登录账号

```bash
npm run auth
```

### 2. 扫描全部互动

```bash
npm run interactions:scan -- --type all --json
```

### 3. 查看待处理互动

```bash
npm run actions:pending -- --json
```

### 4. 准备回访任务

```bash
npm run return-visit:prepare -- --json --max-items 5
```

### 5. 预演回访执行

```bash
npm run return-visit:execute -- --dry-run --json
```

### 6. 执行回访任务

当前版本中，`return-visit:execute` 不带 `--dry-run` 即会执行真实回访：

```bash
npm run return-visit:execute -- --json
```

真实回访会执行：

```text
打开目标作品
检查点赞状态
点赞或确认已点赞
发表评论
记录执行结果
```

---

## 主流程

推荐完整流程：

```bash
npm run interactions:scan -- --type all --json
npm run actions:pending -- --json
npm run return-visit:prepare -- --json --max-items 5
npm run return-visit:execute -- --dry-run --json
npm run return-visit:execute -- --json
```

流程说明：

1. `interactions:scan` 从抖音通知中心采集点赞和评论互动；
2. `actions:pending` 查看当前待处理互动；
3. `return-visit:prepare` 根据互动事件生成回访任务，进入对方主页，采集作品上下文，生成评论；
4. `return-visit:execute --dry-run` 预演执行，不真实点赞、不真实评论；
5. `return-visit:execute` 执行真实回访。

---

## 互动扫描

扫描全部互动：

```bash
npm run interactions:scan -- --type all --json
```

只扫描评论：

```bash
npm run interactions:scan -- --type comment --json
```

只扫描点赞：

```bash
npm run interactions:scan -- --type like --json
```

查看待处理互动：

```bash
npm run actions:pending -- --json
```

查看待处理评论：

```bash
npm run actions:pending -- --type comment --json
```

---

## 评论回复流程

评论回复指的是：

```text
别人评论了我的作品，我在评论管理页回复这条评论
```

它和“回访”不是一个流程。

标准流程：

```text
扫描评论
  ↓
查看待处理评论
  ↓
准备回复
  ↓
审批回复
  ↓
dry-run 定位
  ↓
真实发送
```

### 1. 扫描评论

```bash
npm run interactions:scan -- --type comment --json
```

### 2. 查看待处理评论

```bash
npm run actions:pending -- --type comment --json
```

### 3. 准备评论回复

```bash
npm run comments:prepare -- --event-id <eventId> --reply-text "<回复内容>" \
  --decision reply \
  --risk-level low \
  --relevance relevant \
  --decision-reason "<回复理由>" \
  --json
```

### 4. 审批回复

```bash
npm run actions:approve -- --action-id <actionId> --json
```

### 5. dry-run 定位

```bash
npm run comments:execute -- --action-id <actionId> --dry-run --json
```

dry-run 只定位原评论和回复框，不会真实发送。

### 6. 真实发送回复

```bash
npm run comments:execute -- --action-id <actionId> --execute --max-items 1 --json
```

---

## 批量评论回复计划

如果已经有评论回复计划文件，可以使用：

```bash
npm run comments:reply -- --plan <计划文件路径> --dry-run
```

真实执行：

```bash
npm run comments:reply -- --plan <计划文件路径> --execute --max-items 1
```

`comments:reply` 会：

```text
打开评论管理页
按作品分组
每个作品只切换一次
连续处理同一作品下的多条评论
```

---

## 回访流程

回访指的是：

```text
别人给我点赞或评论后，我进入对方主页，找到合适作品，进行点赞 + 评论
```

在本项目中：

```text
回访 = 点赞 + 评论
```

已点赞不代表回访完成。

完整回访完成条件是：

```text
点赞成功或已经点赞
并且
评论成功发布或确认发布
```

---

## 回访准备

准备回访任务：

```bash
npm run return-visit:prepare -- --json
```

限制本轮准备数量：

```bash
npm run return-visit:prepare -- --json --max-items 5
```

指定事件来源状态：

```bash
npm run return-visit:prepare -- --json --event-status new
```

该命令会：

- 从互动事件中创建或更新回访任务；
- 打开互动用户主页；
- 查找最近合适作品；
- 打开目标作品；
- 采集作品标题、正文、话题、页面可见文本；
- 采集参考评论；
- 生成一条回访评论；
- 将任务标记为待执行。

准备阶段不会点赞，也不会发表评论。

---

## 回访执行

### dry-run 预演

```bash
npm run return-visit:execute -- --dry-run --json
```

dry-run 用于检查待执行任务和页面状态。

### 真实执行

```bash
npm run return-visit:execute -- --json
```

当前版本中：

```text
不带 --dry-run 即代表真实执行
```

真实执行会：

- 打开目标作品；
- 检查点赞状态；
- 未点赞则点赞；
- 已点赞则继续；
- 发送已生成的回访评论；
- 记录点赞状态；
- 记录评论状态；
- 更新任务结果。

---

## Skill 支持

本项目可以配合 Hermes / OpenClaw 等 Agent 使用。

推荐 Skill 结构：

```text
skills/
├── creator-comment-suggestion/
│   └── SKILL.md
└── creator-interaction-executor/
    └── SKILL.md
```

### creator-comment-suggestion

负责根据作品上下文生成一条自然、安全、克制的中文评论建议。

### creator-interaction-executor

负责互动执行流程。

当执行流程需要生成评论时，应读取或调用：

```text
skills/creator-comment-suggestion/SKILL.md
```

执行 Skill 不应自己自由发挥生成评论。

---

## 评论人格配置

如果用户希望评论中带一个对外人格名，可以配置：

```json
{
  "agentDisplayName": "小猿"
}
```

说明：

- `agentDisplayName` 是用户自定义名称；
- 不同用户可以配置不同名称；
- Skill 不应硬编码“小猿”；
- 没有配置时，不强制带人格名称。

---

## 安全原则

本项目内置以下安全约束：

- 默认先扫描、预览、准备；
- 真实操作前应由用户确认；
- 状态未知时阻断；
- 登录失效时停止；
- 出现验证码、滑块、风控时停止；
- 不绕过平台限制；
- 不重复执行已成功任务；
- 不发送空评论；
- 不发送带有互关、引流、广告、骚扰意味的评论；
- 执行失败时记录原因和调试证据。

---

## 免责声明

本项目仅用于辅助创作者处理真实互动。

使用者应遵守平台规则，不得将本项目用于刷量、骚扰、引流、垃圾评论、绕过风控或其他违规用途。
