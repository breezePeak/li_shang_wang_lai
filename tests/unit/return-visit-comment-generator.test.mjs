import { describe, it, expect } from 'vitest';
import { 
  generateReturnVisitComment,
  validateXiaoyuanComment,
  generateXiaoyuanReturnVisitComment,
  analyzeReturnVisitContext,
} from '../../src/services/return-visit-comment-generator.mjs';

describe('Xiaoyuan Comment Persona - validateXiaoyuanComment', () => {
  it('validates standard Xiaoyuan comments', () => {
    expect(validateXiaoyuanComment('小猿看完觉得这个思路梳理得挺清楚的。')).toBe(true);
  });

  it('rejects comments that do not contain 小猿', () => {
    expect(validateXiaoyuanComment('觉得这个思路梳理得挺清楚的。')).toBe(false);
  });

  it('rejects comments containing 主人', () => {
    expect(validateXiaoyuanComment('小猿觉得主人分享的思路挺清楚的。')).toBe(false);
  });

  it('rejects comments that are too short (< 14 chars)', () => {
    // 13个字符
    expect(validateXiaoyuanComment('小猿觉得思路挺清楚的。')).toBe(false);
  });

  it('rejects comments that are too long (> 36 chars)', () => {
    // 37个字符
    expect(validateXiaoyuanComment('小猿觉得这个思路梳理得挺清楚的我们后面一定要非常认真地把它完全落实在我们的业务系统里。')).toBe(false);
  });

  it('rejects comments with emoji', () => {
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺好的😊。')).toBe(false);
  });

  it('rejects comments with exclamation marks', () => {
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺清楚！')).toBe(false);
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺清楚! ')).toBe(false);
  });

  it('rejects comments with consecutive punctuations', () => {
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺清楚..')).toBe(false);
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺清楚，，感觉很不错。')).toBe(false);
  });

  it('rejects comments containing blacklisted terms', () => {
    expect(validateXiaoyuanComment('小猿看完觉得互关非常重要感觉不错。')).toBe(false);
    expect(validateXiaoyuanComment('小猿路过并支持一下感觉真的很棒。')).toBe(false);
    expect(validateXiaoyuanComment('小猿觉得自动回复功能非常的不错。')).toBe(false);
  });

  it('rejects comments that copy references', () => {
    const references = ['小猿看完觉得这个思路梳理得挺清楚的。'];
    expect(validateXiaoyuanComment('小猿看完觉得这个思路梳理得挺清楚的。', references)).toBe(false);
  });

  it('rejects comments that verbatim repeat titles', () => {
    const title = '如何做慢查询接口优化';
    expect(validateXiaoyuanComment('小猿看完觉得如何做慢查询接口优化讲解挺清楚。', [], title)).toBe(false);
  });

  it('rejects comments fabricating behaviors', () => {
    expect(validateXiaoyuanComment('小猿看完觉得这个思路挺好已经收藏了。')).toBe(false);
    expect(validateXiaoyuanComment('小猿觉得这套设备真好刚好买了一个。')).toBe(false);
  });
});

describe('Xiaoyuan Comment Generator', () => {
  it('generates fallback comments when content is deficient (short)', () => {
    const result = generateReturnVisitComment({
      workTitle: '测试',
      workText: '',
      contentSummary: '',
      referenceComments: [],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('deficient_generic_fallback');
    expect(result.comment.length).toBeGreaterThanOrEqual(14);
    expect(result.comment.length).toBeLessThanOrEqual(36);
    expect(result.comment).toContain('小猿');
    expect(result.comment).not.toContain('主人');
  });

  it('generates a valid Xiaoyuan comment for tutorial-like content', () => {
    const result = generateXiaoyuanReturnVisitComment({
      workTitle: '剪映教程：三步快速完成视频剪辑',
      workText: '在这条教程中，小猿详细分享了关于字幕关键帧、剪切切片技巧和多轨道对齐的高级干货方法。',
      contentSummary: '干货剪辑教程',
      referenceComments: ['步骤好细', '真棒'],
    });
    expect(result.ok).toBe(true);
    expect(result.comment.length).toBeGreaterThanOrEqual(14);
    expect(result.comment.length).toBeLessThanOrEqual(36);
    expect(result.comment).toContain('小猿');
    expect(result.comment).not.toMatch(/[!！]/);
    expect(result.comment).not.toMatch(/互关|回访|主人|支持一下|收藏了/);
  });

  it('does not duplicate reference comments', () => {
    const result = generateXiaoyuanReturnVisitComment({
      workTitle: '技术复盘：接口慢查询定位',
      workText: '从日志和链路追踪入手，定位慢查询并优化索引。',
      contentSummary: '思路清晰，细节完整',
      referenceComments: ['小猿看完觉得这个思考角度挺有启发，读完以后确实带来了一些新思路。'],
    });
    expect(result.ok).toBe(true);
    expect(result.comment).not.toBe('小猿看完觉得这个思考角度挺有启发，读完以后确实带来了一些新思路。');
    expect(result.comment).toContain('小猿');
  });

  it('analyzes video content and existing comments before generating a new comment', () => {
    const analysis = analyzeReturnVisitContext({
      workTitle: '周末带孩子去水上乐园玩水',
      workText: '真实生活分享计划，记录孩子游泳和玩水的日常片段。',
      referenceComments: ['哈哈太欢乐了', '孩子好开心', '这种日常很真实'],
    });
    expect(analysis.contentType).toBe('life');
    expect(analysis.commentFocus).toBe('light');

    const result = generateReturnVisitComment({
      workTitle: '周末带孩子去水上乐园玩水',
      workText: '真实生活分享计划，记录孩子游泳和玩水的日常片段。',
      referenceComments: ['哈哈太欢乐了', '孩子好开心', '这种日常很真实'],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('agent_context');
    expect(result.comment).toContain('小猿');
    expect(result.comment).not.toBe('哈哈太欢乐了');
    expect(result.comment).not.toContain('回访');
  });
});
