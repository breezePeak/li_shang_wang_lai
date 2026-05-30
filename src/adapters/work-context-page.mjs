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
      const desc = document.querySelector('[class*="desc"], [class*="title"], [class*="caption"]');
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
