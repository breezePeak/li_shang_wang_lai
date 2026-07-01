import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { verifyWorkReplyVisible } from '../../src/adapters/work-modal-page.mjs';

let browser = null;
let realPage = null;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  realPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('verifyWorkReplyVisible', () => {
  it('仅输入框保留回复文本时不应误判为发送成功', async () => {
    await realPage.setContent(`
      <html>
        <body>
          <div class="comment-mainContent">
            <div data-e2e="comment-item">
              <div>张三</div>
              <div>求一个邀请码</div>
              <div>刚刚</div>
            </div>
          </div>
          <div class="comment-input-container">
            <div contenteditable="true">给你啦</div>
          </div>
        </body>
      </html>
    `);

    const result = await verifyWorkReplyVisible(
      realPage,
      { actorName: '张三', commentText: '求一个邀请码' },
      '给你啦',
      { timeoutMs: 300 }
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_SEND_UNCONFIRMED');
  });

  it('目标评论卡片内出现回复文本时确认成功', async () => {
    await realPage.setContent(`
      <html>
        <body>
          <div class="comment-mainContent">
            <div data-e2e="comment-item">
              <div>张三</div>
              <div>求一个邀请码</div>
              <div class="comment-item-info-wrap">
                <div>作者</div>
                <div>给你啦</div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `);

    const result = await verifyWorkReplyVisible(
      realPage,
      { actorName: '张三', commentText: '求一个邀请码' },
      '给你啦',
      { timeoutMs: 300 }
    );

    expect(result.ok).toBe(true);
  });

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
