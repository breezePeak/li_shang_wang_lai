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
    enabled: true,
    mode: 'manual',
    allowedRelations: ['friend', 'mutual'],
    maxPerRun: 5,
    skipPinned: true,
    requireLatestWorkConfirmed: true,
  },
  safety: {
    stopOnLoginRequired: true,
    stopOnCaptcha: true,
    captureScreenshotOnAction: true,
    captureScreenshotOnFailure: true,
  },
};
