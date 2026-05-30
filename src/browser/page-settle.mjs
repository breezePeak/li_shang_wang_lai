import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

export async function waitForHumanObservation(page, label, ms, logger = console.error) {
  const n = Math.max(0, Number(ms) || 0);
  if (n > 0) {
    logger(`${label}，停留 ${n}ms 供人工确认...`);
    await page.waitForTimeout(n);
  }
}

export async function waitForProfileSettled(page, options = {}) {
  const { profileSettleMs = 6000, timeoutMs = 20000 } = options;

  const start = Date.now();
  const minEnd = start + Math.min(profileSettleMs, timeoutMs);
  const hardEnd = start + timeoutMs;

  try {
    await page.waitForSelector('body', { state: 'visible', timeout: 10000 });
  } catch {
    return blocking(RESULT_CODES.BLOCKED, 'profile_not_settled: body 不可见', { recoverable: false });
  }

  const remaining = Math.max(0, minEnd - Date.now());
  if (remaining > 0) await page.waitForTimeout(remaining);

  try {
    const hasVideoLinks = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/video/"]');
      return links.length > 0;
    });

    if (!hasVideoLinks) {
      const extraWait = Math.min(3000, Math.max(0, hardEnd - Date.now()));
      if (extraWait > 0) await page.waitForTimeout(extraWait);

      const recheck = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/video/"]');
        return links.length > 0;
      });

      if (!recheck) {
        return blocking(RESULT_CODES.BLOCKED, 'profile_not_settled: 主页未找到视频链接', { recoverable: false });
      }
    }
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `profile_not_settled: 检测异常 ${err.message}`, { recoverable: false });
  }

  return success({ settledAt: Date.now(), elapsedMs: Date.now() - start });
}

export async function waitForVideoSettled(page, options = {}) {
  const { videoSettleMs = 5000, timeoutMs = 20000 } = options;

  const start = Date.now();
  const minEnd = start + Math.min(videoSettleMs, timeoutMs);
  const hardEnd = start + timeoutMs;

  try {
    await page.waitForSelector('body', { state: 'visible', timeout: 10000 });
  } catch {
    return blocking(RESULT_CODES.BLOCKED, 'video_not_settled: body 不可见', { recoverable: false });
  }

  try {
    const urlOk = await page.evaluate(() => {
      const url = window.location.href;
      return url.includes('/video/') || url.includes('/note/');
    });

    if (!urlOk) {
      return blocking(RESULT_CODES.BLOCKED, 'video_not_settled: URL 不包含 /video/ 或 /note/', { recoverable: false });
    }
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `video_not_settled: URL 检测异常 ${err.message}`, { recoverable: false });
  }

  const remaining = Math.max(0, minEnd - Date.now());
  if (remaining > 0) await page.waitForTimeout(remaining);

  try {
    const hasKeyElements = await page.evaluate(() => {
      const likeBtns = document.querySelectorAll('[data-e2e="like-btn"], [class*="like"], [class*="Like"]');
      const videoPlayers = document.querySelectorAll('video, xg-video-container, [class*="video-player"]');
      return likeBtns.length > 0 || videoPlayers.length > 0;
    });

    if (!hasKeyElements) {
      const extraWait = Math.min(3000, Math.max(0, hardEnd - Date.now()));
      if (extraWait > 0) await page.waitForTimeout(extraWait);

      const recheck = await page.evaluate(() => {
        const likeBtns = document.querySelectorAll('[data-e2e="like-btn"], [class*="like"], [class*="Like"]');
        const videoPlayers = document.querySelectorAll('video, xg-video-container, [class*="video-player"]');
        return likeBtns.length > 0 || videoPlayers.length > 0;
      });

      if (!recheck) {
        return blocking(RESULT_CODES.BLOCKED, 'video_not_settled: 视频页未找到关键元素', { recoverable: false });
      }
    }
  } catch (err) {
    return blocking(RESULT_CODES.BLOCKED, `video_not_settled: 关键元素检测异常 ${err.message}`, { recoverable: false });
  }

  return success({ settledAt: Date.now(), elapsedMs: Date.now() - start });
}
