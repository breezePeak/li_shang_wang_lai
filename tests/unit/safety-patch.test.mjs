import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
// 1. isRelativeTime — unit tests
// ============================================================
describe('isRelativeTime — relative time detection', () => {
  const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;

  it('should detect "刚刚" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('刚刚')).toBe(true);
  });
  it('should detect "3分钟前" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('3分钟前')).toBe(true);
  });
  it('should detect "5小时前" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('5小时前')).toBe(true);
  });
  it('should detect "2天前" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('2天前')).toBe(true);
  });
  it('should detect "30秒前" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('30秒前')).toBe(true);
  });
  it('should NOT consider "昨天23:44" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('昨天23:44')).toBe(false);
  });
  it('should NOT consider "05-29 12:00" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('05-29 12:00')).toBe(false);
  });
  it('should NOT consider "23:44" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('23:44')).toBe(false);
  });
  it('should NOT consider empty string as relative time', () => {
    expect(RELATIVE_TIME_RE.test('')).toBe(false);
  });
  it('should NOT consider "查看1条回复" as relative time', () => {
    expect(RELATIVE_TIME_RE.test('查看1条回复')).toBe(false);
  });
});

// ============================================================
// 2. openReplyBox — safety gates
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

  it('should block with ACTOR_NAME_NOT_VERIFIED when actor name truncated', async () => {
    await setComments([
      { author: '硫酸工厂的黑洞', time: '12小时前', text: '国内解封了？' },
    ]);
    const result = await openReplyBox(page, {
      commentText: '国内解封了？',
      actorName: '硫酸厂黑洞',
      eventTimeText: null,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTOR_NAME_NOT_VERIFIED');
  }, 10000);

  it('should succeed when full actor name matches (stable time)', async () => {
    await setComments([
      { author: '硫酸工厂的黑洞', time: '05-29 12:00', text: '国内解封了？' },
    ]);
    const result = await openReplyBox(page, {
      commentText: '国内解封了？',
      actorName: '硫酸工厂的黑洞',
      eventTimeText: '05-29 12:00',
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

  it('should block with RELATIVE_TIME_CONFLICT when relative time + multiple candidates', async () => {
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

  it('should BLOCK with RELATIVE_TIME_CONFLICT even for single candidate with relative time (MVP rule)', async () => {
    await setComments([
      { author: '张三', time: '3分钟前', text: '你好' },
    ]);
    const result = await openReplyBox(page, {
      commentText: '你好',
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
});

// ============================================================
// 3. extractComments — multi-comment by same user
// ============================================================
describe('extractComments — same user multiple comments', () => {
  let browser = null;
  let page = null;
  let extractComments = null;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const mod = await import('../../src/adapters/comment-page.mjs');
    extractComments = mod.extractComments;
  }, 15000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('should extract all comments from the same user', async () => {
    // 3 comments from 2 different users; must not dedup by username
    await page.setContent(`
      <html><body>
        <div style="height:300px;overflow-y:auto">
          <div style="margin:10px 0;padding:8px;border:1px solid #ccc">
            <div><b>张三</b></div>
            <div style="margin-left:8px;color:#999;font-size:12px">05-29 10:00</div>
            <div class="comment-content">第一条评论</div>
            <div><button>回复</button><span>删除</span><span>举报</span></div>
          </div>
          <div style="margin:10px 0;padding:8px;border:1px solid #ccc">
            <div><b>张三</b></div>
            <div style="margin-left:8px;color:#999;font-size:12px">05-29 11:00</div>
            <div class="comment-content">第二条评论</div>
            <div><button>回复</button><span>删除</span><span>举报</span></div>
          </div>
          <div style="margin:10px 0;padding:8px;border:1px solid #ccc">
            <div><b>李四</b></div>
            <div style="margin-left:8px;color:#999;font-size:12px">05-29 12:00</div>
            <div class="comment-content">李四的评论</div>
            <div><button>回复</button><span>删除</span><span>举报</span></div>
          </div>
        </div>
      </body></html>
    `);
    await page.waitForTimeout(100);

    const result = await extractComments(page);
    expect(result.ok).toBe(true);
    // All 3 comments must be returned (no username dedup)
    expect(result.data.comments.length).toBe(3);
    const zhangsanComments = result.data.comments.filter(c => c.username === '张三');
    expect(zhangsanComments.length).toBe(2);
  }, 30000);
});

// ============================================================
// 4. Fingerprint — relative time dedup safety
// ============================================================
describe('fingerprint — relative time dedup safety', () => {
  const RELATIVE_TIME_RE = /^(刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前)$/;

  function generateFingerprint(eventType, actorName, targetWork, content, timeText) {
    const timePart = RELATIVE_TIME_RE.test((timeText || '').trim()) ? '' : (timeText || '').trim();
    const raw = [eventType, actorName, targetWork, content, timePart]
      .map(s => (s || '').trim())
      .join('||');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  it('same comment with different relative times should produce same fingerprint', () => {
    const fp1 = generateFingerprint('comment', '张三', '作品A', '很好', '3分钟前');
    const fp2 = generateFingerprint('comment', '张三', '作品A', '很好', '5分钟前');
    expect(fp1).toBe(fp2);
  });

  it('same comment with stable times should produce same fingerprint', () => {
    const fp1 = generateFingerprint('comment', '张三', '作品A', '很好', '05-29 12:00');
    const fp2 = generateFingerprint('comment', '张三', '作品A', '很好', '05-29 12:00');
    expect(fp1).toBe(fp2);
  });

  it('different comments with same relative time should produce different fingerprint', () => {
    const fp1 = generateFingerprint('comment', '张三', '作品A', '第一条', '3分钟前');
    const fp2 = generateFingerprint('comment', '张三', '作品A', '第二条', '3分钟前');
    expect(fp1).not.toBe(fp2);
  });

  it('different users, same comment text, same time should produce different fingerprint', () => {
    const fp1 = generateFingerprint('comment', '张三', '作品A', '很好', '05-29 12:00');
    const fp2 = generateFingerprint('comment', '李四', '作品A', '很好', '05-29 12:00');
    expect(fp1).not.toBe(fp2);
  });

  it('relative + stable time for same comment should differ (timePart different)', () => {
    const fp1 = generateFingerprint('comment', '张三', '作品A', '很好', '3分钟前');
    const fp2 = generateFingerprint('comment', '张三', '作品A', '很好', '05-29 12:00');
    // relative timePart is excluded (' '), stable timePart is included ('05-29 12:00')
    // These produce different fingerprints because the hash inputs differ.
    expect(fp1).not.toBe(fp2);
  });
});

// ============================================================
// 5. CLI --json mode keepOpen enforcement
// ============================================================
describe('CLI --json mode keepOpen enforcement', () => {
  it('actions:pending --json should exit with clean JSON', () => {
    const result = runCli('report-pending.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
  });

  it('scan-interactions --json with invalid type should exit with error JSON', () => {
    const result = runCli('scan-interactions.mjs', ['--json', '--type', 'invalid'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(result.error).toBeFalsy();
  });

  it('comments:prepare --json should exit cleanly', () => {
    const result = runCli('prepare-comment-reply.mjs', ['--event-id', '999', '--reply-text', 'test', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(typeof parsed.ok).toBe('boolean');
  });

  it('actions:approve --json should exit cleanly', () => {
    const result = runCli('approve-action.mjs', ['--action-id', '999', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(result.error).toBeFalsy();
  });

  it('comments:execute --json with missing action-id exits cleanly', () => {
    const result = runCli('execute-comment-reply.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});

// ============================================================
// 6. "没有更多评论" only detected within scroll container
// ============================================================
describe('"没有更多评论" — scroll container scoping', () => {
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

  it('should stop when "没有更多评论" is inside scrollable container', async () => {
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

  it('should NOT stop for "没有更多" in unrelated overlay', async () => {
    await page.setContent(`
      <html><body>
        <div class="comment-list scroll-container" style="height:200px;overflow-y:auto">
          ${Array(20).fill(0).map(() => '<div><span>回复</span></div>').join('')}
        </div>
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
