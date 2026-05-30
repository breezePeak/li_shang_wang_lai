import { describe, it, expect } from 'vitest';
import {
  isSafeResumeResult,
  loadResumeItemsFromResult,
  mergeResumeResultsWithPlanItems,
  buildResumeDryRunResults,
} from '../../src/cli/resume-comment-replies.mjs';

describe('isSafeResumeResult', () => {
  it('blocked + navigate → true', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'navigate' })).toBe(true);
  });

  it('blocked + select-work → true', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'select-work' })).toBe(true);
  });

  it('blocked + open-reply-box → true', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'open-reply-box' })).toBe(true);
  });

  it('blocked + execute-reply → true', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'execute-reply' })).toBe(true);
  });

  it('blocked + dry-run-locate → true', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'dry-run-locate' })).toBe(true);
  });

  it('succeeded → false', () => {
    expect(isSafeResumeResult({ status: 'succeeded', step: 'verify-reply' })).toBe(false);
  });

  it('skipped → false', () => {
    expect(isSafeResumeResult({ status: 'skipped', step: 'open-reply-box' })).toBe(false);
  });

  it('sent_unverified → false', () => {
    expect(isSafeResumeResult({ status: 'sent_unverified', step: 'verify-reply' })).toBe(false);
  });

  it('blocked + verify-reply → false', () => {
    expect(isSafeResumeResult({ status: 'blocked', step: 'verify-reply' })).toBe(false);
  });

  it('dry_run_ok → false', () => {
    expect(isSafeResumeResult({ status: 'dry_run_ok', step: 'dry-run-locate' })).toBe(false);
  });

  it('null → false', () => {
    expect(isSafeResumeResult(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isSafeResumeResult(undefined)).toBe(false);
  });
});

describe('loadResumeItemsFromResult', () => {
  it('只筛安全可恢复项', () => {
    const resultJson = {
      results: [
        { eventId: 1, status: 'blocked', step: 'open-reply-box' },
        { eventId: 2, status: 'blocked', step: 'select-work' },
        { eventId: 3, status: 'succeeded', step: 'verify-reply' },
        { eventId: 4, status: 'sent_unverified', step: 'verify-reply' },
        { eventId: 5, status: 'blocked', step: 'verify-reply' },
        { eventId: 6, status: 'skipped', step: '' },
        { eventId: 7, status: 'blocked', step: 'execute-reply' },
      ],
    };
    const items = loadResumeItemsFromResult(resultJson);
    expect(items.length).toBe(3);
    expect(items.map(i => i.eventId)).toEqual([1, 2, 7]);
  });

  it('不筛 sent_unverified', () => {
    const resultJson = {
      results: [
        { eventId: 1, status: 'sent_unverified', step: 'verify-reply' },
      ],
    };
    expect(loadResumeItemsFromResult(resultJson)).toEqual([]);
  });

  it('不筛 blocked + verify-reply', () => {
    const resultJson = {
      results: [
        { eventId: 1, status: 'blocked', step: 'verify-reply' },
      ],
    };
    expect(loadResumeItemsFromResult(resultJson)).toEqual([]);
  });

  it('保持原始顺序', () => {
    const resultJson = {
      results: [
        { eventId: 5, status: 'blocked', step: 'execute-reply' },
        { eventId: 2, status: 'blocked', step: 'open-reply-box' },
        { eventId: 8, status: 'blocked', step: 'navigate' },
      ],
    };
    const items = loadResumeItemsFromResult(resultJson);
    expect(items.map(i => i.eventId)).toEqual([5, 2, 8]);
  });

  it('空 results 返回空数组', () => {
    expect(loadResumeItemsFromResult({ results: [] })).toEqual([]);
    expect(loadResumeItemsFromResult({})).toEqual([]);
  });
});

describe('mergeResumeResultsWithPlanItems', () => {
  const planItems = [
    {
      eventId: 1,
      actorName: '张三',
      workTitle: '我的作品A',
      workId: 'w001',
      workUrl: 'https://example.com/video/1',
      commentText: '写得不错',
      replyText: '感谢支持，一起交流。',
      eventTimeText: '05-30 12:00',
      actorProfileUrl: 'https://example.com/user/1',
    },
    {
      eventId: 7,
      actorName: '李四',
      workTitle: '我的作品B',
      workId: 'w002',
      workUrl: 'https://example.com/video/2',
      commentText: '求教程',
      replyText: '后面我可以单独展开讲一下。',
      eventTimeText: '05-30 13:00',
      actorProfileUrl: 'https://example.com/user/2',
    },
  ];

  it('通过 eventId 找回完整 plan item', () => {
    const resumeResults = [
      { eventId: 1, status: 'blocked', step: 'open-reply-box', reason: '定位失败', code: 'BLOCKED' },
    ];
    const merged = mergeResumeResultsWithPlanItems(resumeResults, planItems);
    expect(merged.length).toBe(1);
    expect(merged[0]._merged).toBe(true);
    expect(merged[0].actorName).toBe('张三');
    expect(merged[0].workTitle).toBe('我的作品A');
    expect(merged[0].commentText).toBe('写得不错');
    expect(merged[0].replyText).toBe('感谢支持，一起交流。');
  });

  it('保留 _resumeFrom', () => {
    const resumeResults = [
      { eventId: 1, status: 'blocked', step: 'open-reply-box', reason: '定位失败', code: 'BLOCKED', evidenceDir: '/evidence/1', screenshotPath: '/evidence/1/screenshot.png' },
    ];
    const merged = mergeResumeResultsWithPlanItems(resumeResults, planItems);
    expect(merged[0]._resumeFrom).toEqual({
      status: 'blocked',
      step: 'open-reply-box',
      reason: '定位失败',
      code: 'BLOCKED',
      evidenceDir: '/evidence/1',
      screenshotPath: '/evidence/1/screenshot.png',
    });
  });

  it('找不到 plan item 时标记 _merged=false', () => {
    const resumeResults = [
      { eventId: 99, status: 'blocked', step: 'open-reply-box', reason: '失败', code: 'BLOCKED' },
    ];
    const merged = mergeResumeResultsWithPlanItems(resumeResults, planItems);
    expect(merged.length).toBe(1);
    expect(merged[0]._merged).toBe(false);
    expect(merged[0]._skipReason).toBe('plan item not found by eventId');
  });

  it('null planItems 不抛异常', () => {
    const resumeResults = [
      { eventId: 1, status: 'blocked', step: 'open-reply-box' },
    ];
    const merged = mergeResumeResultsWithPlanItems(resumeResults, null);
    expect(merged[0]._merged).toBe(false);
  });

  it('空 planItems 不抛异常', () => {
    const resumeResults = [
      { eventId: 1, status: 'blocked', step: 'open-reply-box' },
    ];
    const merged = mergeResumeResultsWithPlanItems(resumeResults, []);
    expect(merged[0]._merged).toBe(false);
  });
});

describe('buildResumeDryRunResults', () => {
  it('生成 dry-run 结果，status=skipped', () => {
    const items = [
      { eventId: 1, actorName: '张三', workTitle: '作品A', _resumeFrom: { status: 'blocked', step: 'open-reply-box', reason: '定位失败', code: 'BLOCKED' } },
      { eventId: 2, actorName: '李四', workTitle: '作品B', _resumeFrom: { status: 'blocked', step: 'select-work', reason: '选择失败', code: 'BLOCKED' } },
    ];
    const skippedItems = [];
    const results = buildResumeDryRunResults(items, skippedItems);
    expect(results.length).toBe(2);
    expect(results[0].status).toBe('skipped');
    expect(results[0].step).toBe('resume-preview');
    expect(results[0].code).toBe('DRY_RUN_REQUIRED');
    expect(results[0].resumeFrom.step).toBe('open-reply-box');
    expect(results[1].resumeFrom.step).toBe('select-work');
  });

  it('包含 skippedItems', () => {
    const items = [];
    const skippedItems = [
      { eventId: 99, actorName: '未知', workTitle: '', _skipReason: 'plan item not found by eventId' },
    ];
    const results = buildResumeDryRunResults(items, skippedItems);
    expect(results.length).toBe(1);
    expect(results[0].eventId).toBe(99);
    expect(results[0].status).toBe('skipped');
    expect(results[0].reason).toBe('plan item not found by eventId');
  });

  it('processed = 0（dry-run 不执行）', () => {
    const results = buildResumeDryRunResults(
      [{ eventId: 1, actorName: '张三', workTitle: '作品A', _resumeFrom: { status: 'blocked', step: 'open-reply-box' } }],
      []
    );
    expect(results.every(r => r.status === 'skipped')).toBe(true);
  });
});