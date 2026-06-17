import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkLikeStateMock = vi.fn();
const clickLikeMock = vi.fn();
const confirmLikeSucceededMock = vi.fn();
const postVideoCommentMock = vi.fn();
const waitForWorkModalMock = vi.fn();
const ensureWorkModalCommentBoxReadyMock = vi.fn();
const postWorkModalCommentMock = vi.fn();
const collectCurrentOpenedWorkMock = vi.fn();
const openProfileWorkByAwemeIdMock = vi.fn();
const collectCandidateAwemesFromProfileMock = vi.fn();
const getDbMock = vi.fn();

vi.mock('../../src/adapters/video-page.mjs', () => ({
  checkLikeState: checkLikeStateMock,
  clickLike: clickLikeMock,
  confirmLikeSucceeded: confirmLikeSucceededMock,
  postVideoComment: postVideoCommentMock,
}));

vi.mock('../../src/adapters/work-modal-page.mjs', () => ({
  waitForWorkModal: waitForWorkModalMock,
  ensureWorkModalCommentBoxReady: ensureWorkModalCommentBoxReadyMock,
  postWorkModalComment: postWorkModalCommentMock,
}));

vi.mock('../../src/services/return-visit-work-collector.mjs', () => ({
  collectCandidateAwemesFromProfile: collectCandidateAwemesFromProfileMock,
  collectCurrentOpenedWork: collectCurrentOpenedWorkMock,
  extractWorkIdFromUrl: (url) => {
    const text = String(url || '');
    return text.match(/[?&]modal_id=(\d+)/)?.[1]
      || text.match(/\/(?:video|note)\/(\d+)/)?.[1]
      || null;
  },
  openProfileWorkByAwemeId: openProfileWorkByAwemeIdMock,
}));

vi.mock('../../src/db/database.mjs', () => ({
  getDb: getDbMock,
}));

const { buildCommentContext, executeReturnVisitTask } = await import('../../src/services/return-visit-executor.mjs');

describe('return-visit executor like/comment regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      }),
    });
    openProfileWorkByAwemeIdMock.mockResolvedValue({ ok: true });
    collectCandidateAwemesFromProfileMock.mockResolvedValue({
      ok: true,
      candidates: [{ workId: '7647191897097693115', workUrl: 'https://www.douyin.com/video/7647191897097693115', userDigged: 0 }],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '7647191897097693115',
        workTitle: '第一个作品标题',
        workText: '第一个作品正文内容',
        contentSummary: '第一个作品标题。第一个作品正文内容',
        visibleFingerprint: '第一个作品标题|第一个作品正文内容',
      },
    });
    checkLikeStateMock.mockResolvedValue({ ok: true, data: { confidence: 'confirmed', alreadyLiked: false } });
    clickLikeMock.mockResolvedValue({ ok: true });
    confirmLikeSucceededMock.mockResolvedValue({ ok: true });
    waitForWorkModalMock.mockResolvedValue({ ok: true });
    ensureWorkModalCommentBoxReadyMock.mockResolvedValue({ ok: true });
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

  it('selects the first unliked candidate within the first N works', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 0 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 0 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '111',
        workTitle: '第一条作品',
        workText: '第一条作品正文',
        contentSummary: '第一条作品正文',
        visibleFingerprint: '第一条作品|第一条作品正文',
      },
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=111'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-a',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '111', userDigged: 1 },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true, maxWorksToCheck: 2 });

    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledWith(
      page,
      'https://www.douyin.com/user/demo',
      '111',
      expect.objectContaining({ reuseCurrentProfile: true })
    );
    expect(result.ok).toBe(true);
    expect(result.selectionMode).toBe('normal_unliked');
    expect(result.resolvedWork.workId).toBe('111');
  });

  it('skips an already liked first candidate and selects the next unliked work', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 0 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '222',
        workTitle: '第二条作品',
        workText: '第二条作品正文',
        contentSummary: '第二条作品正文',
        visibleFingerprint: '第二条作品|第二条作品正文',
      },
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=222'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-b',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '222', workUrl: 'https://www.douyin.com/video/222' },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true, maxWorksToCheck: 2 });

    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledTimes(1);
    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledWith(
      page,
      'https://www.douyin.com/user/demo',
      '222',
      expect.objectContaining({ reuseCurrentProfile: true })
    );
    expect(result.ok).toBe(true);
    expect(result.resolvedWork.workId).toBe('222');
    expect(result.checkedWorks[0]).toMatchObject({
      workId: '111',
      likeState: 'already_liked',
      likeStateSource: 'post_api',
      action: 'skip',
    });
  });

  it('prefers non-top unliked work before pinned unliked work within the first N candidates', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 0, isTop: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 0, isTop: 0 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '222',
        workTitle: '第二条作品',
        workText: '第二条作品正文',
        contentSummary: '第二条作品正文',
        visibleFingerprint: '第二条作品|第二条作品正文',
      },
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=222'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-nontop-first',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true, maxWorksToCheck: 2 });

    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledTimes(1);
    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledWith(
      page,
      'https://www.douyin.com/user/demo',
      '222',
      expect.objectContaining({ reuseCurrentProfile: true })
    );
    expect(result.ok).toBe(true);
    expect(result.selectionMode).toBe('normal_unliked');
    expect(result.resolvedWork.workId).toBe('222');
  });

  it('skips return visit when all checked works are already liked', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 1 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '111',
        workTitle: '第一条作品',
        workText: '第一条作品正文',
        contentSummary: '第一条作品正文',
        visibleFingerprint: '第一条作品|第一条作品正文',
      },
    });
    const agentProvider = { generateComment: vi.fn() };
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=111'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-c',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, {
      execute: true,
      agentProvider,
    });

    expect(clickLikeMock).not.toHaveBeenCalled();
    expect(agentProvider.generateComment).not.toHaveBeenCalled();
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
    expect(result.selectionMode).toBeNull();
    expect(result.likeStatus).toBe('already_liked');
    expect(result.error).toBe('latest_2_works_already_liked');
    expect(result.checkedWorks).toHaveLength(2);
    expect(result.checkedWorks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId: '111', action: 'skip', reason: 'all_candidates_already_liked' }),
      expect.objectContaining({ workId: '222', action: 'skip', reason: 'all_candidates_already_liked' }),
    ]));
  });

  it('includes pinned works in the all-liked skip decision', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1, isTop: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 1, isTop: 0 },
      ],
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-c2',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, {
      execute: true,
    });

    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
    expect(result.error).toBe('latest_2_works_already_liked');
    expect(result.checkedWorks).toHaveLength(2);
    expect(result.checkedWorks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workId: '111', action: 'skip', reason: 'all_candidates_already_liked' }),
      expect.objectContaining({ workId: '222', action: 'skip', reason: 'all_candidates_already_liked' }),
    ]));
  });

  it('does not process unliked works beyond the first N candidates', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 1 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '111',
        workTitle: '第一条作品',
        workText: '第一条作品正文',
        contentSummary: '第一条作品正文',
        visibleFingerprint: '第一条作品|第一条作品正文',
      },
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=111'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-d',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, {
      execute: false,
      maxWorksToCheck: 2,
    });

    expect(openProfileWorkByAwemeIdMock).not.toHaveBeenCalled();
    expect(result.selectionMode).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
    expect(result.error).toBe('latest_2_works_already_liked');
  });

  it('all-liked branch no longer depends on duplicate update-request comment checks', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1, isTop: 1 },
        { workId: '222', workUrl: 'https://www.douyin.com/video/222', userDigged: 1, isTop: 0 },
      ],
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '222',
        workTitle: '第二条作品',
        workText: '第二条作品正文',
        contentSummary: '第二条作品正文',
        visibleFingerprint: '第二条作品|第二条作品正文',
      },
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=222'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-c3',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, {
      execute: true,
    });

    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
    expect(result.error).toBe('latest_2_works_already_liked');
  });

  it('skips the candidate when post API does not provide userDigged', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: null },
      ],
    });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=111'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'pick-e',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '111', workUrl: 'https://www.douyin.com/video/111' },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(openProfileWorkByAwemeIdMock).not.toHaveBeenCalled();
    expect(checkLikeStateMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
    expect(result.checkedWorks[0]).toMatchObject({
      workId: '111',
      likeState: 'unknown',
      likeStateSource: 'post_api',
      reason: 'user_digged_missing_in_post_api',
    });
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
    expect(result.status).toBe('failed');
    expect(result.commentStatus).toBe('failed');
  });

  it('falls back to a profile work when task has no target work', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't3',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(collectCandidateAwemesFromProfileMock).toHaveBeenCalledTimes(1);
    expect(openProfileWorkByAwemeIdMock).toHaveBeenCalledWith(
      page,
      'https://www.douyin.com/user/demo',
      '7647191897097693115',
      expect.objectContaining({ reuseCurrentProfile: true })
    );
    expect(result.ok).toBe(true);
  });

  it('blocks like/comment when autoplay moved to a different work', async () => {
    const page = {
      url: vi.fn()
        .mockReturnValueOnce('https://www.douyin.com/user/demo?modal_id=7647191897097693115')
        .mockReturnValueOnce('https://www.douyin.com/user/demo?modal_id=7647191897097693115')
        .mockReturnValueOnce('https://www.douyin.com/user/demo?modal_id=7647191897097693115')
        .mockReturnValue('https://www.douyin.com/user/demo?modal_id=9999999999999999999'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: true }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't4',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 0 },
      generatedComment: '测试评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('wrong_work_after_watch');
    expect(checkLikeStateMock).not.toHaveBeenCalled();
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
  });

  it('blocks before agent when opened work id differs from target work id', async () => {
    collectCurrentOpenedWorkMock.mockResolvedValueOnce({ ok: true, sufficient: true, work: { workId: '9999999999999999999', workText: '第二个作品正文内容', visibleFingerprint: '第二个作品正文内容' } });
    const agentProvider = { generateComment: vi.fn() };
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't5',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 0 },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, { execute: true, agentProvider });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('opened_work_id_mismatch');
    expect(agentProvider.generateComment).not.toHaveBeenCalled();
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
  });

  it('blocks agent when visible work fingerprint changed while url still has target id', async () => {
    collectCurrentOpenedWorkMock
      .mockResolvedValueOnce({
        ok: true,
        sufficient: true,
        work: {
          workId: '7647191897097693115',
          workTitle: '第一个作品标题',
          workText: '第一个作品正文内容',
          visibleFingerprint: '第一个作品标题|第一个作品正文内容',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        sufficient: true,
        work: {
          workId: '7647191897097693115',
          workTitle: '第二个作品标题',
          workText: '第二个作品正文内容',
          visibleFingerprint: '第二个作品标题|第二个作品正文内容',
        },
      });
    const agentProvider = { generateComment: vi.fn() };
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't6',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 0 },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, { execute: true, agentProvider });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('visible_work_changed_before_agent');
    expect(agentProvider.generateComment).not.toHaveBeenCalled();
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
  });

  it('blocks generated comment send when visible work fingerprint changed while url still has target id', async () => {
    collectCurrentOpenedWorkMock
      .mockResolvedValueOnce({
        ok: true,
        sufficient: true,
        work: {
          workId: '7647191897097693115',
          workTitle: '第一个作品标题',
          workText: '第一个作品正文内容',
          visibleFingerprint: '第一个作品标题|第一个作品正文内容',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        sufficient: true,
        work: {
          workId: '7647191897097693115',
          workTitle: '第二个作品标题',
          workText: '第二个作品正文内容',
          visibleFingerprint: '第二个作品标题|第二个作品正文内容',
        },
      });
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't7',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '7647191897097693115', userDigged: 0 },
      generatedComment: '已经生成的旧评论',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('visible_work_changed_before_comment_send');
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
  });

  it('buildCommentContext never falls back to stale task targetWork text', () => {
    const context = buildCommentContext({
      taskId: 't8',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: {
        workId: '7647191897097693115',
        desc: '第一个作品旧正文，不能给 Agent',
        workText: '第一个作品旧正文，不能给 Agent',
      },
    }, {
      workId: '7647191897097693115',
      workText: '',
      contentSummary: '',
    });

    expect(context.work.workId).toBe('7647191897097693115');
    expect(context.work.desc).toBe('');
  });

  it('does not call agent or post a normal comment when the selected work is already liked and fallback is disabled', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '111', workUrl: 'https://www.douyin.com/video/111', userDigged: 1 },
      ],
    });
    const agentProvider = { generateComment: vi.fn() };
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=111'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 'liked-no-comment',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: { workId: '', workUrl: '' },
      likeStatus: 'pending',
      commentStatus: 'pending',
    }, {
      execute: true,
      agentProvider,
      allLikedFallbackEnabled: false,
    });

    expect(agentProvider.generateComment).not.toHaveBeenCalled();
    expect(postWorkModalCommentMock).not.toHaveBeenCalled();
    expect(postVideoCommentMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('skipped_no_suitable_work');
  });

  it('regenerates cached comment when target context changed and uses matched post API aweme text', async () => {
    collectCandidateAwemesFromProfileMock.mockResolvedValueOnce({
      ok: true,
      candidates: [
        { workId: '7648591042014994938', workUrl: 'https://www.douyin.com/video/7648591042014994938', userDigged: 0 },
      ],
    });
    openProfileWorkByAwemeIdMock.mockResolvedValueOnce({
      ok: true,
      aweme: {
        workId: '7648591042014994938',
        workTitle: 'Think Max 模式',
        workText: '听说DeepSeek V4的 Think Max 模式，本质上就是给提示词加了句必须想清楚。',
        contentSummary: 'Think Max 模式。听说DeepSeek V4的 Think Max 模式。',
      },
    });
    collectCurrentOpenedWorkMock.mockResolvedValue({
      ok: true,
      sufficient: true,
      work: {
        workId: '7648591042014994938',
        workTitle: '旧 DOM 误读标题',
        workText: '为了龙虾口粮，魔改可以下载网上的脚本',
        contentSummary: '旧 DOM 误读标题。为了龙虾口粮，魔改可以下载网上的脚本',
        visibleFingerprint: '旧 DOM 误读标题|为了龙虾口粮，魔改可以下载网上的脚本',
      },
    });
    const agentProvider = {
      generateComment: vi.fn(async (context) => {
        expect(context.work.desc).toContain('DeepSeek V4');
        expect(context.work.desc).not.toContain('龙虾');
        return 'Think Max 这个说法挺形象的😂';
      }),
    };
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/user/demo?modal_id=7648591042014994938'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeReturnVisitTask(page, {
      taskId: 't9',
      userProfileUrl: 'https://www.douyin.com/user/demo',
      targetWork: {
        workId: '7648591042014994938',
        workTitle: '为了龙虾口粮，魔改可以下载网上的脚本',
        workText: '为了龙虾口粮，魔改可以下载网上的脚本',
      },
      generatedComment: '魔改脚本抓龙虾，赫妹儿直呼内行😂',
      likeStatus: 'pending',
      commentStatus: 'generated',
    }, { execute: true, agentProvider });

    expect(result.ok).toBe(true);
    expect(agentProvider.generateComment).toHaveBeenCalledTimes(1);
    expect(postWorkModalCommentMock).toHaveBeenCalledWith(page, 'Think Max 这个说法挺形象的😂');
    expect(result.generatedComment).toBe('Think Max 这个说法挺形象的😂');
  });
});
