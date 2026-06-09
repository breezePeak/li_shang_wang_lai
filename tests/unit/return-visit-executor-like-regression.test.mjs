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
const collectFirstNonTopAwemeFromProfileMock = vi.fn();
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
  ensureWorkModalCommentBoxReady: ensureWorkModalCommentBoxReadyMock,
  postWorkModalComment: postWorkModalCommentMock,
}));

vi.mock('../../src/services/return-visit-work-collector.mjs', () => ({
  collectCurrentOpenedWork: collectCurrentOpenedWorkMock,
  collectFirstNonTopAwemeFromProfile: collectFirstNonTopAwemeFromProfileMock,
  extractWorkIdFromUrl: (url) => {
    const text = String(url || '');
    return text.match(/[?&]modal_id=(\d+)/)?.[1]
      || text.match(/\/(?:video|note)\/(\d+)/)?.[1]
      || null;
  },
  openProfileWorkByAwemeId: openProfileWorkByAwemeIdMock,
  collectWorkFromUrl: collectWorkFromUrlMock,
  collectCandidateWorkFromProfile: collectCandidateWorkFromProfileMock,
}));

const { buildCommentContext, executeReturnVisitTask } = await import('../../src/services/return-visit-executor.mjs');

describe('return-visit executor like/comment regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openProfileWorkByAwemeIdMock.mockResolvedValue({ ok: true });
    collectFirstNonTopAwemeFromProfileMock.mockResolvedValue({ ok: true, aweme: { workId: '7647191897097693115' } });
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

    expect(collectFirstNonTopAwemeFromProfileMock).toHaveBeenCalledTimes(1);
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
});
