/**
 * 页面诊断工具 — 采集页面结构、文本、关键词元素、可点击用户及截图/DOM快照
 */

/**
 * 采集当前页面的基本诊断信息
 * @param {import('playwright').Page} page
 * @returns {Promise<{url: string, title: string, timestamp: string}>}
 */
export async function capturePageDiagnostics(page) {
  try {
    return {
      url: page.url(),
      title: await page.title(),
      timestamp: new Date().toISOString(),
    };
  } catch {
    return { url: '', title: '', timestamp: new Date().toISOString() };
  }
}

/**
 * 提取页面所有可见文本
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function extractVisibleText(page) {
  try {
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      return body.innerText || '';
    });
    return text;
  } catch {
    return '';
  }
}

/**
 * 提取匹配关键词的元素信息
 * @param {import('playwright').Page} page
 * @param {string[]} keywords
 * @returns {Promise<Array<{keyword: string, selector: string, tagName: string, text: string, href: string, innerTextSample: string}>>}
 */
export async function extractKeywordElements(page, keywords) {
  try {
    const results = await page.evaluate((kwList) => {
      const all = document.querySelectorAll('a, button, span, div, li, p, h1, h2, h3, h4, h5, h6');
      const matches = [];

      for (const el of all) {
        const text = (el.textContent || '').trim();
        const innerText = el.innerText || '';
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();

        const combined = text + ' ' + ariaLabel;

        for (const kw of kwList) {
          if (combined.includes(kw)) {
            // 生成唯一选择器
            let selector = el.tagName.toLowerCase();
            if (el.id) {
              selector = '#' + CSS.escape(el.id);
            } else if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\s+/).filter(Boolean);
              if (cls.length > 0) {
                selector = el.tagName.toLowerCase() + '.' + cls.map(c => CSS.escape(c)).join('.');
              }
            }

            matches.push({
              keyword: kw,
              selector,
              tagName: el.tagName.toLowerCase(),
              text: text.slice(0, 200),
              href: (el.getAttribute('href') || '').slice(0, 500),
              innerTextSample: innerText.slice(0, 200),
            });
            break; // 每个元素只记录第一个匹配的关键词
          }
        }
      }

      return matches;
    }, keywords);

    return results;
  } catch {
    return [];
  }
}

/**
 * 提取页面上看起来可点击的用户相关元素（链接、按钮等）
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{tagName: string, text: string, href: string, selector: string}>>}
 */
export async function extractClickableUsers(page) {
  try {
    const results = await page.evaluate(() => {
      // 用户相关关键词
      const userPatterns = ['@', '关注', '好友', '粉丝', '朋友', '用户', '昵称'];
      const all = document.querySelectorAll('a[href], button, [role="button"], [class*="avatar"], [class*="nickname"], [class*="user"], [class*="profile"], [class*="author"]');
      const seen = new Set();
      const matches = [];

      for (const el of all) {
        const text = (el.textContent || '').trim();
        const href = (el.getAttribute('href') || '');
        const tagName = el.tagName.toLowerCase();

        if (!text && !href) continue;

        // 排除纯功能性链接
        const skipPatterns = ['javascript:', '#', 'tel:', 'mailto:', '首页', '登录', '注册', '退出', '设置', '帮助', '关于'];
        const isSkip = skipPatterns.some(p => href.startsWith(p) || text.includes(p));
        if (isSkip) continue;

        // 匹配用户相关模式
        const isUserRelated = userPatterns.some(p => text.includes(p));

        // 或者看起来像用户链接（短文本 + 有 href 指向用户页面）
        const looksLikeUserLink = (
          tagName === 'a' &&
          text.length > 0 &&
          text.length < 50 &&
          (href.includes('/user/') || href.includes('/profile') || href.includes('/people'))
        );

        if (!isUserRelated && !looksLikeUserLink) continue;

        const dedupeKey = `${tagName}|${text.slice(0, 30)}|${href.slice(0, 30)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // 生成选择器
        let selector = tagName;
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).filter(Boolean);
          if (cls.length > 0) {
            selector = tagName + '.' + cls.map(c => CSS.escape(c)).join('.');
          }
        }

        matches.push({
          tagName,
          text: text.slice(0, 100),
          href: href.slice(0, 500),
          selector,
        });
      }

      return matches;
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * 保存全页截图到指定路径
 * @param {import('playwright').Page} page
 * @param {string} outputPath
 * @returns {Promise<boolean>} 成功返回 true
 */
export async function captureFullScreenshot(page, outputPath) {
  try {
    await page.screenshot({ path: outputPath, fullPage: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 采集净化后的 DOM 片段（去除 script/style，限制行数）
 * @param {import('playwright').Page} page
 * @param {number} [maxLines=500]
 * @returns {Promise<string>}
 */
export async function captureDomFragment(page, maxLines = 500) {
  try {
    const html = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);

      // 移除不需要的标签
      const removeTags = ['script', 'style', 'noscript', 'iframe', 'svg'];
      for (const tag of removeTags) {
        const elements = clone.querySelectorAll(tag);
        elements.forEach(el => el.remove());
      }

      // 移除注释
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments = [];
      while (walker.nextNode()) {
        comments.push(walker.currentNode);
      }
      comments.forEach(c => c.remove());

      // 移除常见的内联事件属性和 data- 属性（保留 data-e2e 等少量可能有用的）
      const allElements = clone.querySelectorAll('*');
      for (const el of allElements) {
        const attrs = [...el.attributes];
        for (const attr of attrs) {
          if (attr.name.startsWith('on') && attr.name.length > 2) {
            el.removeAttribute(attr.name);
          }
        }
      }

      return clone.outerHTML;
    });

    const lines = html.split('\n');
    if (lines.length <= maxLines) return html;

    // 保留前 60% 和后 15% 的行，中间截断
    const head = lines.slice(0, Math.floor(maxLines * 0.6));
    const tail = lines.slice(-Math.floor(maxLines * 0.15));

    return [
      ...head,
      '<!-- ===== [truncated ' + (lines.length - maxLines) + ' lines] ===== -->',
      ...tail,
    ].join('\n');
  } catch {
    return '<!-- failed to capture DOM fragment -->';
  }
}
