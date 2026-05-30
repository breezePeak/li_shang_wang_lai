import { describe, it, expect } from 'vitest';
import {
  generateVisitCommentCandidates,
  FIXED_FALLBACK_TEMPLATES,
} from '../../src/domain/visit-comment-generator.mjs';

describe('FIXED_FALLBACK_TEMPLATES', () => {
  it('has 3 templates', () => {
    expect(FIXED_FALLBACK_TEMPLATES).toHaveLength(3);
  });

  it('all are low risk auto_simple', () => {
    for (const t of FIXED_FALLBACK_TEMPLATES) {
      expect(t.riskLevel).toBe('low');
      expect(t.replyMode).toBe('auto_simple');
      expect(t.autoExecuteAllowed).toBe(false);
    }
  });
});

describe('generateVisitCommentCandidates — contextual', () => {
  it('hashtag generates contextual comments', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'Python入门',
      captionText: '',
      hashtags: ['Python'],
      authorName: 'test',
      canGenerateContextualComment: true,
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const c of result) {
      expect(c.riskLevel).toBe('medium');
      expect(c.replyMode).toBe('agent_generated_review_required');
      expect(c.autoExecuteAllowed).toBe(false);
      expect(c.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('title only generates contextual comments', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'Node.js性能优化',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].riskLevel).toBe('medium');
    expect(result[0].sourceSignals.length).toBeGreaterThan(0);
  });

  it('caption generates contextual comments', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: '',
      captionText: '分享一些实用的开发技巧和经验总结',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('minimal context generates generic comments', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'a',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: true,
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe('generateVisitCommentCandidates — fallback', () => {
  it('no context → fallback fixed templates', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: '',
      captionText: '',
      hashtags: [],
      authorName: '',
      canGenerateContextualComment: false,
    });
    expect(result).toHaveLength(3);
    for (const c of result) {
      expect(c.riskLevel).toBe('low');
      expect(c.replyMode).toBe('auto_simple');
    }
  });

  it('null → fallback fixed templates', () => {
    const result = generateVisitCommentCandidates(null);
    expect(result).toHaveLength(3);
    for (const c of result) {
      expect(c.riskLevel).toBe('low');
    }
  });

  it('undefined → fallback fixed templates', () => {
    const result = generateVisitCommentCandidates(undefined);
    expect(result).toHaveLength(3);
  });
});

describe('generateVisitCommentCandidates — safety', () => {
  it('never contains blocked patterns', () => {
    const contexts = [
      { targetWorkTitle: '互关技巧', captionText: '', hashtags: ['互关'], authorName: '', canGenerateContextualComment: true },
      { targetWorkTitle: '回访教程', captionText: '', hashtags: ['回访'], authorName: '', canGenerateContextualComment: true },
      { targetWorkTitle: '已赞互赞', captionText: '', hashtags: [], authorName: '', canGenerateContextualComment: true },
      { targetWorkTitle: '', captionText: '', hashtags: [], authorName: '', canGenerateContextualComment: false },
    ];
    for (const ctx of contexts) {
      const result = generateVisitCommentCandidates(ctx);
      for (const c of result) {
        expect(c.text).not.toMatch(/互关|回访|已赞|三连|求关注|私信|加V|加微信|互赞|刷赞|代运营|引流|广告/);
      }
    }
  });

  it('never exceeds 24 chars', () => {
    const longCtx = {
      targetWorkTitle: '这是一个非常非常非常非常非常非常非常非常长的标题用来测试截断',
      captionText: '这也是一个非常非常非常非常非常非常非常非常长的描述文本用来测试截断功能是否正常工作',
      hashtags: ['超长标签测试标签'],
      authorName: '',
      canGenerateContextualComment: true,
    };
    const result = generateVisitCommentCandidates(longCtx);
    for (const c of result) {
      expect(c.text.length).toBeLessThanOrEqual(24);
    }
  });

  it('autoExecuteAllowed is always false', () => {
    const contexts = [
      { targetWorkTitle: 'Test', captionText: '', hashtags: ['test'], authorName: '', canGenerateContextualComment: true },
      { targetWorkTitle: '', captionText: '', hashtags: [], authorName: '', canGenerateContextualComment: false },
    ];
    for (const ctx of contexts) {
      const result = generateVisitCommentCandidates(ctx);
      for (const c of result) {
        expect(c.autoExecuteAllowed).toBe(false);
      }
    }
  });

  it('each candidate has required fields', () => {
    const result = generateVisitCommentCandidates({
      targetWorkTitle: 'Test',
      captionText: 'desc',
      hashtags: ['tag'],
      authorName: 'author',
      canGenerateContextualComment: true,
    });
    for (const c of result) {
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(0);
      expect(typeof c.commentCategory).toBe('string');
      expect(typeof c.replyMode).toBe('string');
      expect(['low', 'medium']).toContain(c.riskLevel);
      expect(typeof c.reason).toBe('string');
      expect(Array.isArray(c.sourceSignals)).toBe(true);
      expect(c.autoExecuteAllowed).toBe(false);
    }
  });
});
