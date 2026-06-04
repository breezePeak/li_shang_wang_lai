import { describe, it, expect } from 'vitest';
import {
  buildIdentityKey,
  buildTaskId,
  canMarkDone,
} from '../../src/services/return-visit-task-service.mjs';
import { getReturnVisitTaskExecutionIssue } from '../../src/cli/execute-return-visit.mjs';

describe('return-visit task identity', () => {
  it('prefers userId over url and name', () => {
    const key = buildIdentityKey({
      userId: 'MS4wLjABAAAA-test',
      userProfileUrl: 'https://www.douyin.com/user/abc?from=xx',
      userName: '张三',
    });
    expect(key).toBe('uid:MS4wLjABAAAA-test');
  });

  it('falls back to normalized profile url when userId is missing', () => {
    const key = buildIdentityKey({
      userId: '',
      userProfileUrl: 'https://www.douyin.com/user/abc?enter_from=search',
      userName: '张三',
    });
    expect(key).toBe('url:https://www.douyin.com/user/abc');
  });

  it('falls back to userName when both userId/url are missing', () => {
    const key = buildIdentityKey({
      userId: '',
      userProfileUrl: '',
      userName: '李四',
    });
    expect(key).toBe('name:李四');
  });
});

describe('return-visit task id', () => {
  it('is deterministic for same identity key', () => {
    const a = buildTaskId('uid:test-user');
    const b = buildTaskId('uid:test-user');
    expect(a).toBe(b);
  });
});

describe('done condition', () => {
  it('requires liked/already_liked and posted', () => {
    expect(canMarkDone({ likeStatus: 'liked', commentStatus: 'posted' })).toBe(true);
    expect(canMarkDone({ likeStatus: 'already_liked', commentStatus: 'posted' })).toBe(true);
    expect(canMarkDone({ likeStatus: 'pending', commentStatus: 'posted' })).toBe(false);
    expect(canMarkDone({ likeStatus: 'liked', commentStatus: 'generated' })).toBe(false);
    expect(canMarkDone({ likeStatus: 'failed', commentStatus: 'posted' })).toBe(false);
    expect(canMarkDone({ likeStatus: 'liked', commentStatus: 'failed' })).toBe(false);
  });
});

describe('return-visit execute filtering & state flow logic', () => {
  it('correctly identifies dirty tasks that should be skipped/marked', () => {
    const checkExecutable = (task) => {
      const hasComment = task.generatedComment && String(task.generatedComment).trim();
      const hasWorkUrl = task.targetWork?.workUrl && String(task.targetWork.workUrl).trim();
      const isTargetStatus = ['pending_execute', 'executing', 'failed_like', 'failed_comment'].includes(task.status);
      return !!(isTargetStatus && hasComment && hasWorkUrl && task.commentStatus !== 'posted');
    };

    // 脏任务 1：空 comment
    expect(checkExecutable({
      status: 'pending_execute',
      generatedComment: '',
      targetWork: { workUrl: 'https://www.douyin.com/video/1' },
      commentStatus: 'pending'
    })).toBe(false);

    // 脏任务 2：空 workUrl
    expect(checkExecutable({
      status: 'pending_execute',
      generatedComment: '好视频！',
      targetWork: { workUrl: '' },
      commentStatus: 'pending'
    })).toBe(false);

    // 正确任务
    expect(checkExecutable({
      status: 'pending_execute',
      generatedComment: '非常棒！',
      targetWork: { workUrl: 'https://www.douyin.com/video/1' },
      commentStatus: 'pending'
    })).toBe(true);
  });

  it('getReturnVisitTaskExecutionIssue 允许只有 workId 没有 workUrl', () => {
    const issue = getReturnVisitTaskExecutionIssue({
      status: 'pending_execute',
      generatedComment: '非常棒！',
      targetWork: { workId: '7647191897097693115', workUrl: '' },
      commentStatus: 'pending'
    });

    expect(issue).toBeNull();
  });

  it('retains likeStatus on failed_comment simulation', () => {
    const simulateStatusUpdate = (task, actionResult) => {
      return {
        ...task,
        status: actionResult.status,
        likeStatus: actionResult.likeStatus || task.likeStatus,
        commentStatus: actionResult.commentStatus || task.commentStatus
      };
    };

    const task = {
      taskId: 'test_task',
      likeStatus: 'pending',
      commentStatus: 'pending',
      status: 'pending_execute'
    };

    // 模拟点赞成功但评论失败
    const actionResult = {
      status: 'failed_comment',
      likeStatus: 'liked',
      commentStatus: 'failed'
    };

    const updated = simulateStatusUpdate(task, actionResult);
    expect(updated.likeStatus).toBe('liked');
    expect(updated.commentStatus).toBe('failed');
    expect(updated.status).toBe('failed_comment');
  });


});
