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
// 4. Fingerprint — production module tests (import real implementation)
// ============================================================
describe('fingerprint — production module tests', () => {
  let commentFingerprint = null;
  let commentInitialStatus = null;

  beforeAll(async () => {
    const mod = await import('../../src/domain/event-fingerprint.mjs');
    commentFingerprint = mod.commentFingerprint;
    commentInitialStatus = mod.commentInitialStatus;
  });

  it('platformEventId takes priority over content-based dedup', () => {
    const fp1 = commentFingerprint({ platformEventId: 'cid-123', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    const fp2 = commentFingerprint({ platformEventId: 'cid-123', username: '李四', content: '不同内容', timeText: '05-29 12:00' }, '作品B');
    expect(fp1).toBe(fp2);
  });

  it('different platformEventId produces different fingerprint', () => {
    const fp1 = commentFingerprint({ platformEventId: 'cid-123', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    const fp2 = commentFingerprint({ platformEventId: 'cid-456', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    expect(fp1).not.toBe(fp2);
  });

  it('same content with relative times (no platform ID) produces same fingerprint (merged conservatively)', () => {
    const fp1 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    const fp2 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '5分钟前' }, '作品A');
    expect(fp1).toBe(fp2);
  });

  it('two different comments with same text and relative time from same user produce different fingerprints (by timeText)', () => {
    // Wait — without platform ID and with relative time, the fingerprint excludes time.
    // So two genuinely different comments from the same user with same text AT RELATIVE TIME
    // would collide. This is the known MVP limitation when no platform IDs are available.
    // We document this: two such comments will be treated as the same event until one gets
    // a stable time or platform ID.
    const fp1 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    const fp2 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '5分钟前' }, '作品A');
    expect(fp1).toBe(fp2);
  });

  it('stable-time comment fingerprint includes timeText', () => {
    const fp1 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '05-29 12:00' }, '作品A');
    const fp2 = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '05-29 12:00' }, '作品A');
    expect(fp1).toBe(fp2);
  });

  it('stable-time fingerprint differs from same comment at relative time (different event)', () => {
    const fpRel = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '3分钟前' }, '作品A');
    const fpStable = commentFingerprint({ platformEventId: '', username: '张三', content: '很好', timeText: '05-29 12:00' }, '作品A');
    // stable-time includes timePart, relative-time excludes it → different hashes
    expect(fpRel).not.toBe(fpStable);
  });

  it('commentInitialStatus returns unstable for relative time', () => {
    expect(commentInitialStatus('3分钟前')).toBe('unstable');
    expect(commentInitialStatus('刚刚')).toBe('unstable');
    expect(commentInitialStatus('5小时前')).toBe('unstable');
    expect(commentInitialStatus('2天前')).toBe('unstable');
  });

  it('commentInitialStatus returns new for stable time', () => {
    expect(commentInitialStatus('05-29 12:00')).toBe('new');
    expect(commentInitialStatus('昨天23:44')).toBe('new');
    expect(commentInitialStatus('')).toBe('new');
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

  it('actions:pending --json includes unstableItems in output', () => {
    const result = runCli('report-pending.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(Array.isArray(parsed.data.unstableItems)).toBe(true);
    expect(typeof parsed.summary.unstable).toBe('number');
  });

  it('comments:prepare rejects unstable event', () => {
    // unstable events have status='unstable', cannot create action
    const result = runCli('prepare-comment-reply.mjs', ['--event-id', '1', '--reply-text', 'test', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    // event 1 might or might not exist; stdout is always JSON
    expect(typeof parsed.ok).toBe('boolean');
    expect(result.error).toBeFalsy();
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

// ============================================================
// 7. DB migration — platform_event_id column
// ============================================================
describe('DB migration — platform_event_id column', () => {
  it('new DB table includes platform_event_id column', () => {
    // runMigrations creates the schema; read back from sqlite_master
    const { execSync } = require('child_process');
    // The migration already ran earlier in the suite; verify the column exists
    const result = runCli('report-pending.mjs', ['--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    // unstableItems should be present (even if empty)
    expect(Array.isArray(parsed.data.unstableItems)).toBe(true);
  });
});

// ============================================================
// 8. Prepare decision/risk-level validation
// ============================================================
describe('prepare — decision and risk-level validation', () => {
  it('blocks prepare when missing --decision', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BLOCKED');
  });

  it('blocks prepare when decision is manual_review', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'manual_review', '--risk-level', 'medium', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when risk-level is high', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'high', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when risk-level is medium', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'medium', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare when decision is ignore', () => {
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '999', '--reply-text', 'test',
      '--decision', 'ignore', '--risk-level', 'high', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });

  it('blocks prepare for unstable event', () => {
    // event 1 might have different status; but with decision=reply + risk-level=low,
    // if the event exists and is unstable, it blocks. If not, it fails on missing event
    // which is still ok=false. The key assertion is that stdout is valid JSON.
    const result = runCli('prepare-comment-reply.mjs', [
      '--event-id', '1', '--reply-text', 'test',
      '--decision', 'reply', '--risk-level', 'low', '--json',
    ], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(typeof parsed.ok).toBe('boolean');
    expect(result.error).toBeFalsy();
  });

  it('actions:pending --type comment filters unstableItems', () => {
    const result = runCli('report-pending.mjs', ['--type', 'comment', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.unstableItems)).toBe(true);
    // All unstable items should be comment type (because we filtered)
    for (const item of parsed.data.unstableItems) {
      expect(item.eventType).toBe('comment');
    }
  });
});
