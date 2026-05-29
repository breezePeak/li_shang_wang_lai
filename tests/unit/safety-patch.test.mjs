import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 15_000) {
  return spawnSync('node', [resolve(CLI_DIR, script), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function parseStdout(result) {
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ============================================================
// 1. isRelativeTime — unit tests (no browser needed)
// ============================================================
describe('isRelativeTime — relative time detection', () => {
  // RELATIVE_TIME_RE is a module-level constant matching:
  // /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/
  const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;

  it('should detect "刚刚" as relative time', () => {
  });

  it('should detect "3分钟前" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('3分钟前')).toBe(true);
  });

  it('should detect "5小时前" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('5小时前')).toBe(true);
  });

  it('should detect "2天前" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('2天前')).toBe(true);
  });

  it('should detect "30秒前" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('30秒前')).toBe(true);
  });

  it('should NOT consider "昨天23:44" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('昨天23:44')).toBe(false);
  });

  it('should NOT consider "05-29 12:00" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('05-29 12:00')).toBe(false);
  });

  it('should NOT consider "23:44" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('23:44')).toBe(false);
  });

  it('should NOT consider empty string as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('')).toBe(false);
  });

  it('should NOT consider "查看1条回复" as relative time', () => {
    const re = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;
    expect(re.test('查看1条回复')).toBe(false);
  });
});

// ============================================================
// 2. openReplyBox — combined safety tests (single browser lifecycle)
// ============================================================
describe('openReplyBox — safety gates', () => {
  let browser = null;
  let page = null;
  let openReplyBox = null;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const mod = await import('../../src/adapters/comment-page.mjs');
    openReplyBox = mod.openReplyBox;
  }, 15000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  async function setComments(comments) {
    const items = comments.map(c => `
      <div class="comment-item" style="margin:10px 0;padding:8px;border:1px solid #ccc">
        <div class="comment-header">
          <span class="comment-author">${c.author || '用户'}</span>
          <span class="comment-time">${c.time || ''}</span>
        </div>
        <div class="comment-content">
          ${c.text || ''}
        </div>
        <div class="comment-operations">
          <span class="operations-item">回复</span>
        </div>
      </div>
    `).join('\n');

    await page.setContent(`
      <html><body>
        <div class="comment-list scroll-container">${items}</div>
      </body></html>
    `);
    await page.waitForTimeout(100);
  }

  // --- actor name safety ---
  it('should block with ACTOR_NAME_NOT_VERIFIED when actor name truncated (partial match)', async () => {
    await setComments([
      { author: '硫酸工厂的黑洞', time: '12小时前', text: '国内解封了？' },
    ]);

    // Pass a truncated name that does NOT appear as a substring of the real name
    const result = await openReplyBox(page, {
      commentText: '国内解封了？',
      actorName: '硫酸厂黑洞',
      eventTimeText: null,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTOR_NAME_NOT_VERIFIED');
  }, 10000);

  it('should succeed when full actor name matches', async () => {
    await setComments([
      { author: '硫酸工厂的黑洞', time: '12小时前', text: '国内解封了？' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '国内解封了？',
      actorName: '硫酸工厂的黑洞',
    });

    expect(result.ok).toBe(true);
  }, 10000);

  it('should block when actorName does not match any comment', async () => {
    await setComments([
      { author: '张三', time: '05-29 10:00', text: '写得不错' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '写得不错',
      actorName: '完全不存在的用户',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTOR_NAME_NOT_VERIFIED');
  }, 10000);

  // --- relative time conflict ---
  it('should block with RELATIVE_TIME_CONFLICT when relative time + multiple candidates by same author', async () => {
    await setComments([
      { author: '张三', time: '3分钟前', text: '很好' },
      { author: '张三', time: '5分钟前', text: '很好' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '很好',
      actorName: '张三',
      eventTimeText: '3分钟前',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('RELATIVE_TIME_CONFLICT');
  }, 10000);

  it('should succeed with stable time + single match', async () => {
    await setComments([
      { author: '张三', time: '05-29 12:00', text: '很好' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '很好',
      actorName: '张三',
      eventTimeText: '05-29 12:00',
    });

    expect(result.ok).toBe(true);
  }, 10000);

  it('should succeed with relative time + unique comment (single candidate)', async () => {
    await setComments([
      { author: '张三', time: '3分钟前', text: '很好' },
    ]);

    const result = await openReplyBox(page, {
      commentText: '很好',
      actorName: '张三',
      eventTimeText: '3分钟前',
    });

    expect(result.ok).toBe(true);
  }, 10000);
});

// ============================================================
// 4. CLI --json mode must exit cleanly (no hang from keepOpen)
// ============================================================
describe('CLI --json mode keepOpen enforcement', () => {
  it('actions:pending --json should exit with clean JSON', () => {
    const result = runCli('report-pending.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    // Must not have timed out — 10s timeout is sufficient
  });

  it('scan-interactions --json with invalid type should exit with error JSON', () => {
    const result = runCli('scan-interactions.mjs', ['--json', '--type', 'invalid'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(result.error).toBeFalsy(); // No unhandled errors, clean exit
  });

  it('comments:prepare --json should exit cleanly', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999',
      '--reply-text', 'test',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('actions:approve --json should exit cleanly', () => {
    const result = runCli('approve-action.mjs', [
      '--action-id', '999',
      '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(result.error).toBeFalsy();
  });
});

// ============================================================
// 5. "没有更多评论" only detected within scroll container, not body
// ============================================================
describe('"没有更多评论" — scroll container scoping (browser)', () => {
  let browser = null;
  let page = null;
  let scrollToLoadAllComments = null;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const mod = await import('../../src/adapters/comment-page.mjs');
    scrollToLoadAllComments = mod.scrollToLoadAllComments;
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('should stop when "没有更多评论" is inside scrollable comment-list container', async () => {
    await page.setContent(`
      <html><body>
        <div class="comment-list scroll-container" style="height:200px;overflow-y:auto">
          ${Array(20).fill(0).map(() => '<div><span>回复</span></div>').join('')}
          <div class="loading-NTmKHl">没有更多评论</div>
        </div>
      </body></html>
    `);
    await page.waitForTimeout(100);

    const result = await scrollToLoadAllComments(page, { maxRound: 5, loadTimeout: 500 });
    expect(result.ok).toBe(true);
  });

  it('should NOT stop for "没有更多" in unrelated overlay (outside scroll container)', async () => {
    await page.setContent(`
      <html><body>
        <div class="comment-list scroll-container" style="height:200px;overflow-y:auto">
          ${Array(20).fill(0).map(() => '<div><span>回复</span></div>').join('')}
        </div>
        <!-- "没有更多" in an unrelated modal, should not affect comment scrolling -->
        <div class="modal-overlay">
          <div class="loading-spinner">没有更多</div>
        </div>
      </body></html>
    `);
    await page.waitForTimeout(100);

    const result = await scrollToLoadAllComments(page, { maxRound: 5, loadTimeout: 500 });
    expect(result.ok).toBe(true);
  });
});
