import { describe, it, expect } from 'vitest';
import { printJsonResult, printJsonError } from '../../src/utils/cli-output.mjs';

// Capture console output for verification
function captureStdout(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(...args);
  try { fn(); } finally { console.log = orig; }
  return logs;
}

function captureStderr(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(...args);
  try { fn(); } finally { console.error = orig; }
  return logs;
}

describe('cli-output', () => {
  it('printJsonResult should output valid JSON to stdout', () => {
    const logs = captureStdout(() => {
      printJsonResult('interactions:scan', { counts: [{ event_type: 'comment', status: 'new', count: 3 }] }, { total: 3 });
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('interactions:scan');
    expect(parsed.summary.total).toBe(3);
    expect(parsed.data.counts).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  it('printJsonError should output valid JSON to stdout', () => {
    const logs = captureStdout(() => {
      printJsonError('likes:reciprocate', 'FEATURE_DISABLED', 'MVP 阶段默认禁用', { recoverable: false });
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('likes:reciprocate');
    expect(parsed.code).toBe('FEATURE_DISABLED');
    expect(parsed.recoverable).toBe(false);
  });

  it('printJsonError with data field', () => {
    const logs = captureStdout(() => {
      printJsonError('comments:execute', 'BLOCKED', '定位失败', { data: { eventId: 1 }, evidence: '/tmp/ev' });
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.data.eventId).toBe(1);
    expect(parsed.evidence).toBe('/tmp/ev');
  });
});
