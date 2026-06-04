# local.json 配置说明

本文说明 `config/local.json` 的用途、加载规则、字段含义，以及推荐的调整方式。

## 1. 加载规则

- 程序统一从 `config/local.json` 读取本地配置。
- `local.json` 属于本机运行配置，已被 `.gitignore` 忽略，不会提交到仓库。
- 如果 `local.json` 不存在，程序会回退到代码内置默认值。

适合放进 `local.json` 的内容：

- 本机浏览器启动参数
- 自动化滚动策略
- 自己账号的身份信息
- 回访执行节奏、等待时间、观看时长

不建议放进 `local.json` 的内容：

- 数据库路径这类更适合环境变量的配置
- 临时排障参数
- 只在单次命令中生效的临时 CLI 参数

## 2. 完整示例

```json
{
  "self": {
    "profileKey": "",
    "profileUrl": "",
    "nickname": ""
  },
  "browser": {
    "headless": false,
    "profileDir": ".playwright/douyin-profile",
    "slowMo": 150,
    "viewport": {
      "width": 1280,
      "height": 800
    }
  },
  "scroll": {
    "mouseMove": {
      "xOffset": 0.5,
      "yOffset": 0.5,
      "steps": 5,
      "waitMs": 100
    },
    "wheel": {
      "defaultDeltaY": 600,
      "deltaYRandomRange": [0, 0],
      "waitMs": 1200
    },
    "notificationPanel": {
      "deltaY": 600,
      "deltaYRandomRange": [0, 120],
      "waitMs": 1200
    },
    "commentArea": {
      "deltaY": 600,
      "deltaYRandomRange": [0, 80],
      "waitMs": 1200
    }
  },
  "comments": {
    "enabled": true,
    "mode": "manual",
    "maxPerRun": 10,
    "maxReplyLength": 400
  },
  "likes": {
    "enabled": true,
    "mode": "manual",
    "allowedRelations": ["friend", "mutual"],
    "maxPerRun": 5,
    "skipPinned": true,
    "requireLatestWorkConfirmed": true
  },
  "returnVisit": {
    "enabled": true,
    "eventSourceStatus": "new",
    "maxWorksToCheck": 3,
    "maxRetryCount": 2,
    "maxConsecutiveFailures": 3,
    "pageLoadRetryCount": 1,
    "maxReferenceComments": 5,
    "watchPolicy": "seconds",
    "watchSeconds": [5, 8],
    "waitBetweenUsersMs": [8000, 20000],
    "waitBetweenLikeAndCommentMs": [2000, 6000],
    "restEveryTasksRange": [8, 12],
    "restDurationMs": [60000, 180000]
  },
  "safety": {
    "stopOnLoginRequired": true,
    "stopOnCaptcha": true,
    "captureScreenshotOnAction": true,
    "captureScreenshotOnFailure": true
  }
}
```

## 3. 字段说明

### 3.1 `self`

用于识别“这是不是自己的作品/主页”。

- `profileKey`
  - 自己抖音主页的 `user key`
  - 优先级最高，最稳定
- `profileUrl`
  - 自己主页 URL
  - 在拿不到 `profileKey` 时可作为比对依据
- `nickname`
  - 自己昵称
  - 仅作为低置信度兜底

建议：

- 优先填写 `profileKey`
- `profileUrl` 和 `nickname` 作为补充

### 3.2 `browser`

控制 Playwright 浏览器启动参数。

- `headless`
  - 是否无头启动
  - 建议调试时设为 `false`
- `profileDir`
  - 浏览器用户数据目录
  - 用于复用登录态
- `slowMo`
  - Playwright 每步操作额外延迟，单位毫秒
  - 页面不稳定时可以适当加大
- `viewport.width` / `viewport.height`
  - 浏览器窗口尺寸

建议：

- 页面元素定位不稳定时，优先固定窗口尺寸
- 机器性能一般时，可以把 `slowMo` 提高到 `200` 到 `300`

### 3.3 `scroll`

控制“鼠标移入 DOM 后再滚动”的公共策略。通知面板滚动、评论区滚动都依赖这里。

#### `scroll.mouseMove`

控制鼠标落点和移动节奏。

- `xOffset`
  - 鼠标落在容器宽度上的相对位置
  - `0` 表示最左，`0.5` 表示中间，`1` 表示最右
- `yOffset`
  - 鼠标落在容器高度上的相对位置
- `steps`
  - 鼠标移动分几步完成
- `waitMs`
  - 鼠标移入容器后，滚动前额外等待多久

建议：

- 如果 hover 很敏感，优先调整 `xOffset` / `yOffset`
- 如果页面对鼠标进入有延迟反应，可增大 `waitMs`

#### `scroll.wheel`

通用滚动默认值。

- `defaultDeltaY`
  - 每次滚轮基础滚动距离
- `deltaYRandomRange`
  - 在基础滚动距离上附加的随机量区间
  - 例如 `[0, 120]` 表示每次在 `defaultDeltaY` 基础上再加 `0` 到 `120`
- `waitMs`
  - 滚动完成后的等待时间

建议：

- 如果滚动后内容来不及加载，先增大 `waitMs`
- 如果容易一次滚过头，先减小 `defaultDeltaY`

#### `scroll.notificationPanel`

通知面板滚动覆盖值。未填写时使用 `scroll.wheel`。

- `deltaY`
- `deltaYRandomRange`
- `waitMs`

适用位置：

- `interactions:scan`
- 通知面板 hover 后的连续滚动

建议：

- 通知列表通常可以比评论区滚动得更大一点
- 推荐先从 `600 + [0,120]` 开始试

#### `scroll.commentArea`

作品评论区滚动覆盖值。未填写时使用 `scroll.wheel`。

- `deltaY`
- `deltaYRandomRange`
- `waitMs`

适用位置：

- 作品 modal 评论区
- 评论回复定位滚动

建议：

- 评论区更容易错过目标，通常随机量应比通知面板更保守
- 推荐从 `600 + [0,80]` 开始试

## 4. `comments`

评论相关配置。

- `enabled`
  - 是否启用评论模块
- `mode`
  - 评论执行模式
- `maxPerRun`
  - 单轮最多处理多少条
- `maxReplyLength`
  - 回复文本最大长度

## 5. `likes`

点赞相关配置。

- `enabled`
  - 是否启用点赞模块
- `mode`
  - 点赞模式
- `allowedRelations`
  - 允许操作的关系类型
- `maxPerRun`
  - 单轮最多处理多少条
- `skipPinned`
  - 是否跳过置顶内容
- `requireLatestWorkConfirmed`
  - 是否要求确认最新作品后再执行

## 6. `returnVisit`

回访执行相关配置。

- `enabled`
  - 是否启用回访
- `eventSourceStatus`
  - 从事件表里读取哪些状态的源事件
- `maxWorksToCheck`
  - 从用户主页最多检查多少个作品
- `maxRetryCount`
  - 任务最大重试次数
- `maxConsecutiveFailures`
  - 连续失败多少次后停止当前轮
- `pageLoadRetryCount`
  - 页面加载失败后重试次数
- `maxReferenceComments`
  - 采集参考评论条数上限
- `watchPolicy`
  - 视频观看策略
  - 常用值：`seconds`、`full`
- `watchSeconds`
  - 当 `watchPolicy=seconds` 时的观看秒数范围
- `waitBetweenUsersMs`
  - 用户与用户之间的等待区间
- `waitBetweenLikeAndCommentMs`
  - 点赞和评论之间的等待区间
- `restEveryTasksRange`
  - 做多少个任务后休息一次
- `restDurationMs`
  - 每次休息多久

## 7. `safety`

安全与证据保留相关配置。

- `stopOnLoginRequired`
  - 遇到登录失效时是否停止
- `stopOnCaptcha`
  - 遇到验证码时是否停止
- `captureScreenshotOnAction`
  - 操作时是否截图
- `captureScreenshotOnFailure`
  - 失败时是否截图

## 8. 推荐调参顺序

如果你遇到“滚不动、滚过头、目标加载太慢”这类问题，建议按下面顺序调：

1. 先调 `scroll.notificationPanel.waitMs` 或 `scroll.commentArea.waitMs`
2. 再调 `deltaY`
3. 最后再加 `deltaYRandomRange`

如果你遇到“鼠标移进去面板就消失、hover 不稳定”，建议调：

1. `scroll.mouseMove.xOffset`
2. `scroll.mouseMove.yOffset`
3. `scroll.mouseMove.waitMs`

## 9. 变更生效方式

- 修改 `config/local.json` 后，重新执行命令即可生效
- 不需要重新安装依赖
- 不需要重新初始化数据库
