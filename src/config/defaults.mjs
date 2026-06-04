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
    maxWorksToCheck: 3,
    maxRetryCount: 2,
    maxConsecutiveFailures: 3,
    pageLoadRetryCount: 1,
    maxReferenceComments: 5,
    watchPolicy: 'seconds',
    watchSeconds: [5, 8],
    waitBetweenUsersMs: [8000, 20000],
    waitBetweenLikeAndCommentMs: [2000, 6000],
    restEveryTasksRange: [8, 12],
    restDurationMs: [60000, 180000],
  },
  safety: {
    stopOnLoginRequired: true,
    stopOnCaptcha: true,
    captureScreenshotOnAction: true,
    captureScreenshotOnFailure: true,
  },
};
