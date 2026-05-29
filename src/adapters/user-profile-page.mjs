import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

export async function navigateToProfile(page, username, options = {}) {
  const { timeoutMs = 15000 } = options;

  try {
    const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(username)}?type=user`;
    console.log(`[user-profile] 搜索用户: "${username}"`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(3000);

    const profileUrl = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/user/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        const match = href && href.match(/\/user\/(MS4wLjAB\w+)/);
        if (match) {
          const rect = link.getBoundingClientRect();
          return { url: href.startsWith('http') ? href : `https://www.douyin.com${href}`, key: match[1] };
        }
      }
      return null;
    });

    if (!profileUrl) {
      return blocking(
        RESULT_CODES.BLOCKED,
        `在搜索结果中未找到用户 "${username}" 的主页链接`,
        { data: { username } }
      );
    }

    console.log(`[user-profile] 找到主页: ${profileUrl.url}`);
    await page.goto(profileUrl.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(3000);

    const verified = await page.evaluate((name) => {
      const text = document.body?.innerText || '';
      const userNameEls = document.querySelectorAll('h1, [class*="name"], [class*="nickname"], [class*="username"]');
      for (const el of userNameEls) {
        const t = (el.innerText || '').trim();
        if (t.includes(name)) return true;
      }
      return text.includes(name);
    }, username);

    if (!verified) {
      return blocking(
        RESULT_CODES.BLOCKED,
        `无法确认用户 "${username}" 的身份`,
        { data: { username, profileUrl: profileUrl.url } }
      );
    }

    return success({ profileUrl: profileUrl.url, profileKey: profileUrl.key, verified: true });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `导航到用户主页异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}

/**
 * Read-only: find the latest non-pinned video candidate on the current profile page.
 * Does NOT click or navigate — only reads the DOM.
 *
 * @returns {{ ok: true, data: { videoUrl, videoId, candidateCount, targetRule, isPinned } }} on success
 * @returns {{ ok: false, code, message }} on failure
 */
export async function findLatestNonPinnedVideo(page) {
  try {
    const candidate = await page.evaluate(() => {
      const all = document.querySelectorAll('a');

      const videoLinks = [];
      for (const a of all) {
        const href = a.getAttribute('href');
        if (!href || !href.includes('/video/')) continue;
        if (href.includes('/video/') && !a.closest('[class*="pinned"]') && !a.closest('[class*="top"]')) {
          const rect = a.getBoundingClientRect();
          videoLinks.push({
            url: href.startsWith('http') ? href : `https://www.douyin.com${href.split('?')[0]}`,
            y: rect.y,
            x: rect.x,
          });
        }
      }

      // Sort by position: top-left first (latest videos usually appear first)
      videoLinks.sort((a, b) => a.y - b.y || a.x - b.x);

      if (videoLinks.length === 0) return null;

      // Read-only: extract candidate data without clicking
      const first = videoLinks[0];
      const videoIdMatch = first.url.match(/\/video\/(\d+)/);
      return {
        videoUrl: first.url,
        videoId: videoIdMatch ? videoIdMatch[1] : null,
        candidateCount: videoLinks.length,
        y: first.y,
        x: first.x,
      };
    });

    if (!candidate) {
      return blocking(
        RESULT_CODES.BLOCKED,
        '该用户主页未找到非置顶视频',
        { data: {} }
      );
    }

    console.log(`[user-profile] 候选最新视频: ${candidate.videoUrl} (共 ${candidate.candidateCount} 个视频)`);
    return success({
      videoUrl: candidate.videoUrl,
      videoId: candidate.videoId,
      candidateCount: candidate.candidateCount,
      targetRule: 'latest_non_pinned_video',
      isPinned: false,
      evidence: { y: candidate.y, x: candidate.x },
    });
  } catch (err) {
    return blocking(
      RESULT_CODES.BLOCKED,
      `查找最新视频异常: ${err.message}`,
      { data: { error: err.message } }
    );
  }
}
