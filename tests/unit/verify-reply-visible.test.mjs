import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';

let browser = null;
let page = null;
let verifyReplyVisible = null;

async function setPageContent(comments) {
  const items = comments.map((c, i) => `
    <div class="comment-item" data-idx="${i}" style="margin:10px 0;padding:8px;border:1px solid #ccc">
      <span class="comment-author">${c.author || ''}</span>
      <div class="comment-content">${c.text || ''}</div>
      <div class="comment-operations"><span class="operations-item">回复</span></div>
      ${c.reply ? `<div class="reply-content">${c.reply}</div>` : ''}
    </div>
  `).join('\n');

  await page.setContent(`<html><body>${items}</body></html>`);
  await page.waitForTimeout(100);
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const mod = await import('../../src/adapters/comment-page.mjs');
  verifyReplyVisible = mod.verifyReplyVisible;
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('verifyReplyVisible', () => {
  it('returns ok when same container has actorName + commentText + replyText', async () => {
    await setPageContent([
      { author: '张三', text: '求教程', reply: '感谢支持' },
    ]);

    const result = await verifyReplyVisible(page, { actorName: '张三', commentText: '求教程' }, '感谢支持', { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
  });

  it('returns COMMENT_SEND_UNCONFIRMED when replyText is missing from page', async () => {
    await setPageContent([
      { author: '张三', text: '求教程' },
    ]);

    const result = await verifyReplyVisible(page, { actorName: '张三', commentText: '求教程' }, '完全不存在的回复', { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_SEND_UNCONFIRMED');
  });

  it('does not verify when replyText exists elsewhere on page but not in target comment', async () => {
    await setPageContent([
      { author: '张三', text: '求教程' },
      { author: '李四', text: '支持', reply: '感谢支持' },
    ]);

    const result = await verifyReplyVisible(page, { actorName: '张三', commentText: '求教程' }, '感谢支持', { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_SEND_UNCONFIRMED');
  });

  it('verifies correct actorName when two users have same commentText but different reply', async () => {
    await setPageContent([
      { author: '张三', text: '支持', reply: '谢谢张三' },
      { author: '李四', text: '支持', reply: '谢谢李四' },
    ]);

    const result = await verifyReplyVisible(page, { actorName: '李四', commentText: '支持' }, '谢谢李四', { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
  });

  it('fails when actorName exists but replyText is under another actor', async () => {
    await setPageContent([
      { author: '张三', text: '求教程', reply: '谢谢' },
      { author: '李四', text: '支持', reply: '感谢支持' },
    ]);

    const result = await verifyReplyVisible(page, { actorName: '张三', commentText: '求教程' }, '感谢支持', { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_SEND_UNCONFIRMED');
  });

  it('works without actorName, falls back to commentText + replyText match', async () => {
    await setPageContent([
      { author: '张三', text: '好文章', reply: '感谢阅读' },
    ]);

    const result = await verifyReplyVisible(page, { commentText: '好文章' }, '感谢阅读', { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
  });

  it('returns ok when replyText appears after a short delay (simulate async sending)', async () => {
    await setPageContent([
      { author: '张三', text: '求教程' },
    ]);

    // Simulate reply appearing after 300ms
    setTimeout(async () => {
      await page.evaluate(() => {
        const item = document.querySelector('.comment-item');
        if (item) {
          const reply = document.createElement('div');
          reply.className = 'reply-content';
          reply.innerText = '感谢支持';
          item.appendChild(reply);
        }
      });
    }, 300);

    const result = await verifyReplyVisible(page, { actorName: '张三', commentText: '求教程' }, '感谢支持', { timeoutMs: 2000 });
    expect(result.ok).toBe(true);
  });
});
