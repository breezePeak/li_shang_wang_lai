# 礼尚往来
```text
 Agent 用的抖音互动处理 Skill。
```



## 项目是什么

`li_shang_wang_lai` 是一个抖音互动处理工具，主要给 Hermes / OpenClaw 这类 Agent 使用。

## 解决什么问题

抖音通知中心信息多，人工处理容易漏。

尤其是：

- 有人评论了你的作品；
- 好友/互关用户给你点赞或评论；
- 你想回访，但不想一个个手动找主页；
- 你不想复制粘贴同一句评论；
- 你不想批量刷互动，只想回应值得回应的人。

这个项目的目标是：

```text
不漏掉值得回应的人
```

## 安装

需要 Node.js 24+。

```bash
git clone https://github.com/breezePeak/li_shang_wang_lai.git
cd li_shang_wang_lai
npm install
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

运行测试：

```bash
npm test
```

## 主流程怎么跑

### 1. 扫描通知中心

```bash
npm run interactions:scan -- --type all --json --debug
```

这一步会打开抖音通知中心，采集评论和点赞通知，并写入本地数据库。

### 2. 生成候选计划

```bash
npm run actions:plan -- --json
```

这一步会生成两类候选：

```text
replyCommentCandidates：评论回复候选
visitWorkCandidates：好友/互关用户作品回访候选
```

### 3. 获取作品上下文

默认使用 `skill` 模式，适合 Hermes / OpenClaw 调用：

```bash
npm run visits:live-review -- --comment-mode skill --json --max-items 1
```

这一步会：

```text
进入好友/互关主页
→ 找最近非置顶作品
→ 打开作品
→ 检查点赞状态
→ 已点赞：跳过
→ 未点赞：输出 commentContext 给 Agent
→ 状态未知：阻断
```

如果发现未点赞作品，会输出类似结构：

```json
{
  "needsAgentComment": true,
  "commentMode": "skill",
  "commentContext": {
    "actorName": "用户昵称",
    "targetWorkUrl": "https://www.douyin.com/video/xxx",
    "targetWorkId": "video-xxx",
    "targetWorkTitle": "作品标题",
    "captionText": "页面文案",
    "hashtags": ["话题"],
    "authorName": "作者名",
    "visibleTextSample": "页面可见文本片段"
  }
}
```

Hermes / OpenClaw 根据 `SKILL.md` 和 `commentContext` 生成评论候选，并让用户选择。

### 4. 执行用户选中的评论

用户选好评论后，再调用：

```bash
npm run visits:live-review -- --comment-mode skill --execute --max-items 1 \
  --selected-comment-text "这个主题挺温柔的～" \
  --reply-mode agent_generated_review_required \
  --risk-level medium \
  --manual-review-method user_selected_agent_comment
```

注意：

```text
skill 模式传入 --selected-comment-text 时，必须 --max-items 1。
一条评论只能对应一个作品上下文，不能批量套用到多个作品。
```

## 三种 comment-mode 怎么选

`visits:live-review` 支持三种评论模式：

| 模式 | 用途 | 评论来源 | 状态 |
|---|---|---|---|
| `skill` | 给 Hermes / OpenClaw 使用 | 外部 Agent 根据 `SKILL.md` 生成 | 推荐默认 |
| `local` | 本地调试 | 本地规则生成器 | 可用 |
| `agent` | 项目自己调用大模型 | 内置 LLM provider | 预留，暂未实现 |

### skill 模式

推荐给 Hermes / OpenClaw 使用。

```bash
npm run visits:live-review -- --comment-mode skill --json --max-items 1
```

特点：

- CLI 不生成评论；
- CLI 只提取作品上下文；
- 外部 Agent 根据 `SKILL.md` 生成评论；
- 用户选择后，Agent 把评论传回 CLI；
- CLI 做安全校验和当前页执行。

### local 模式

本地规则生成器模式，适合调试。

```bash
npm run visits:live-review -- --comment-mode local --max-items 5
```

特点：

- 不依赖 Hermes / OpenClaw；
- 不调用大模型；
- CLI 根据标题、话题、文案生成评论候选；
- 适合测试页面打开、点赞状态识别、评论输入框定位。

执行模式：

```bash
npm run visits:live-review -- --comment-mode local --execute --max-items 5
```

每条仍然需要用户手动选择 `1/2/3`，不允许批量确认。

### agent 模式

项目内置大语言模型模式，当前只是预留。

```bash
npm run visits:live-review -- --comment-mode agent --max-items 5
```

当前会返回：

```text
FEATURE_DISABLED
```

后续如果项目要脱离 Hermes / OpenClaw 独立运行，可以在这个模式里接入大模型。

## comments:reply 按作品分组处理

`comments:reply` 执行评论回复时，会按作品分组处理：

- 同一作品下的评论聚合为一组，只切换一次作品选中状态；
- 分组键优先级：`workId` → `workUrl` → `workTitle` → `__unknown_work__`；
- 作品选择失败时，该组所有评论标记为 blocked；
- 同一 eventId 的回复只执行一次（防重复）；
- 支持 `--dry-run` 定位和 `--execute` 真实发送，`--max-items` 限制总执行数。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run auth` | 打开浏览器扫码登录抖音 |
| `npm run db:init` | 初始化 SQLite 数据库 |
| `npm run interactions:scan -- --type all --json --debug` | 扫描通知中心 |
| `npm run actions:plan -- --json` | 生成评论回复和作品回访候选 |
| `npm run visits:discover -- --json --max-items 5` | 发现好友作品并检查点赞状态 |
| `npm run visits:live-review -- --comment-mode skill --json --max-items 1` | Skill 模式，输出作品上下文 |
| `npm run visits:live-review -- --comment-mode local --max-items 5` | Local 模式，本地生成评论候选 |
| `npm run comments:reply -- --plan <文件> [--dry-run\|--execute]` | 按作品分组批量回复评论 |
| `npm test` | 运行测试 |

## Skill 入口

外部 Agent 请读取：

```text
SKILL.md
```

`SKILL.md` 里定义了 Agent 生成评论时必须遵守的规则。

## 安全规则

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
| skill + maxItems=1 | skill 模式传入 selected-comment-text 时必须 max-items 1 |

## 使用边界

- 首次使用只进行页面探测和少量评论扫描；
- 执行回复前，人工核对目标评论与回复内容；
- 不要将浏览器登录态目录分享给他人；
- 页面定位异常时立即停止真实操作；
- 出现登录校验、验证码、页面结构变化时，不要继续批量执行；
- MVP 阶段禁止真实点赞回访（代码层 `FEATURE_DISABLED` 硬阻断）；
- skill 模式一条 selected-comment-text 只能对应一个作品上下文；
- 使用者应自行确认并遵守平台规则及账号安全要求。
