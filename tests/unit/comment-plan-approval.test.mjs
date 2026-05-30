import { describe, it, expect } from 'vitest';
import { approveCommentPlan } from '../../src/domain/comment-plan-approval.mjs';

function makePlan(items = []) {
  return {
    planId: 'test-plan',
    type: 'comment_reply',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'interaction_events',
    items: items.length > 0 ? items : [
      { eventId: 1, approved: false, commentText: 'a' },
      { eventId: 2, approved: false, commentText: 'b' },
      { eventId: 3, approved: false, commentText: 'c' },
    ],
    summary: { totalCandidates: 10, planned: 3, skipped: 7, maxItems: 20 },
  };
}

describe('approveCommentPlan', () => {
  it('--all sets all items approved=true', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'all' });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(3);
    expect(plan.items.every(it => it.approved === true)).toBe(true);
  });

  it('--none sets all items approved=false', () => {
    const plan = makePlan([
      { eventId: 1, approved: true, commentText: 'a' },
      { eventId: 2, approved: true, commentText: 'b' },
    ]);
    const result = approveCommentPlan(plan, { mode: 'none' });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(2);
    expect(plan.items.every(it => it.approved === false)).toBe(true);
  });

  it('--event-id approves specific eventIds', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'selected', eventIds: [1, 3] });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(2);
    expect(plan.items[0].approved).toBe(true);
    expect(plan.items[1].approved).toBe(false);
    expect(plan.items[2].approved).toBe(true);
  });

  it('--index approves specific 1-based indices', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'selected', indices: [1, 2] });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(2);
    expect(plan.items[0].approved).toBe(true);
    expect(plan.items[1].approved).toBe(true);
    expect(plan.items[2].approved).toBe(false);
  });

  it('--reason writes approvalReason field', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'all', reason: '人工审核通过' });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(3);
    for (const item of plan.items) {
      expect(item.approvalReason).toBe('人工审核通过');
    }
  });

  it('summary.approved / pendingApproval / total / updatedAt are correct', () => {
    const plan = makePlan([
      { eventId: 1, approved: false, commentText: 'a' },
      { eventId: 2, approved: false, commentText: 'b' },
      { eventId: 3, approved: false, commentText: 'c' },
      { eventId: 4, approved: false, commentText: 'd' },
    ]);
    const result = approveCommentPlan(plan, { mode: 'selected', eventIds: [1, 3] });
    expect(result.approved).toBe(2);
    expect(result.pendingApproval).toBe(2);
    expect(plan.summary.approved).toBe(2);
    expect(plan.summary.pendingApproval).toBe(2);
    expect(plan.summary.total).toBe(4);
    expect(plan.summary.updatedAt).toBeTruthy();
  });

  it('does not destroy existing summary fields', () => {
    const plan = makePlan();
    approveCommentPlan(plan, { mode: 'all' });
    expect(plan.summary.totalCandidates).toBe(10);
    expect(plan.summary.planned).toBe(3);
    expect(plan.summary.skipped).toBe(7);
    expect(plan.summary.maxItems).toBe(20);
  });

  it('rejects non-comment_reply plan type', () => {
    const plan = { type: 'like_plan', items: [] };
    const result = approveCommentPlan(plan, { mode: 'all' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('comment_reply');
  });

  it('rejects when items is not an array', () => {
    const plan = { type: 'comment_reply', items: null };
    const result = approveCommentPlan(plan, { mode: 'all' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('数组');
  });

  it('no matching eventId yields changed=0 without crashing', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'selected', eventIds: [999] });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(0);
    expect(plan.items.every(it => it.approved === false)).toBe(true);
  });

  it('no matching index yields changed=0 without crashing', () => {
    const plan = makePlan();
    const result = approveCommentPlan(plan, { mode: 'selected', indices: [99] });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(0);
  });

  it('approve true without reason clears existing approvalReason', () => {
    const plan = makePlan([
      { eventId: 1, approved: false, approvalReason: 'old', commentText: 'a' },
    ]);
    approveCommentPlan(plan, { mode: 'selected', eventIds: [1] });
    expect(plan.items[0].approved).toBe(true);
    expect(plan.items[0].approvalReason).toBeUndefined();
  });
});
