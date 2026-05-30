import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';

let browser = null;
let page = null;

// Dynamic import for ESM
let openReplyBox = null;
let openReplyBoxForComment = null;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const mod = await import('../../src/adapters/comment-page.mjs');
  openReplyBox = mod.openReplyBox;
  openReplyBoxForComment = mod.openReplyBoxForComment;
});

afterAll(async () => {
  if (browser) await browser.close();
});

async function setComments(comments) {
  const items = comments.map(c => `
    <div class="comment" style="margin:10px 0;padding:8px;border:1px solid #ccc">
      <div class="comment-header">
        <span class="comment-author">${c.author || '用户'}</span>
        <span class="comment-time">${c.time || ''}</span>
      </div>
      <div class="comment-content">
        ${c.text || ''}
      </div>
      <div class="comment-operations">
        <span class="operations-item">回复</span>
      </div>
    </div>
  `).join('\n');

  await page.setContent(`
    <html><body>
      <div class="comment-list">${items}</div>
    </body></html>
  `);
  await page.waitForTimeout(100);
}

describe('openReplyBox - adapter level', () => {
  it('should find and click reply on a unique comment', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '写得不错' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '写得不错',
      actorName: '张三',
    });

    expect(result.ok).toBe(true);
  });

  it('should match by actorName even when multiple users have same text', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '求教程' },
      { author: '李四', time: '05-29 11:00', text: '求教程' },
    ]);

    // With specific actorName, should uniquely identify
    const result = await openReplyBox(page, {
      commentText: '求教程',
      actorName: '李四',
    });

    expect(result.ok).toBe(true);
  });

  it('should match by actorName when same text but different authors', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '求教程' },
    ]);

    // With correct actorName
    const result = await openReplyBox(page, {
      commentText: '求教程',
      actorName: '张三',
    });

    expect(result.ok).toBe(true);

    // Reset page for next test
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '求教程' },
    ]);

    // Without actorName — also works since only one comment
    const result2 = await openReplyBox(page, {
      commentText: '求教程',
    });

    expect(result2.ok).toBe(true);
  });

  it('should block when actorName does not match any comment', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '写得不错' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '写得不错',
      actorName: '王五',
    });

    expect(result.ok).toBe(false);
  });

  it('should distinguish two identical texts by eventTimeText', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '很好' },
      { author: '张三', time: '05-29 14:00', text: '很好' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '很好',
      actorName: '张三',
      eventTimeText: '14:00',
    });

    expect(result.ok).toBe(true);
  });

  it('should return COMMENT_MATCH_NOT_UNIQUE for ambiguous match', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '很好' },
      { author: '张三', time: '05-29 14:00', text: '很好' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '很好',
      actorName: '张三',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_MATCH_NOT_UNIQUE');
  });

  it('should return COMMENT_REPLY_BUTTON_NOT_FOUND when no match', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '写得不错' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '完全不同的文本',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_REPLY_BUTTON_NOT_FOUND');
  }, 40000); // scroll loop takes ~30s

  it('should not trigger ReferenceError for key variable', async () => {
    // Test that various DOM structures don't cause runtime errors
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '测试' },
      { author: '李四', time: '05-29 11:00', text: '测试' },
      { author: '王五', time: '05-29 12:00', text: '其他' },
    ]);

    // This should return blocked or not found, but never throw
    const result = await openReplyBox(page, {
      commentText: '测试',
      actorName: '不存在',
    });

    expect(result).toBeDefined();
    expect(typeof result.ok).toBe('boolean');
  });

  it('should click only the comment with matching eventTimeText when same actor has same text at different times', async () => {
    await setComments([
      { author: '张三', time: '05-28 10:00', text: '求教程' },
      { author: '张三', time: '05-29 10:00', text: '求教程' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '求教程',
      actorName: '张三',
      eventTimeText: '05-29 10:00',
    });

    // Must succeed — only the second comment (05-29) should be clicked,
    // NOT the first one (05-28) that appears earlier in DOM.
    expect(result.ok).toBe(true);
  });

  it('should block when eventTimeText is provided but no matching comment has that time', async () => {
    await setComments([
      { author: '张三', time: '05-28 10:00', text: '求教程' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '求教程',
      actorName: '张三',
      eventTimeText: '05-29 10:00',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('COMMENT_MATCH_NOT_UNIQUE');
  }, 40000);

  it('openReplyBoxForComment uses actorName for unique match', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '求教程' },
      { author: '李四', time: '05-29 11:00', text: '求教程' },
    ]);

    const result = await openReplyBoxForComment(page, {
      actorName: '李四',
      commentText: '求教程',
    });

    expect(result.ok).toBe(true);
  });

  it('openReplyBoxForComment works with commentText alone (no actorName)', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '写得不错' },
    ]);

    const result = await openReplyBoxForComment(page, {
      commentText: '写得不错',
    });

    expect(result.ok).toBe(true);
  });

  it('openReplyBoxForComment blocks when actorName does not match any comment (no fallback)', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '求教程' },
    ]);

    const result = await openReplyBoxForComment(page, {
      actorName: '李四',
      commentText: '求教程',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTOR_NAME_NOT_VERIFIED');
  });

  it('openReplyBoxForComment blocks when actorName is wrong even with duplicate commentText', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '支持' },
      { author: '王五', time: '05-29 11:00', text: '支持' },
    ]);

    const result = await openReplyBoxForComment(page, {
      actorName: '李四',
      commentText: '支持',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTOR_NAME_NOT_VERIFIED');
  });
});
