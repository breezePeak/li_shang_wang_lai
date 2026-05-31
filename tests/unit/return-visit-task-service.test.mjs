import { describe, it, expect } from 'vitest';
import {
  buildIdentityKey,
  buildTaskId,
  canMarkDone,
} from '../../src/services/return-visit-task-service.mjs';

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
  });
});
