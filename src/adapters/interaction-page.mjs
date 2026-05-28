import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';

export async function navigateToCommentViaNotification(page, username) {
  const { clickCommentLink } = await import('./notification-page.mjs');
  const clicked = await clickCommentLink(page, username);
  if (!clicked) {
    return blocking(RESULT_CODES.BLOCKED, `通知面板中未找到 ${username} 的评论条目`);
  }
  return success({ url: page.url() });
}
