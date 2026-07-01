import { describe, expect, it, vi } from 'vitest';
import { createCommentSubmitApiWatcher } from '../../src/adapters/comment-submit-api-listener.mjs';

function createMockPage() {
  const listeners = new Map();
  return {
    page: {
      on: vi.fn((event, handler) => listeners.set(event, handler)),
      off: vi.fn((event, handler) => {
        if (listeners.get(event) === handler) listeners.delete(event);
      }),
      waitForTimeout: vi.fn(async () => {}),
    },
    async emitResponse(response) {
      const handler = listeners.get('response');
      if (handler) await handler(response);
    },
  };
}

function createPublishResponse({ postData, url = 'https://www.douyin.com/aweme/v1/web/comment/publish/', json = { status_code: 0, comment: { cid: 'reply-cid' } } } = {}) {
  return {
    url: () => url,
    status: () => 200,
    request: () => ({
      method: () => 'POST',
      postData: () => postData,
    }),
    json: async () => json,
  };
}

describe('createCommentSubmitApiWatcher', () => {
  it('matches submit success only when reply text and target comment id both match', async () => {
    const { page, emitResponse } = createMockPage();
    const watcher = createCommentSubmitApiWatcher(page, {
      expectedText: '谢谢支持',
      expectedTargetCommentId: 'target-cid-1',
    });

    await emitResponse(createPublishResponse({
      postData: 'reply_id=target-cid-1&text=%E8%B0%A2%E8%B0%A2%E6%94%AF%E6%8C%81',
    }));

    const success = await watcher.waitForSuccess({ timeoutMs: 1 });
    expect(success).toBeTruthy();
    expect(success.targetCommentId).toBe('target-cid-1');
    expect(success.matchedBy).toContain('target_comment');
    watcher.stop();
  });

  it('ignores successful publish responses for a different target comment id', async () => {
    const { page, emitResponse } = createMockPage();
    const watcher = createCommentSubmitApiWatcher(page, {
      expectedText: '谢谢支持',
      expectedTargetCommentId: 'target-cid-1',
    });

    await emitResponse(createPublishResponse({
      postData: 'reply_id=other-cid&text=%E8%B0%A2%E8%B0%A2%E6%94%AF%E6%8C%81',
    }));

    const success = await watcher.waitForSuccess({ timeoutMs: 1 });
    expect(success).toBeNull();
    expect(watcher.getStats().targetMismatchCount).toBe(1);
    watcher.stop();
  });

  it('matches return-visit comment success only when text and work id both match', async () => {
    const { page, emitResponse } = createMockPage();
    const watcher = createCommentSubmitApiWatcher(page, {
      expectedText: '这条作品很实用',
      expectedAwemeId: '7657537622084457593',
    });

    await emitResponse(createPublishResponse({
      url: 'https://www.douyin.com/aweme/v1/web/comment/publish/?aweme_id=7657537622084457593',
      postData: 'text=%E8%BF%99%E6%9D%A1%E4%BD%9C%E5%93%81%E5%BE%88%E5%AE%9E%E7%94%A8',
    }));

    const success = await watcher.waitForSuccess({ timeoutMs: 1 });
    expect(success).toBeTruthy();
    expect(success.targetWorkId).toBe('7657537622084457593');
    expect(success.matchedBy).toContain('work');
    watcher.stop();
  });

  it('ignores successful return-visit publish responses for a different work id', async () => {
    const { page, emitResponse } = createMockPage();
    const watcher = createCommentSubmitApiWatcher(page, {
      expectedText: '这条作品很实用',
      expectedAwemeId: '7657537622084457593',
    });

    await emitResponse(createPublishResponse({
      postData: 'aweme_id=other-work-id&text=%E8%BF%99%E6%9D%A1%E4%BD%9C%E5%93%81%E5%BE%88%E5%AE%9E%E7%94%A8',
    }));

    const success = await watcher.waitForSuccess({ timeoutMs: 1 });
    expect(success).toBeNull();
    expect(watcher.getStats().workMismatchCount).toBe(1);
    watcher.stop();
  });
});
