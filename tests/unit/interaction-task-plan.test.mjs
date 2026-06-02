import { describe, it, expect } from 'vitest';
import { parseIntent, buildExecutionPlan } from '../../src/domain/interaction-task-plan.mjs';

describe('interaction task intent plan', () => {
  it('maps view-only requests to collect without task json', () => {
    const plan = buildExecutionPlan('看看最近通知里有什么互动', { days: 3, maxCount: 20 });
    expect(plan.collect).toBe(true);
    expect(plan.replyComment).toBe(false);
    expect(plan.visitBack).toBe(false);
    expect(plan.generateReplyJson).toBe(false);
    expect(plan.generateVisitJson).toBe(false);
    expect(plan.days).toBe(3);
    expect(plan.maxCount).toBe(20);
  });

  it('maps comment reply requests to reply json only', () => {
    const plan = buildExecutionPlan('看看谁给我评论了，回复一下');
    expect(plan.replyComment).toBe(true);
    expect(plan.visitBack).toBe(false);
    expect(plan.generateReplyJson).toBe(true);
    expect(plan.generateVisitJson).toBe(false);
    expect(plan.collectTypes).toContain('comment');
  });

  it('maps like visit requests to visit json only', () => {
    const plan = buildExecutionPlan('看看谁给我点赞了，回访一下');
    expect(plan.replyComment).toBe(false);
    expect(plan.visitBack).toBe(true);
    expect(plan.generateReplyJson).toBe(false);
    expect(plan.generateVisitJson).toBe(true);
    expect(plan.collectTypes).toContain('like');
  });

  it('allows explicit combined reply and visit plan', () => {
    const intent = parseIntent('评论回复并回访', { replyComment: true, visitBack: true, collectTypes: ['comment'] });
    expect(intent.replyComment).toBe(true);
    expect(intent.visitBack).toBe(true);
    expect(intent.collectTypes).toContain('comment');
  });
});
