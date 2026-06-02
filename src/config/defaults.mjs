// 默认配置常量 — 占位，由 config/local.json 覆盖
export const DEFAULTS = {
  browser: {
    headless: false,
    profileDir: '.playwright/douyin-profile',
    slowMo: 150,
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
