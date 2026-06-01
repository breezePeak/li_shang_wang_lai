import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getReturnVisitTaskExecutionIssue } from '../../src/cli/execute-return-visit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

describe('getReturnVisitTaskExecutionIssue', () => {
  it('accepts executable task', () => {
    const issue = getReturnVisitTaskExecutionIssue({
      status: 'pending_execute',
      generatedComment: '支持一下',
      targetWork: { workUrl: 'https://www.douyin.com/video/1' },
      commentStatus: 'pending',
    });
    expect(issue).toBeNull();
  });

  it('rejects empty generatedComment', () => {
    const issue = getReturnVisitTaskExecutionIssue({
      status: 'pending_execute',
      generatedComment: '  ',
      targetWork: { workUrl: 'https://www.douyin.com/video/1' },
      commentStatus: 'pending',
    });
    expect(issue).toBe('no_generated_comment');
  });

  it('rejects empty work url', () => {
    const issue = getReturnVisitTaskExecutionIssue({
      status: 'pending_execute',
      generatedComment: '支持一下',
      targetWork: { workUrl: '' },
      commentStatus: 'pending',
    });
    expect(issue).toBe('no_work_url');
  });

  it('rejects already posted comments', () => {
    const issue = getReturnVisitTaskExecutionIssue({
      status: 'failed_comment',
      generatedComment: '支持一下',
      targetWork: { workUrl: 'https://www.douyin.com/video/1' },
      commentStatus: 'posted',
    });
    expect(issue).toBe('comment_already_posted');
  });
});

describe('live-interactions return visit routing', () => {
  const src = readFileSync(resolve(CLI_DIR, 'live-interactions.mjs'), 'utf8');

  it('uses return_visit_tasks pipeline instead of revisit-repository', () => {
    expect(src).toMatch(/createOrUpdateReturnVisitTasksFromEvents/);
    expect(src).toMatch(/listReturnVisitPrepareTasks/);
    expect(src).toMatch(/listReturnVisitExecuteTasks/);
    expect(src).not.toMatch(/revisit-repository/);
  });

  it('delegates revisit execution to executeReturnVisitTask', () => {
    expect(src).toMatch(/executeReturnVisitTask\(page,\s*task/);
  });

  it('does not directly clickLike or postVideoComment inside revisit stage', () => {
    const start = src.indexOf('async function processReturnVisitTasks(');
    const end = src.indexOf('async function returnToNotificationPanel(');
    const segment = src.slice(start, end);
    expect(segment).not.toMatch(/clickLike\(page,\s*\{ execute:\s*true \}\)/);
    expect(segment).not.toMatch(/postVideoComment\(page,/);
  });
});
