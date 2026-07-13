import { describe, it, expect } from 'vitest';
import {
  validateSelectedComment,
  isExecuteAllowed,
  FORBIDDEN_WORDS,
  FORBIDDEN_PATTERN,
} from '../../src/domain/comment-policy.mjs';

describe('validateSelectedComment', () => {
  it('low + auto_simple + user_selected_template → valid', () => {
    const r = validateSelectedComment({
      text: '支持一下',
      replyMode: 'auto_simple',
      riskLevel: 'low',
      manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('medium + agent_generated + user_selected_agent_comment → valid', () => {
    const r = validateSelectedComment({
      text: 'React做得不错',
      replyMode: 'agent_generated_review_required',
      riskLevel: 'medium',
      manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(true);
  });

  it('high → invalid', () => {
    const r = validateSelectedComment({
      text: 'test', replyMode: 'auto_simple', riskLevel: 'high', manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
  });

  it('ignore → invalid', () => {
    const r = validateSelectedComment({
      text: 'test', replyMode: 'ignore', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
  });

  it('empty text → invalid', () => {
    const r = validateSelectedComment({
      text: '', replyMode: 'auto_simple', riskLevel: 'low', manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
  });

  it('null text → invalid', () => {
    const r = validateSelectedComment({
      text: null, replyMode: 'auto_simple', riskLevel: 'low', manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
  });

  it('no manualReviewMethod → invalid', () => {
    const r = validateSelectedComment({
      text: 'test', replyMode: 'auto_simple', riskLevel: 'low', manualReviewMethod: null,
    });
    expect(r.valid).toBe(false);
  });

  it('forbidden word "互关" → invalid', () => {
    const r = validateSelectedComment({
      text: '互关一下', replyMode: 'agent_generated_review_required', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('forbidden'))).toBe(true);
  });

  it('forbidden word "回访" → invalid', () => {
    const r = validateSelectedComment({
      text: '回访啦', replyMode: 'agent_generated_review_required', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
  });

  it('forbidden gendered address "老哥" → invalid', () => {
    const r = validateSelectedComment({
      text: '老哥说得对', replyMode: 'agent_generated_review_required', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('forbidden'))).toBe(true);
  });

  it('over 40 chars → invalid', () => {
    const r = validateSelectedComment({
      text: '啊'.repeat(41), replyMode: 'auto_simple', riskLevel: 'low', manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('too long'))).toBe(true);
  });

  it('wrong combo (medium + auto_simple) → invalid', () => {
    const r = validateSelectedComment({
      text: 'test', replyMode: 'auto_simple', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(false);
  });

  it('8~24 chinese chars within recommended range → valid', () => {
    const r = validateSelectedComment({
      text: '这个视频做得挺不错的', replyMode: 'agent_generated_review_required', riskLevel: 'medium', manualReviewMethod: 'user_selected_agent_comment',
    });
    expect(r.valid).toBe(true);
  });

  it('short chinese (<8) → warning but still valid if combo ok', () => {
    const r = validateSelectedComment({
      text: '不错', replyMode: 'auto_simple', riskLevel: 'low', manualReviewMethod: 'user_selected_template',
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.includes('recommended'))).toBe(true);
  });
});

describe('isExecuteAllowed', () => {
  it('valid combo → allowed', () => {
    expect(isExecuteAllowed(
      { riskLevel: 'medium', replyMode: 'agent_generated_review_required' },
      { selectedCommentText: 'test', manualReviewMethod: 'user_selected_agent_comment' },
    )).toBe(true);
  });

  it('no selectedCommentText → blocked', () => {
    expect(isExecuteAllowed(
      { riskLevel: 'low', replyMode: 'auto_simple' },
      { selectedCommentText: null, manualReviewMethod: 'user_selected_template' },
    )).toBe(false);
  });

  it('null candidate → blocked', () => {
    expect(isExecuteAllowed(null, {})).toBe(false);
  });

  it('null record → blocked', () => {
    expect(isExecuteAllowed({ riskLevel: 'low', replyMode: 'auto_simple' }, null)).toBe(false);
  });
});

describe('FORBIDDEN_WORDS / FORBIDDEN_PATTERN', () => {
  it('FORBIDDEN_WORDS includes key words', () => {
    expect(FORBIDDEN_WORDS).toContain('互关');
    expect(FORBIDDEN_WORDS).toContain('回访');
    expect(FORBIDDEN_WORDS).toContain('已赞');
    expect(FORBIDDEN_WORDS).toContain('三连');
    expect(FORBIDDEN_WORDS).toContain('求关注');
    expect(FORBIDDEN_WORDS).toContain('加V');
    expect(FORBIDDEN_WORDS).toContain('引流');
    expect(FORBIDDEN_WORDS).toContain('广告');
  });

  it('FORBIDDEN_PATTERN matches forbidden words', () => {
    expect(FORBIDDEN_PATTERN.test('互关')).toBe(true);
    expect(FORBIDDEN_PATTERN.test('回访')).toBe(true);
    expect(FORBIDDEN_PATTERN.test('正常评论')).toBe(false);
  });
});
