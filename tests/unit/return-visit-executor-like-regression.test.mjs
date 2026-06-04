import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkLikeStateMock = vi.fn();
const clickLikeMock = vi.fn();
const confirmLikeSucceededMock = vi.fn();
const postVideoCommentMock = vi.fn();
const waitForWorkModalMock = vi.fn();
const postWorkModalCommentMock = vi.fn();
const collectCurrentOpenedWorkMock = vi.fn();
const openProfileWorkByAwemeIdMock = vi.fn();
const collectWorkFromUrlMock = vi.fn();
const collectCandidateWorkFromProfileMock = vi.fn();

vi.mock('../../src/adapters/video-page.mjs', () => ({
  checkLikeState: checkLikeStateMock,
  clickLike: clickLikeMock,
  confirmLikeSucceeded: confirmLikeSucceededMock,
  postVideoComment: postVideoCommentMock,
}));

vi.mock('../../src/adapters/work-modal-page.mjs', () => ({
  waitForWorkModal: waitForWorkModalMock,
  postWorkModalComment: postWorkModalCommentMock,
}));

vi.mock('../../src/services/return-visit-work-collector.mjs', () => ({
  collectCurrentOpenedWork: collectCurrentOpenedWorkMock,
  openProfileWorkByAwemeId: openProfileWorkByAwemeIdMock,
  collectWorkFromUrl: collectWorkFromUrlMock,
  collectCandidateWorkFromProfile: collectCandidateWorkFromProfileMock,
}));

const { executeReturnVisitTask } = await import('../../src/services/return-visit-executor.mjs');

describe('return-visit executor like/comment regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openProfileWorkByAwemeIdMock.mockResolvedValue({ ok: true });
    collectCurrentOpenedWorkMock.mockResolvedValue({ ok: true, work: { workId: '7647191897097693115' } });
    checkLikeStateMock.mockResolvedValue({ ok: true, data: { confidence: 'confirmed', alreadyLiked: false } });
    clickLikeMock.mockResolvedValue({ ok: true });
    confirmLikeSucceededMock.mockResolvedValue({ ok: true });
    waitForWorkModalMock.mockResolvedValue({ ok: true });
    postWorkModalCommentMock.mockResolvedValue({ ok: true, data: { sent: true } });
  });

  it('does not skip like click just because prepared userDigged=1', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't1',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 1 },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(clickLikeMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.likeStatus).toBe('liked');
  });

  it('treats unconfirmed modal comment as failed_comment', async () => {
    postWorkModalCommentMock.mockResolvedValueOnce({ ok: true, data: { sent: true, unconfirmed: true } });

    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't2',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 0 },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed_comment');
    expect(result.commentStatus).toBe('failed');
  });
});
