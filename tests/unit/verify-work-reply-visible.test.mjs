import { describe, it, expect } from 'vitest';
import { verifyWorkReplyVisible } from '../../src/adapters/work-modal-page.mjs';

describe('verifyWorkReplyVisible', () => {
  it('does not treat cleared editor as success when reply is still not visible', async () => {
    const page = {
      evaluate: async (_fn, arg) => {
        if (arg?.commentText !== undefined) {
          return { verified: false };
        }
        if (arg?.replyNeedle !== undefined) {
          return {
            ok: true,
            editorText: '',
            text: '',
          };
        }
        return { verified: false };
      },
      waitForTimeout: async () => {},
    };

    const result = await verifyWorkReplyVisible(
      page,
      { actorName: '张三', commentText: '求一个邀请码' },
      '给你啦',
      { timeoutMs: 10 }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_SEND_UNCONFIRMED');
    expect(result.message).toContain('仅检测到输入框清空');
  });
});
