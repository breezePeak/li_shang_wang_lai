import { describe, it, expect } from 'vitest';
import { generateReturnVisitComment } from '../../src/services/return-visit-comment-generator.mjs';

describe('generateReturnVisitComment', () => {
  it('returns content_too_short when work text is insufficient', () => {
    const result = generateReturnVisitComment({
      workTitle: '测试',
      workText: '',
      contentSummary: '',
      referenceComments: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('content_too_short');
  });

  it('generates a valid comment for tutorial-like content', () => {
    const result = generateReturnVisitComment({
      workTitle: '剪映教程：三步做字幕',
      workText: '这条视频讲了字幕样式和关键帧设置，适合新手直接上手。',
      contentSummary: '教程类作品，步骤清晰',
      referenceComments: ['讲得好细', '收藏了'],
    });
    expect(result.ok).toBe(true);
    expect(result.comment.length).toBeGreaterThanOrEqual(12);
    expect(result.comment.length).toBeLessThanOrEqual(30);
    expect(result.comment).not.toMatch(/[!！]/);
    expect(result.comment).not.toMatch(/互关|回访|引流|广告/);
  });

  it('does not copy reference comments verbatim', () => {
    const result = generateReturnVisitComment({
      workTitle: '技术复盘：接口慢查询定位',
      workText: '从日志和链路追踪入手，定位慢查询并优化索引。',
      contentSummary: '思路清晰，细节完整',
      referenceComments: ['这个角度挺有启发，读完确实有新思路。'],
    });
    expect(result.ok).toBe(true);
    expect(result.comment).not.toBe('这个角度挺有启发，读完确实有新思路。');
  });
});
