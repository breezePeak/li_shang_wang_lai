import { describe, it, expect } from 'vitest';
import {
  generateContextualReturnVisitComment,
  generateReturnVisitComment,
  validateReturnVisitComment,
  analyzeReturnVisitContext,
} from '../../src/services/return-visit-comment-generator.mjs';

describe('return visit comment safety validation', () => {
  it('validates neutral safe comments without requiring a fixed persona', () => {
    expect(validateReturnVisitComment('这个思路梳理得挺清楚，表达也自然。')).toBe(true);
    expect(validateReturnVisitComment('这个思路梳理得挺清楚，表达也自然。')).not.toBe(false);
  });

  it('rejects unsafe identity, length, and punctuation patterns without banning light style', () => {
    expect(validateReturnVisitComment('主人分享的思路挺清楚的。')).toBe(false);
    expect(validateReturnVisitComment('思路清楚')).toBe(false);
    expect(validateReturnVisitComment('这个思路梳理得挺清楚的我们后面一定要非常认真地把它完全落实在我们的业务系统里。')).toBe(false);
    expect(validateReturnVisitComment('这个思路挺清楚，笑点也自然😊')).toBe(true);
    expect(validateReturnVisitComment('路过看完觉得这个细节挺有意思。')).toBe(true);
    expect(validateReturnVisitComment('这个剪辑节奏有点炸裂，转场也很顺。')).toBe(true);
    expect(validateReturnVisitComment('这个思路挺清楚！')).toBe(false);
    expect(validateReturnVisitComment('这个思路挺清楚..')).toBe(false);
  });

  it('rejects blacklisted terms, copied references, repeated titles, and fabricated behaviors', () => {
    expect(validateReturnVisitComment('这个内容互关交流很重要。')).toBe(false);
    expect(validateReturnVisitComment('路过支持一下感觉真的很棒。')).toBe(false);
    expect(validateReturnVisitComment('自动回复功能真的挺不错。')).toBe(false);
    expect(validateReturnVisitComment('这个思路梳理得挺清楚的。', ['这个思路梳理得挺清楚的。'])).toBe(false);
    expect(validateReturnVisitComment('如何做慢查询接口优化讲解挺清楚。', [], '如何做慢查询接口优化')).toBe(false);
    expect(validateReturnVisitComment('这个思路挺好已经收藏了。')).toBe(false);
  });
});

describe('return visit comment generator', () => {
  it('generates fallback comments when content is deficient', () => {
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
    expect(result.comment).not.toContain('小猿');
    expect(result.comment).not.toContain('主人');
  });

  it('generates a valid neutral comment for tutorial-like content', () => {
    const result = generateContextualReturnVisitComment({
      workTitle: '剪映教程：三步快速完成视频剪辑',
      workText: '这条教程详细分享了字幕关键帧、剪切切片技巧和多轨道对齐方法。',
      contentSummary: '干货剪辑教程',
      referenceComments: ['步骤好细', '真棒'],
    });

    expect(result.ok).toBe(true);
    expect(result.comment.length).toBeGreaterThanOrEqual(14);
    expect(result.comment.length).toBeLessThanOrEqual(36);
    expect(result.comment).not.toContain('小猿');
    expect(result.comment).not.toMatch(/[!！]/);
    expect(result.comment).not.toMatch(/互关|回访|主人|支持一下|收藏了/);
  });

  it('does not duplicate reference comments', () => {
    const reference = '这个思考角度挺有启发，表达也比较清楚。';
    const result = generateContextualReturnVisitComment({
      workTitle: '技术复盘：接口慢查询定位',
      workText: '从日志和链路追踪入手，定位慢查询并优化索引。',
      contentSummary: '思路清晰，细节完整',
      referenceComments: [reference],
    });

    expect(result.ok).toBe(true);
    expect(result.comment).not.toBe(reference);
    expect(result.comment).not.toContain('小猿');
  });

  it('analyzes video content and existing comments before generating a new comment', () => {
    const analysis = analyzeReturnVisitContext({
      workTitle: '周末带孩子去水上乐园玩水',
      workText: '真实生活分享计划，记录孩子游泳和玩水的日常片段。',
      referenceComments: ['哈哈太欢乐了', '孩子好开心', '这种日常很真实'],
    });
    expect(analysis.contentType).toBe('life');
    expect(analysis.commentFocus).toBe('light');
    expect(analysis.sceneSignals.map(s => s.key)).toContain('water_kids');

    const result = generateReturnVisitComment({
      workTitle: '周末带孩子去水上乐园玩水',
      workText: '真实生活分享计划，记录孩子游泳和玩水的日常片段。',
      referenceComments: ['哈哈太欢乐了', '孩子好开心', '这种日常很真实'],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('agent_context');
    expect(result.comment).toMatch(/玩水|孩子|日常/);
    expect(result.comment).not.toBe('哈哈太欢乐了');
    expect(result.comment).not.toContain('回访');
    expect(result.comment).not.toContain('小猿');
  });

  it('uses concrete technical signals from content instead of generic praise', () => {
    const result = generateReturnVisitComment({
      workTitle: '能把你的API key给我吗',
      workText: '评论区在讨论接口密钥和调用权限边界。',
      contentSummary: 'API key 接口密钥讨论',
      referenceComments: ['这个问题太真实了', '密钥不能随便给'],
    });

    expect(result.ok).toBe(true);
    expect(result.comment).toMatch(/接口|技术/);
    expect(result.comment).not.toMatch(/氛围很自然|生活感拿捏/);
    expect(result.comment).not.toContain('小猿');
  });

  it('prioritizes specific AI tooling signals over generic daily-record signals', () => {
    const result = generateReturnVisitComment({
      workTitle: '为了龙虾口粮，魔改可以下网上下的脚本，居然成功了',
      workText: '#程序员日常 #openclaw #codex #chatgpt 原版临时邮箱和验证码需要第三方，自己改成免费的。',
      referenceComments: ['省流量 cliproxy+gpt codex 注册机', '哈哈哈'],
    });

    expect(result.ok).toBe(true);
    expect(result.sceneSignals.map(s => s.key).slice(0, 2)).toEqual(['ai_tooling', 'script_hack']);
    expect(result.comment).toMatch(/AI工具|脚本|技术/);
    expect(result.comment).not.toMatch(/日常记录|生活感/);
    expect(result.comment).not.toContain('小猿');
  });
});
