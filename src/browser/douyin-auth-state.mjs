const LOGIN_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
  'passport_auth_status_ss',
  'login_time',
]);

const SECURITY_VERIFICATION_PATTERNS = [
  /手机号(?:认证|验证|校验)/,
  /验证手机号/,
  /手机(?:认证|验证|校验)/,
  /短信验证码/,
  /输入验证码/,
  /获取验证码/,
  /为了(?:你的)?账号安全/,
  /账号安全验证/,
  /安全验证/,
  /身份验证/,
  /实名认证/,
];

function isLoginUrl(url) {
  return url.includes('passport') || url.includes('login');
}

function detectSecurityVerificationFromText(text) {
  const normalized = String(text || '').replace(/\s+/g, '');
  if (!normalized) return false;
  return SECURITY_VERIFICATION_PATTERNS.some(pattern => pattern.test(normalized));
}

async function safePageText(page) {
  try {
    return await page.evaluate(() => {
      const selectors = [
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="modal" i]',
        '[class*="popup" i]',
        '[class*="passport" i]',
        '[class*="login" i]',
        '[class*="verify" i]',
        '[class*="captcha" i]',
        'body',
      ];
      const chunks = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
          const text = (el.innerText || el.textContent || '').trim();
          if (text) chunks.push(text);
        }
      }
      return chunks.join('\n').slice(0, 4000);
    });
  } catch {
    return '';
  }
}

export async function hasDouyinLoginCookies(context) {
  const cookies = await context.cookies(['https://www.douyin.com', 'https://creator.douyin.com']);
  return cookies.some(cookie => LOGIN_COOKIE_NAMES.has(cookie.name) && String(cookie.value || '').trim().length > 0);
}

export async function detectDouyinSecurityVerification(page) {
  const currentUrl = typeof page?.url === 'function' ? page.url() : '';
  const text = await safePageText(page);
  if (!detectSecurityVerificationFromText(text)) return null;
  return {
    reason: 'security_verification_required',
    currentUrl,
    preview: text.slice(0, 300),
  };
}

export async function inspectDouyinAuthState(page, context) {
  const currentUrl = typeof page?.url === 'function' ? page.url() : '';
  if (isLoginUrl(currentUrl)) {
    return { loggedIn: false, reason: 'redirected_to_login', currentUrl };
  }

  const securityVerification = await detectDouyinSecurityVerification(page);
  if (securityVerification) {
    return { loggedIn: false, ...securityVerification };
  }

  if (!await hasDouyinLoginCookies(context)) {
    return { loggedIn: false, reason: 'missing_login_cookie', currentUrl };
  }

  return { loggedIn: true, currentUrl };
}
