import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createCommentListApiCollector } from '../../src/adapters/comment-list-api-listener.mjs';

function createMockPage() {
  const emitter = new EventEmitter();
  emitter.waitForTimeout = (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)));
  return emitter;
}

describe('comment list api collector', () => {
  it('collects unique comments by cid and tracks meta', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    // 第一页：2 条评论
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1&cursor=0',
      status: () => 200,
      json: async () => ({
        status_code: 0,
        comments: [
          { cid: 'c1', text: '评论1', aweme_id: 'a1', user: { uid: 'u1', nickname: 'u1' } },
          { cid: 'c2', text: '评论2', aweme_id: 'a1', user: { uid: 'u2', nickname: 'u2' } },
        ],
        cursor: 10,
        has_more: 1,
        total: 2,
      }),
    });

    // 等待 response 处理完成
    await page.waitForTimeout(10);

    expect(collector.getByCid('c1')).toBeTruthy();
    expect(collector.getByCid('c1').commentText).toBe('评论1');
    expect(collector.getByCid('c2').commentText).toBe('评论2');
    expect(collector.getByCid('c3')).toBeNull();

    const stats = collector.getStats();
    expect(stats.responseCount).toBe(1);
    expect(stats.commentCount).toBe(2);
    expect(stats.hasMore).toBe(1);
    expect(stats.cursor).toBe(10);
    expect(stats.total).toBe(2);

    // 第二页：包含 c3，以及一个重复的 c2（应去重）
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1&cursor=10',
      status: () => 200,
      json: async () => ({
        status_code: 0,
        comments: [
          { cid: 'c2', text: '评论2-重复', aweme_id: 'a1', user: { uid: 'u2', nickname: 'u2' } },
          { cid: 'c3', text: '评论3', aweme_id: 'a1', user: { uid: 'u3', nickname: 'u3' } },
        ],
        cursor: 20,
        has_more: 0,
        total: 2,
      }),
    });

    await page.waitForTimeout(10);

    expect(collector.getByCid('c2').commentText).toBe('评论2'); // 未覆盖
    expect(collector.getByCid('c3').commentText).toBe('评论3');
    expect(collector.getStats().responseCount).toBe(2);
    expect(collector.getStats().commentCount).toBe(3); // c1, c2, c3 = 3
    expect(collector.getStats().hasMore).toBe(0);

    collector.stop();
  });

  it('skips non-200 responses and non-matching URLs', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    // 非 200
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1',
      status: () => 403,
      json: async () => ({ comments: [{ cid: 'noop' }] }),
    });

    await page.waitForTimeout(5);

    // 非 comment/list URL
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/notice/',
      status: () => 200,
      json: async () => ({ comments: [{ cid: 'noop' }] }),
    });

    await page.waitForTimeout(5);

    expect(collector.getStats().responseCount).toBe(0);
    expect(collector.getStats().commentCount).toBe(0);

    collector.stop();
  });

  it('deduplicates response URLs', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    const response1 = {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1&cursor=0',
      status: () => 200,
      json: async () => ({
        comments: [{ cid: 'c1', text: '第一条', user: { nickname: 'u1' } }],
        has_more: 1,
        cursor: 10,
        total: 1,
      }),
    };

    page.emit('response', response1);
    await page.waitForTimeout(5);

    // 同 URL 再次触发（应忽略）
    page.emit('response', response1);
    await page.waitForTimeout(5);

    expect(collector.getStats().responseCount).toBe(1);
    expect(collector.getStats().commentCount).toBe(1);
    expect(collector.getByCid('c1').commentText).toBe('第一条');

    collector.stop();
  });

  it('merges duplicate cid updates and preserves author reply info from later responses', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1&cursor=0',
      status: () => 200,
      json: async () => ({
        comments: [
          { cid: 'c1', text: '第一版', user: { nickname: 'u1' }, reply_comment_total: 0, reply_comment: [] },
        ],
      }),
    });
    await page.waitForTimeout(5);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1&cursor=10',
      status: () => 200,
      json: async () => ({
        comments: [
          {
            cid: 'c1',
            text: '第一版',
            user: { nickname: 'u1' },
            reply_comment_total: 1,
            reply_comment: [
              { cid: 'reply-1', text: '作者回复', label_text: '作者', label_type: 1 },
            ],
          },
        ],
      }),
    });
    await page.waitForTimeout(5);

    const comment = collector.getByCid('c1');
    expect(comment).toBeTruthy();
    expect(comment.hasAuthorReply).toBe(true);
    expect(comment.authorReplyCount).toBe(1);
    expect(comment.authorReplyCids).toEqual(['reply-1']);
    expect(collector.getStats().commentCount).toBe(1);

    collector.stop();
  });

  it('waitForComment returns comment when found', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    // 提前触发 response
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1',
      status: () => 200,
      json: async () => ({
        comments: [{ cid: 'target-1', text: '目标评论', user: { nickname: 'u1' } }],
      }),
    });

    const found = await collector.waitForComment('target-1', { timeoutMs: 100 });
    expect(found).toBeTruthy();
    expect(found.commentText).toBe('目标评论');

    collector.stop();
  });

  it('waitForComment returns null on timeout', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    const found = await collector.waitForComment('non-existent', { timeoutMs: 50 });
    expect(found).toBeNull();

    collector.stop();
  });

  it('getAllComments returns all collected comments', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1',
      status: () => 200,
      json: async () => ({
        comments: [
          { cid: 'a', text: 'A', user: { nickname: 'a' } },
          { cid: 'b', text: 'B', user: { nickname: 'b' } },
        ],
      }),
    });

    await page.waitForTimeout(5);
    const all = collector.getAllComments();
    expect(all).toHaveLength(2);
    expect(all.map(c => c.commentText).sort()).toEqual(['A', 'B']);

    collector.stop();
  });

  it('handles parse failure gracefully', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1',
      status: () => 200,
      json: async () => { throw new Error('parse error'); },
    });

    await page.waitForTimeout(5);
    expect(collector.getStats().parseFailed).toBe(1);
    expect(collector.getStats().responseCount).toBe(0); // responseCount 不计入失败的
    expect(collector.getStats().commentCount).toBe(0);

    collector.stop();
  });

  it('skip comments without cid', async () => {
    const page = createMockPage();
    const collector = createCommentListApiCollector(page);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=a1',
      status: () => 200,
      json: async () => ({
        comments: [
          { cid: '', text: '无cid', user: { nickname: 'noop' } },
          { cid: 'valid', text: '有效', user: { nickname: 'valid' } },
        ],
      }),
    });

    await page.waitForTimeout(5);
    expect(collector.getStats().commentCount).toBe(1);
    expect(collector.getByCid('valid')).toBeTruthy();
    expect(collector.getByCid('')).toBeNull();

    collector.stop();
  });
});
