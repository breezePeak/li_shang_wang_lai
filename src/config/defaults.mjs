export const DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK = 10;
export const DEFAULT_RETURN_VISIT_WORK_TIMEOUT_MS = 3 * 60 * 1000;

// 默认配置常量 — 占位，由 config/local.json 覆盖
export const DEFAULTS = {
  self: {
    profileKey: '',
    profileUrl: '',
    nickname: '',
  },
  browser: {
    headless: false,
    profileDir: '.playwright/douyin-profile',
    slowMo: 150,
    viewport: {
      width: 1280,
      height: 800,
    },
  },
  scroll: {
    mouseMove: {
      xOffset: 0.5,
      yOffset: 0.5,
      steps: 5,
      waitMs: 100,
    },
    wheel: {
      defaultDeltaY: 600,
      deltaYRandomRange: [0, 500],
      waitMs: 1200,
    },
    notificationPanel: {
      deltaY: 600,
      deltaYRandomRange: [0, 500],
      waitMs: 1200,
    },
    commentArea: {
      deltaY: 600,
      deltaYRandomRange: [0, 500],
      waitMs: 1200,
    },
  },
  comments: {
    enabled: true,
    mode: 'manual',
    maxPerRun: 10,
    maxReplyLength: 400,
  },
  likes: {
    enabled: false,
    experimentalExecuteEnabled: false,
    mode: 'preview',
    allowedRelations: ['friend', 'mutual'],
    maxPerRun: 5,
    skipPinned: true,
    requireLatestWorkConfirmed: true,
  },
  returnVisit: {
    enabled: true,
    eventSourceStatus: 'new',
    maxWorksToCheck: DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK,
    restartBrowserEveryTasks: 5,
    allLikedFallbackEnabled: true,
    allLikedFallbackComments: [
      '蹲个更新呀～',
    ],
    maxRetryCount: 2,
    maxConsecutiveFailures: 3,
    pageLoadRetryCount: 1,
    // 单个作品从打开到完成回访的最长处理时间；超时会记录问题并切换页面继续下一条。
    workTimeoutMs: DEFAULT_RETURN_VISIT_WORK_TIMEOUT_MS,
    maxReferenceComments: 5,
    watchPolicy: 'seconds',
    watchSeconds: [3, 3],
    waitBetweenUsersMs: [3000, 5000],
    waitBetweenLikeAndCommentMs: [2000, 3000],
    restEveryTasksRange: [1, 1],
    restDurationMs: [5000, 5000],
  },
  safety: {
    stopOnLoginRequired: true,
    stopOnCaptcha: true,
    captureScreenshotOnAction: true,
    captureScreenshotOnFailure: true,
  },
};
