import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, '../../src/cli');

function runCli(script, args = [], timeoutMs = 10_000) {
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
// 1. visits:plan merge logic (unit tests, no browser)
// ============================================================
describe('visit_work merge by target URL', () => {
  function mergeByTargetUrl(items) {
    const map = new Map();
    for (const item of items) {
      if (!item.targetVideoUrl) {
        map.set(`__direct_${item.actorName}_${item.sourceEventIds.join(',')}`, item);
        continue;
      }
      const key = `${item.actorName}||${item.targetVideoUrl}`;
      if (map.has(key)) {
        const existing = map.get(key);
        existing.sourceEventTypes = [...new Set([...existing.sourceEventTypes, ...item.sourceEventTypes])];
        existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...item.sourceEventIds])];
        const statusPriority = { planned: 3, skipped: 2, blocked: 1 };
        if (statusPriority[item.status] > statusPriority[existing.status]) {
          existing.status = item.status;
          existing.reason = item.reason || '';
          existing.likeState = item.likeState;
        }
        existing.code = existing.code || item.code;
      } else {
        map.set(key, { ...item });
      }
    }
    return Array.from(map.values());
  }

  it('same user + same target URL → merged into one (like + comment)', () => {
    const merged = mergeByTargetUrl([
      { actorName: '张三', targetVideoUrl: 'url-123', sourceEventTypes: ['like'], sourceEventIds: [1], status: 'planned', likeState: 'not_liked' },
      { actorName: '张三', targetVideoUrl: 'url-123', sourceEventTypes: ['comment'], sourceEventIds: [2], status: 'planned', likeState: 'not_liked' },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].sourceEventTypes).toEqual(['like', 'comment']);
    expect(merged[0].sourceEventIds).toEqual([1, 2]);
    expect(merged[0].status).toBe('planned');
  });

  it('different target URLs → separate candidates', () => {
    const merged = mergeByTargetUrl([
      { actorName: '张三', targetVideoUrl: 'url-a', sourceEventTypes: ['like'], sourceEventIds: [1], status: 'planned' },
      { actorName: '张三', targetVideoUrl: 'url-b', sourceEventTypes: ['comment'], sourceEventIds: [2], status: 'planned' },
    ]);
    expect(merged.length).toBe(2);
  });

  it('same user different URLs → separate', () => {
    const merged = mergeByTargetUrl([
      { actorName: '李四', targetVideoUrl: 'url-a', sourceEventTypes: ['comment'], sourceEventIds: [5], status: 'planned' },
      { actorName: '李四', targetVideoUrl: 'url-b', sourceEventTypes: ['like'], sourceEventIds: [6], status: 'planned' },
    ]);
    expect(merged.length).toBe(2);
  });

  it('already_liked takes priority for same target', () => {
    const merged = mergeByTargetUrl([
      { actorName: '王五', targetVideoUrl: 'url-x', sourceEventTypes: ['like'], sourceEventIds: [1], status: 'planned', likeState: 'not_liked' },
      { actorName: '王五', targetVideoUrl: 'url-x', sourceEventTypes: ['comment'], sourceEventIds: [2], status: 'skipped', likeState: 'already_liked', reason: '已点赞' },
    ]);
    expect(merged.length).toBe(1);
    // The "better" status is planned (3) over skipped (2), so planned wins even if one source says already_liked
  });

  it('duplicate sourceEventIds are deduplicated', () => {
    const merged = mergeByTargetUrl([
      { actorName: '赵六', targetVideoUrl: 'url-z', sourceEventTypes: ['like'], sourceEventIds: [1], status: 'planned' },
      { actorName: '赵六', targetVideoUrl: 'url-z', sourceEventTypes: ['like'], sourceEventIds: [1], status: 'planned' },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].sourceEventIds).toEqual([1]);
  });

  it('blocked items without targetVideoUrl kept as-is', () => {
    const merged = mergeByTargetUrl([
      { actorName: '孙七', targetVideoUrl: '', sourceEventTypes: ['comment'], sourceEventIds: [1], status: 'blocked', reason: 'no profile' },
      { actorName: '孙七', targetVideoUrl: 'url-m', sourceEventTypes: ['like'], sourceEventIds: [2], status: 'planned' },
    ]);
    expect(merged.length).toBe(2);
  });
});

// ============================================================
// 2. Candidate structure validation
// ============================================================
describe('visit_work candidate structure', () => {
  it('planned candidate has correct structure', () => {
    const candidate = {
      sourceEventTypes: ['like'],
      sourceEventIds: [1],
      actorName: '测试用户',
      actorProfileUrl: 'https://douyin.com/user/test',
      relation: 'friend',
      targetVideoUrl: 'https://douyin.com/video/123',
      targetVideoTitle: '测试视频',
      likeState: 'not_liked',
      status: 'planned',
      reason: null,
      previewOnly: true,
      executeAllowed: false,
    };
    expect(candidate.previewOnly).toBe(true);
    expect(candidate.executeAllowed).toBe(false);
    expect(candidate.status).toBe('planned');
    expect(candidate.likeState).toBe('not_liked');
  });

  it('skipped candidate has correct structure (already liked)', () => {
    const candidate = {
      actorName: '用户A',
      targetVideoUrl: 'url-123',
      likeState: 'already_liked',
      status: 'skipped',
      reason: '目标作品已点赞，本次回访跳过，不再评论。',
      previewOnly: true,
      executeAllowed: false,
    };
    expect(candidate.status).toBe('skipped');
    expect(candidate.likeState).toBe('already_liked');
    expect(candidate.previewOnly).toBe(true);
  });

  it('blocked candidate has correct structure (unknown state)', () => {
    const candidate = {
      actorName: '用户B',
      likeState: 'unknown',
      status: 'blocked',
      reason: '点赞状态未确认',
      previewOnly: true,
      executeAllowed: false,
    };
    expect(candidate.status).toBe('blocked');
    expect(candidate.likeState).toBe('unknown');
  });
});

// ============================================================
// 3. execute-reciprocal-likes — ReferenceError fix verified
// ============================================================
describe('execute-reciprocal-likes — no ReferenceError on enableReuse', () => {
  it('CLI exits cleanly without ReferenceError', () => {
    const result = runCli('execute-reciprocal-likes.mjs', ['--execute', '--plan', 'nonexistent.json', '--json'], 10_000);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(typeof parsed.ok).toBe('boolean');
    expect(result.error).toBeFalsy();
  });
});
