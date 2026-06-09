import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForWorkModalMock = vi.fn();
const postWorkModalCommentMock = vi.fn();
const postVideoCommentMock = vi.fn();

vi.mock('../../src/adapters/work-modal-page.mjs', () => ({
  waitForWorkModal: waitForWorkModalMock,
  postWorkModalComment: postWorkModalCommentMock,
}));

vi.mock('../../src/adapters/video-page.mjs', () => ({
  checkLikeState: vi.fn(),
  clickLike: vi.fn(),
  confirmLikeSucceeded: vi.fn(),
  postVideoComment: postVideoCommentMock,
}));

vi.mock('../../src/services/return-visit-work-collector.mjs', () => ({
  collectCurrentOpenedWork: vi.fn(),
  collectFirstNonTopAwemeFromProfile: vi.fn(),
  openProfileWorkByAwemeId: vi.fn(),
  extractWorkIdFromUrl: (url) => {
    const text = String(url || '');
    return text.match(/[?&]modal_id=(\d+)/)?.[1]
      || text.match(/\/(?:video|note)\/(\d+)/)?.[1]
      || null;
  },
}));

const { postReturnVisitComment } = await import('../../src/services/return-visit-executor.mjs');

describe('return-visit executor comment routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('modal 页面评论走 work-modal 定位', async () => {
    waitForWorkModalMock.mockResolvedValueOnce({ ok: true });
    postWorkModalCommentMock.mockResolvedValueOnce({ ok: true, data: { sent: true } });

    const result = await postReturnVisitComment({}, '测试评论', { isModalPage: true }, { execute: true });

    expect(waitForWorkModalMock).toHaveBeenCalledWith({}, { timeoutMs: 8000, closeAutoPlay: true });
    expect(postWorkModalCommentMock).toHaveBeenCalledWith({}, '测试评论');
    expect(postVideoCommentMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('普通详情页评论仍走 video-page', async () => {
    postVideoCommentMock.mockResolvedValueOnce({ ok: true, data: { text: '测试评论' } });

    const result = await postReturnVisitComment({}, '测试评论', { isModalPage: false }, { execute: true });

    expect(postVideoCommentMock).toHaveBeenCalledWith({}, '测试评论', { execute: true });
    expect(waitForWorkModalMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
