import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

let _selfProfileCache = null;

export function getSelfProfile() {
  if (_selfProfileCache) return _selfProfileCache;

  if (typeof process !== 'undefined' && process.env) {
    const key = process.env.LSWL_SELF_PROFILE_KEY || '';
    const url = process.env.LSWL_SELF_PROFILE_URL || '';
    const nickname = process.env.LSWL_SELF_NICKNAME || '';
    if (key || url || nickname) {
      _selfProfileCache = { profileKey: key, profileUrl: url, nickname };
      return _selfProfileCache;
    }
  }

  try {
    const configPath = resolve(process.cwd(), 'config', 'local.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const self = config.self || {};
      if (self.profileKey || self.profileUrl || self.nickname) {
        _selfProfileCache = {
          profileKey: self.profileKey || '',
          profileUrl: self.profileUrl || '',
          nickname: self.nickname || '',
        };
        return _selfProfileCache;
      }
    }
  } catch {}

  _selfProfileCache = { profileKey: '', profileUrl: '', nickname: '' };
  return _selfProfileCache;
}

export function resetSelfProfileCache() {
  _selfProfileCache = null;
}

export function checkWorkOwner(workContext, selfProfile) {
  const warnings = [];
  const { authorProfileKey, authorProfileUrl, authorName } = workContext;
  const self = selfProfile || getSelfProfile();

  if (!self.profileKey && !self.profileUrl && !self.nickname) {
    return {
      isOwnWork: null,
      ownerCheckMethod: 'unknown',
      ownerCheckConfidence: 'low',
      warnings: ['owner_not_verified_no_self_config'],
    };
  }

  if (self.profileKey && authorProfileKey) {
    if (authorProfileKey === self.profileKey) {
      return { isOwnWork: true, ownerCheckMethod: 'author_profile_key', ownerCheckConfidence: 'high', warnings: [] };
    }
    return { isOwnWork: false, ownerCheckMethod: 'author_profile_key_mismatch', ownerCheckConfidence: 'high', warnings: [] };
  }

  if (self.profileUrl && authorProfileUrl) {
    const normAuthor = normalizeDouyinUrl(authorProfileUrl);
    const normSelf = normalizeDouyinUrl(self.profileUrl);
    if (normAuthor && normSelf && normAuthor === normSelf) {
      return { isOwnWork: true, ownerCheckMethod: 'author_profile_url', ownerCheckConfidence: 'high', warnings: [] };
    }
    if (normAuthor && normSelf && normAuthor !== normSelf) {
      return { isOwnWork: false, ownerCheckMethod: 'author_profile_url_mismatch', ownerCheckConfidence: 'high', warnings: [] };
    }
  }

  if (self.nickname && authorName) {
    if (authorName === self.nickname) {
      return { isOwnWork: true, ownerCheckMethod: 'author_name', ownerCheckConfidence: 'medium', warnings: ['owner_check_medium_confidence'] };
    }
    return { isOwnWork: false, ownerCheckMethod: 'author_name_mismatch', ownerCheckConfidence: 'medium', warnings: ['owner_check_medium_confidence'] };
  }

  return {
    isOwnWork: null,
    ownerCheckMethod: 'unknown',
    ownerCheckConfidence: 'low',
    warnings: ['owner_not_verified'],
  };
}

export async function clickNotificationWorkThumbnail(page, { skipItemTexts = [], targetActorName = '', targetContent = '' } = {}) {
  const TARGET_PATTERNS = ['评论了你的作品', '评论了你的视频'];
  const ALL_ACTION_PATTERNS = ['赞了你的作品', '赞了你的评论', '赞了你的视频', '点赞了你的作品', '评论了你的作品', '评论了你的视频', '回复了你的评论'];

  const thumbResult = await page.evaluate(({ TARGET_PATTERNS, ALL_ACTION_PATTERNS, skipItemTexts, targetActorName, targetContent }) => {
    function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    }

    const panel = findNotificationPanel();
    if (!panel) return { ok: false, reason: 'panel not found' };

    const panelRect = panel.getBoundingClientRect();
    const allElements = panel.querySelectorAll('*');
    const candidates = [];

    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20) continue;
      if (rect.height > panelRect.height * 0.4) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 5) continue;

      if (!TARGET_PATTERNS.some(pattern => text.includes(pattern))) continue;

      let totalActionCount = 0;
      for (const pat of ALL_ACTION_PATTERNS) {
        let idx = text.indexOf(pat);
        while (idx !== -1) { totalActionCount++; idx = text.indexOf(pat, idx + 1); }
      }
      if (totalActionCount !== 1) continue;

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      const itemTextKey = text.slice(0, 100);
      if (skipItemTexts.some(s => s === itemTextKey)) continue;

      const matchesTarget = (targetActorName && text.includes(targetActorName)) &&
        (!targetContent || text.includes(targetContent.slice(0, 30)));

      const imgs = el.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (src.includes('aweme-avatar')) continue;
        const imgRect = img.getBoundingClientRect();
        if (imgRect.width < 20 || imgRect.height < 20) continue;
        const isLikelyAvatar = imgRect.width <= 60 && imgRect.height <= 60;
        if (imgRect.y < 0 || imgRect.y > window.innerHeight || imgRect.bottom < 0 || imgRect.top > window.innerHeight) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        const finalRect = img.getBoundingClientRect();
        candidates.push({
          ok: true,
          x: Math.round(finalRect.x + finalRect.width / 2),
          y: Math.round(finalRect.y + finalRect.height / 2),
          itemText: itemTextKey,
          imgW: Math.round(finalRect.width),
          imgH: Math.round(finalRect.height),
          priority: (isLikelyAvatar ? 0 : 1) + (matchesTarget ? 2 : 0),
          matchesTarget,
        });
      }
    }

    const targetRequested = !!(targetActorName || targetContent);
    const targetCandidates = candidates.filter(c => c.matchesTarget);
    const selectableCandidates = targetRequested ? targetCandidates : candidates;

    selectableCandidates.sort((a, b) => b.priority - a.priority);

    if (selectableCandidates.length === 0) {
      return {
        ok: false,
        reason: targetRequested
          ? 'target notification thumbnail not found'
          : 'no comment_on_my_work thumbnail found',
      };
    }
    const best = selectableCandidates[0];
    best.clicked = true;
    return best;
  }, { TARGET_PATTERNS, ALL_ACTION_PATTERNS, skipItemTexts, targetActorName, targetContent });

  if (!thumbResult.ok) {
    return { ok: false, code: 'THUMBNAIL_NOT_FOUND', message: thumbResult.reason };
  }

  console.error(`[work-context] 点击作品缩略图 at (${thumbResult.x}, ${thumbResult.y})，通知: "${thumbResult.itemText}"`);

  const urlBefore = page.url();

  // Try DOM click first (keeps panel open), fallback to mouse click
  const clickViaDom = await page.evaluate(({ x, y }) => {
    const panel = (function findNotificationPanel() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.startsWith('互动消息') || t.startsWith('全部消息')) {
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 30) continue;
          let c = el.parentElement;
          for (let i = 0; i < 6 && c && c !== document.body; i++) {
            const cr = c.getBoundingClientRect();
            if (cr.width > 250 && cr.height > 300) return c;
            c = c.parentElement;
          }
        }
      }
      return null;
    })();

    if (!panel) return { ok: false };

    const imgs = panel.querySelectorAll('img');
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (Math.abs(cx - x) < 5 && Math.abs(cy - y) < 5) {
        img.click();
        return { ok: true };
      }
    }
    return { ok: false };
  }, { x: thumbResult.x, y: thumbResult.y });

  if (!clickViaDom.ok) {
    console.error('[work-context] DOM click 失败，尝试 mouse.click');
    await page.mouse.click(thumbResult.x, thumbResult.y);
  }

  await page.waitForTimeout(3000);

  const urlAfter = page.url();
  console.error(`[work-context] 点击前: ${urlBefore}`);
  console.error(`[work-context] 点击后: ${urlAfter}`);

  return { ok: true, urlBefore, urlAfter, itemText: thumbResult.itemText };
}

export async function extractWorkContextFromPage(page, options = {}) {
  const warnings = [];
  const currentUrl = page.url();

  let workId = '', workUrl = '', workType = 'unknown';

  const videoMatch = currentUrl.match(/\/video\/([^/?#]+)/);
  if (videoMatch) {
    workId = 'video-' + videoMatch[1];
    workType = 'video';
    workUrl = normalizeDouyinUrl(currentUrl.split('?')[0].split('#')[0]);
  }

  if (!workId) {
    const noteMatch = currentUrl.match(/\/note\/([^/?#]+)/);
    if (noteMatch) {
      workId = 'note-' + noteMatch[1];
      workType = 'note';
      workUrl = normalizeDouyinUrl(currentUrl.split('?')[0].split('#')[0]);
    }
  }

  if (!workId) {
    const modalMatch = currentUrl.match(/[?&]modal_id=([^&#]+)/);
    if (modalMatch) {
      workId = modalMatch[1];
      workType = 'modal';
      workUrl = normalizeDouyinUrl(currentUrl.split('?')[0].split('#')[0]) + '?modal_id=' + modalMatch[1];
    }
  }

  if (!workId) {
    const found = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const vm = href.match(/\/video\/([^/?#]+)/);
        if (vm) return { workId: 'video-' + vm[1], workUrl: href, workType: 'video' };
        const nm = href.match(/\/note\/([^/?#]+)/);
        if (nm) return { workId: 'note-' + nm[1], workUrl: href, workType: 'note' };
      }
      return null;
    });
    if (found) {
      workId = found.workId;
      workType = found.workType;
      workUrl = normalizeDouyinUrl(found.workUrl);
    }
  }

  if (!workId) {
    warnings.push('work_id_not_found_in_url');
  }

  let workTitle = '';
  try {
    workTitle = await page.evaluate(() => {
      const modal = document.querySelector('[class*="modal"], [class*="detail"], [class*="xgplayer"]');
      const scope = modal || document.body;

      const desc = scope.querySelector('[class*="desc"], [class*="title"], [class*="caption"], [class*="mark"]');
      if (desc) {
        const text = (desc.innerText || '').trim();
        if (text.length > 2 && text.length < 500) return text;
      }

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = (ogTitle.getAttribute('content') || '').trim();
        if (content.length > 2) return content;
      }

      const title = document.title || '';
      const cleaned = title.replace(/ - 抖音$/, '').replace(/ | 抖音$/, '').trim();
      if (cleaned.length > 2) return cleaned;

      return '';
    });
  } catch (err) {
    warnings.push(`work_title_extract_error: ${err.message}`);
  }

  if (!workTitle) {
    warnings.push('work_title_not_found');
  }

  let authorName = '', authorProfileUrl = '', authorProfileKey = '';
  try {
    const authorData = await page.evaluate(() => {
      let name = '', url = '', key = '';

      const authorLinks = document.querySelectorAll('a[href*="/user/"]');
      for (const link of authorLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/user\/([A-Za-z0-9_.-]+)/);
        if (match) {
          key = match[1];
          url = href;
          const text = (link.innerText || '').trim();
          if (text.length > 0 && text.length < 50) {
            name = text;
            break;
          }
        }
      }

      if (!name) {
        const authorEls = document.querySelectorAll('[class*="author"], [class*="nickname"], [class*="userName"]');
        for (const el of authorEls) {
          const text = (el.innerText || '').trim();
          if (text.length > 0 && text.length < 50) {
            name = text;
            break;
          }
        }
      }

      return { name, url, key };
    });
    authorName = authorData.name;
    authorProfileUrl = authorData.url;
    authorProfileKey = authorData.key;
  } catch (err) {
    warnings.push(`author_extract_error: ${err.message}`);
  }

  const selfProfile = getSelfProfile();
  const ownerResult = checkWorkOwner({ authorProfileKey, authorProfileUrl, authorName }, selfProfile);
  warnings.push(...ownerResult.warnings);

  return {
    ok: true,
    data: {
      currentUrl,
      workUrl: workUrl || null,
      workId: workId || null,
      workType,
      workTitle: workTitle || null,
      authorName: authorName || null,
      authorProfileUrl: authorProfileUrl || null,
      authorProfileKey: authorProfileKey || null,
      isOwnWork: ownerResult.isOwnWork,
      ownerCheckMethod: ownerResult.ownerCheckMethod,
      ownerCheckConfidence: ownerResult.ownerCheckConfidence,
      warnings,
    },
  };
}
