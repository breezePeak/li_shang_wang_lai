import { detectDouyinSecurityVerification } from './douyin-auth-state.mjs';

/**
 * 检查当前页面登录状态
 * @param {import('playwright').Page} page
 * @returns {Promise<{loggedIn: boolean, reason?: string}>}
 */
export async function checkLoginStatus(page) {
  const currentUrl = page.url();
  if (currentUrl.includes('passport') || currentUrl.includes('login')) {
    return { loggedIn: false, reason: 'redirected_to_login' };
  }
  const securityVerification = await detectDouyinSecurityVerification(page);
  if (securityVerification) {
    return {
      loggedIn: false,
      reason: securityVerification.reason,
      preview: securityVerification.preview,
    };
  }
  return { loggedIn: true };
}
