import { describe, it, expect } from 'vitest';
import { splitWorkCommentReplyStatus } from '../../src/cli/check-manual-replies.mjs';

describe('check-manual-replies helpers', () => {
  it('把已出现作者回复的评论归到 replied，而不是 unreplied', () => {
    const result = splitWorkCommentReplyStatus([
      { actorName: '已手动回复用户', commentText: 'A', cid: '1', hasReplyButton: false, hasAuthorReply: true },
      { actorName: '待回复用户', commentText: 'B', cid: '2', hasReplyButton: true, hasAuthorReply: false },
    ]);

    expect(result.replied).toEqual([
      { actorName: '已手动回复用户', commentText: 'A', cid: '1' },
    ]);
    expect(result.unreplied).toEqual([
      { actorName: '待回复用户', commentText: 'B', cid: '2' },
    ]);
  });
});
