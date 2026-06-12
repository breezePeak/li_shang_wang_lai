import { describe, it, expect } from 'vitest';
import { createRunContext, parseCommonArgs } from '../../src/browser/run-context.mjs';

describe('createRunContext', () => {
  it('initializes processed to 0', () => {
    const run = createRunContext('test', { dryRun: true, execute: false, maxItems: 1, debug: false, json: false, keepOpen: false, keepOpenOnError: false, pauseOnError: false });
    expect(run.processed).toBe(0);
  });

  it('initializes executed to 0', () => {
    const run = createRunContext('test', { dryRun: true, execute: false, maxItems: 1, debug: false, json: false, keepOpen: false, keepOpenOnError: false, pauseOnError: false });
    expect(run.executed).toBe(0);
  });

  it('parseCommonArgs supports --headless', () => {
    const { options } = parseCommonArgs(['--headless']);
    expect(options.headless).toBe(true);
  });
});
