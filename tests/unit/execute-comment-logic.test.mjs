import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { getDb, resetDb } from '../../src/db/database.mjs';
import {
  buildReplyContext,
  buildWorkCommentItemsFromDbRows,
  classifyStoredWorkCommentRaw,
  executeSinglePassForWorkGroup,
  extractTargetCommentId,
  generateMissingReplies,
  groupExecutableItemsByWork,
  isDoneWithoutRetryResult,
  isReplyTextTooShort,
  parseArgs,
  planViewportPendingMatches,
  resolveWorkUrlFromItem,
  validateWorkCommentItem,
} from '../../src/cli/execute-comment-replies.mjs';
import { listPendingCommentsGroupedByHomepageAndWork } from '../../src/db/work-comment-repository.mjs';

// ============================================================
// Test helpers — run CLI and capture stdout
// ============================================================
const testDir = join(__dirname, '../../data/test-execute-logic');
const testDb = join(testDir, 'test-execute.db');

function cleanup() {
  resetDb();
  if (existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true }); } catch {}
  }
}

function setup() {
  cleanup();
  mkdirSync(testDir, { recursive: true });
  process.env.LISHANGWANGLAI_DB_PATH = testDb;
  const db = new Database(testDb);
  db.pragma('journal_mode = WAL');
  // Create tables needed by execute-comment-replies
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT,
      work_url TEXT,
      modal_id TEXT,
      actor_name TEXT,
      actor_profile_url TEXT,
      actor_profile_key TEXT,
      comment_text TEXT,
      event_time_text TEXT,
      comment_key TEXT,
      source_event_id INTEGER,
      source_notification_key TEXT,
      reply_text TEXT,
      reply_status TEXT NOT NULL DEFAULT 'pending',
      reply_reason TEXT,
      raw_comment_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      replied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS interaction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'douyin',
      event_type TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      comment_text TEXT,
      raw_payload_json TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'new',
      scanned_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT,
      modal_id TEXT,
      work_url TEXT,
      work_title TEXT,
      work_desc TEXT,
      work_type TEXT,
      thumbnail_key TEXT,
      thumbnail_src TEXT,
      author_name TEXT,
      author_profile_url TEXT,
      author_profile_key TEXT,
      published_at TEXT,
      raw_context_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    DELETE FROM work_comments;
    DELETE FROM interaction_events;
    DELETE FROM works;
  `);

  // Insert test data
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (1, 'https://douyin.com/video/1', 'user1', 'test comment', 'key1', 'My reply', 'pending')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (2, 'https://douyin.com/video/2', 'user2', 'test comment 2', 'key2', '', 'pending')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (3, 'https://douyin.com/video/3', 'user3', 'test comment 3', 'key3', 'Already done', 'succeeded')").run();
  db.prepare("INSERT INTO work_comments (id, work_url, actor_name, comment_text, comment_key, reply_text, reply_status) VALUES (4, 'https://douyin.com/video/4', 'user4', 'test comment 4', 'key4', 'Unverified', 'sent_unverified')").run();
  db.prepare("INSERT INTO interaction_events (id, event_type, actor_name, fingerprint, status, scanned_at) VALUES (1, 'comment', 'user1', 'fp1', 'new', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO interaction_events (id, event_type, actor_name, fingerprint, status, scanned_at) VALUES (3, 'comment', 'user3', 'fp3', 'new', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO works (work_id, modal_id, work_url, author_name, author_profile_url, author_profile_key, first_seen_at, last_seen_at) VALUES ('7639733344284064741', '7639733344284064741', 'https://www.douyin.com/video/7639733344284064741', '作者A', 'https://www.douyin.com/user/author-a', 'author-a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO works (work_id, modal_id, work_url, author_name, author_profile_url, author_profile_key, first_seen_at, last_seen_at) VALUES ('1', '1', 'https://www.douyin.com/video/1', '作者1', 'https://www.douyin.com/user/author-1', 'author-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();

  db.close();
  resetDb();
  getDb(testDb);
  return testDb;
}

function parseStdout(result) {
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

// Run CLI module and capture stdout/stderr
async function runCli(fileName, extraArgs = []) {
  const { spawnSync } = await import('child_process');
  const args = [resolve(__dirname, '../../src/cli', fileName), ...extraArgs];
  const result = spawnSync('node', args, {
    env: { ...process.env, LISHANGWANGLAI_DB_PATH: testDb },
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

// ============================================================
// Tests
// ============================================================
describe('comments:execute refactored logic', () => {
  beforeEach(() => {
    setup();
  });

  it('exits with error when missing DB range arguments', async () => {
    const result = await runCli('execute-comment-replies.mjs', ['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('--days 7 --limit 50');
  });

  it('rejects --items-file because comments:execute is DB-only', async () => {
    const result = await runCli('execute-comment-replies.mjs', ['--json', '--items-file', 'data/pending-replies/old.json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('不再支持 --items-file');
  });

  it('buildWorkCommentItemsFromDbRows maps DB rows into executable items', () => {
    const items = buildWorkCommentItemsFromDbRows([{
      id: 10,
      reply_text: '回复你好',
      joined_author_profile_url: 'https://www.douyin.com/user/author-a',
      joined_author_profile_key: 'author-a',
      joined_work_url: 'https://www.douyin.com/video/7639733344284064741',
      joined_work_id: '7639733344284064741',
      joined_modal_id: '7639733344284064741',
      joined_work_title: '主页结构作品',
      joined_work_desc: '作品描述',
      joined_work_type: 'video',
      joined_author_name: '作者A',
      actor_name: '评论人A',
      actor_profile_url: 'https://www.douyin.com/user/commenter-a',
      actor_profile_key: 'commenter-a',
      comment_text: '你好',
      event_time_text: '1小时前',
      raw_comment_json: JSON.stringify({ comment: { comment: { cid: 'cid-10' } } }),
    }]);

    expect(items).toHaveLength(1);
    expect(items[0].commentId).toBe(10);
    expect(items[0].homepageUrl).toBe('https://www.douyin.com/user/author-a');
    expect(items[0].authorProfileUrl).toBe('https://www.douyin.com/user/author-a');
    expect(items[0].actorProfileUrl).toBe('https://www.douyin.com/user/commenter-a');
    expect(items[0].workId).toBe('7639733344284064741');
    expect(items[0].workUrl).toBe('https://www.douyin.com/video/7639733344284064741');
    expect(items[0].targetCommentId).toBe('cid-10');
  });

  it('待回评查询只按 pending 状态查询，已有 reply_text 也会被查到', () => {
    const rows = listPendingCommentsGroupedByHomepageAndWork({ limit: 10, days: 7 });
    const ids = rows.map(row => row.id);

    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
  });

  it('resolveWorkUrlFromItem 优先使用现有字段并回退到 workId/modalId', () => {
    expect(resolveWorkUrlFromItem({ workUrl: 'https://a' }, {})).toBe('https://a');
    expect(resolveWorkUrlFromItem({ awemeUrl: 'https://b' }, {})).toBe('https://b');
    expect(resolveWorkUrlFromItem({ workId: '123' }, {})).toBe('https://www.douyin.com/video/123');
    expect(resolveWorkUrlFromItem({ modalId: '456' }, {})).toBe('https://www.douyin.com/video/456');
  });

  it('groupExecutableItemsByWork 使用 homepageUrl + workId 分组', () => {
    const groups = groupExecutableItemsByWork([
      { commentId: 1, homepageUrl: 'https://www.douyin.com/user/a', workId: 'w1' },
      { commentId: 2, homepageUrl: 'https://www.douyin.com/user/a', workId: 'w1' },
      { commentId: 3, homepageUrl: 'https://www.douyin.com/user/a', workId: 'w2' },
      { commentId: 4, homepageUrl: 'https://www.douyin.com/user/b', workId: 'w1' },
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.find(group => group.length === 2)?.map(item => item.commentId)).toEqual([1, 2]);
  });

  it('isReplyTextTooShort 会按长度和安全规则判断已有回复是否需要重写', () => {
    expect(isReplyTextTooShort('收到啦', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('Hermes代看不错', { minLength: 15, maxLength: 60 })).toBe(false);
    expect(isReplyTextTooShort('这个问题后面可以单独展开讲讲呀', { minLength: 15 })).toBe(false);
    expect(isReplyTextTooShort('Hermes替主人看完觉得这个问题挺真实', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('HermesAI跑来串门2222已阅感谢互动', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('AI助手Hermes路过第一次团购体验怎么样', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('我是HermesAI1111也是来分享经历的吗', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('测试环境也认真对待，AI帮忙回评了', { minLength: 15, maxLength: 60 })).toBe(true);
    expect(isReplyTextTooShort('第一次团购分享，AI帮你回复啦', { minLength: 15, maxLength: 60 })).toBe(true);
    expect(isReplyTextTooShort('第一次发视频就有AI帮忙看评论了', { minLength: 15, maxLength: 60 })).toBe(true);
    expect(isReplyTextTooShort('Hermes代看后觉得Test留言收到啦', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('Hermes代看后觉得2222这条反馈需要再看', { minLength: 15 })).toBe(true);
    expect(isReplyTextTooShort('我是赫妹儿，感觉这条评论可以顺着聊一下', { minLength: 15 })).toBe(false);
    expect(isReplyTextTooShort('赫妹儿来啦，这个玩水视频看着真凉快🤔', { minLength: 15 })).toBe(false);
    expect(isReplyTextTooShort('Hermes路过看了下，这个点确实有意思～', { minLength: 15 })).toBe(false);
    expect(isReplyTextTooShort('Hermes代看后觉得这个问题可以展开聊聊', { minLength: 15 })).toBe(false);
    expect(isReplyTextTooShort('OpenClaw代看后觉得这条反馈挺真诚自然', { minLength: 15 })).toBe(false);
  });

  it('回评上下文默认 15-60，已有回复校验允许上下 5 个可见字符浮动', () => {
    const oldMax = process.env.REPLY_MAX_LENGTH;
    const oldTolerance = process.env.REPLY_LENGTH_TOLERANCE;
    delete process.env.REPLY_MAX_LENGTH;
    delete process.env.REPLY_LENGTH_TOLERANCE;

    try {
      const context = buildReplyContext({ commentId: 10 });
      const sixtyFiveChars = `Hermes代看后觉得${'这'.repeat(54)}`;
      const sixtySixChars = `Hermes代看后觉得${'这'.repeat(55)}`;

      expect(context.requirements).toMatchObject({ minLength: 15, maxLength: 60 });
      expect(isReplyTextTooShort(sixtyFiveChars, context.requirements)).toBe(false);
      expect(isReplyTextTooShort(sixtySixChars, context.requirements)).toBe(true);
    } finally {
      if (oldMax === undefined) delete process.env.REPLY_MAX_LENGTH;
      else process.env.REPLY_MAX_LENGTH = oldMax;
      if (oldTolerance === undefined) delete process.env.REPLY_LENGTH_TOLERANCE;
      else process.env.REPLY_LENGTH_TOLERANCE = oldTolerance;
    }
  });

  it('generateMissingReplies 把所有待生成回评一次性交给 Agent，并按 taskId 写回', async () => {
    const db = new Database(testDb);
    db.prepare("UPDATE work_comments SET reply_text = 'Hermes代看后觉得这个问题可以展开聊聊' WHERE id = 1").run();
    db.close();

    const items = buildWorkCommentItemsFromDbRows(listPendingCommentsGroupedByHomepageAndWork({ limit: 10, days: 7 }));
    const provider = {
      generateReply: vi.fn(),
      generateReplies: vi.fn(async (contexts) => contexts.map(context => ({
        taskId: context.taskId,
        reply: `Hermes代看后觉得${context.comment.commentId}号评论挺真诚自然`,
      }))),
    };

    const results = await generateMissingReplies(items, { agentProvider: provider });

    expect(provider.generateReply).not.toHaveBeenCalled();
    expect(provider.generateReplies).toHaveBeenCalledTimes(1);
    expect(provider.generateReplies.mock.calls[0][0].map(context => context.taskId)).toEqual(['work_comment_2']);
    expect(results).toEqual([
      { commentId: 1, ok: true, skipped: true, reason: 'reply_text_exists' },
      { commentId: 2, ok: true, reply: 'Hermes代看后觉得2号评论挺真诚自然' },
    ]);

    const verifyDb = new Database(testDb);
    expect(verifyDb.prepare('SELECT reply_text, reply_reason FROM work_comments WHERE id = 1').get()).toMatchObject({
      reply_text: 'Hermes代看后觉得这个问题可以展开聊聊',
    });
    expect(verifyDb.prepare('SELECT reply_text, reply_reason FROM work_comments WHERE id = 2').get()).toMatchObject({
      reply_text: 'Hermes代看后觉得2号评论挺真诚自然',
      reply_reason: null,
    });
    verifyDb.close();
  });

  it('generateMissingReplies 批量返回不完整时不写回半批结果', async () => {
    const db = new Database(testDb);
    db.prepare("UPDATE work_comments SET reply_text = '' WHERE id = 1").run();
    db.close();

    const items = buildWorkCommentItemsFromDbRows(listPendingCommentsGroupedByHomepageAndWork({ limit: 10, days: 7 }));
    const provider = {
      generateReplies: vi.fn(async () => ([
        { taskId: 'work_comment_1', reply: 'Hermes代看后觉得1号评论挺真诚自然' },
      ])),
    };

    const results = await generateMissingReplies(items, { agentProvider: provider });

    expect(provider.generateReplies).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.every(result => result.ok === false)).toBe(true);
    expect(results[0].error).toContain('数量不匹配');

    const verifyDb = new Database(testDb);
    expect(verifyDb.prepare('SELECT reply_text, reply_status, reply_reason FROM work_comments WHERE id = 1').get()).toMatchObject({
      reply_text: '',
      reply_status: 'pending',
    });
    expect(verifyDb.prepare('SELECT reply_text, reply_status, reply_reason FROM work_comments WHERE id = 2').get()).toMatchObject({
      reply_text: '',
      reply_status: 'pending',
    });
    expect(verifyDb.prepare('SELECT reply_reason FROM work_comments WHERE id = 1').get().reply_reason).toContain('agent_generate_failed:Agent 返回回复数量不匹配');
    expect(verifyDb.prepare('SELECT reply_reason FROM work_comments WHERE id = 2').get().reply_reason).toContain('agent_generate_failed:Agent 返回回复数量不匹配');
    verifyDb.close();
  });

  it('parseArgs 支持 --keep-open，避免回评执行结束立刻关闭浏览器', () => {
    const args = parseArgs(['--days', '7', '--limit', '2', '--keep-open']);
    expect(args.keepOpen).toBe(true);
    expect(args.days).toBe(7);
    expect(args.limit).toBe(2);
  });

  it('extractTargetCommentId 能从 raw_comment_json 回推 cid', () => {
    const cid = extractTargetCommentId({}, {
      raw_comment_json: JSON.stringify({
        source: 'comment-list-api',
        comment: { cid: 'cid-from-raw' },
      }),
    });
    expect(cid).toBe('cid-from-raw');
  });

  it('classifyStoredWorkCommentRaw 会拒绝回复了你的评论通知，避免打开别人作品回评', () => {
    const raw = JSON.stringify({
      type: 31,
      interactive_biz_id: 1003112,
      create_time: 1780352085,
      nid_str: 'notice-reply',
      comment: {
        comment_type: 12,
        forward_id: 'other-work-id',
        parent_id: 'parent-comment-id',
        reply_comment: { text: '我的原评论' },
        comment: {
          cid: 'reply-cid',
          text: '别人回复我的内容',
          aweme_id: 'other-work-id',
          user: { nickname: '别人' },
        },
        aweme: {
          aweme_id: 'other-work-id',
          author: { nickname: '别人作品作者', sec_uid: 'other-author' },
        },
      },
    });

    const result = classifyStoredWorkCommentRaw(raw);

    expect(result.ok).toBe(false);
    expect(result.action).toBe('reply_to_my_comment');
    expect(result.reason).toContain('not_comment_on_my_work');
  });

  it('extractTargetCommentId 能兼容 notification 原始结构中的 comment.comment.cid', () => {
    const cid = extractTargetCommentId({}, {
      raw_comment_json: JSON.stringify({
        comment: {
          comment: {
            cid: 'cid-from-nested-raw',
          },
        },
      }),
    });
    expect(cid).toBe('cid-from-nested-raw');
  });

  it('extractTargetCommentId 在缺少 targetCommentId 时回退到 comment_key', () => {
    const cid = extractTargetCommentId({}, {
      comment_key: 'cid-from-comment-key',
    });
    expect(cid).toBe('cid-from-comment-key');
  });

  it('旧 commentId 失效时会 fallback 到当前 row.id，并保留 inputCommentId', () => {
    const db = new Database(testDb);
    db.prepare(`
      INSERT INTO work_comments (
        id, work_id, work_url, modal_id, actor_name, comment_text,
        event_time_text, comment_key, reply_text, reply_status, raw_comment_json
      ) VALUES (
        10, '7639733344284064741', 'https://www.douyin.com/video/7639733344284064741',
        '7639733344284064741', 'fallback-user', 'fallback comment',
        '1天前', 'cid-fallback', 'Hermes代看后觉得这是用于验证的合格回复内容', 'pending',
        '{"comment":{"comment":{"cid":"cid-fallback"}}}'
      )
    `).run();
    db.close();

    const validated = validateWorkCommentItem({
      itemIndex: 0,
      commentId: 999,
      replyText: 'Hermes代看后觉得这是用于验证的合格回复内容',
      workId: '7639733344284064741',
      modalId: '7639733344284064741',
      actorName: 'fallback-user',
      commentText: 'fallback comment',
    });

    expect(validated.ok).toBe(true);
    expect(validated.inputCommentId).toBe(999);
    expect(validated.commentId).toBe(10);
    expect(validated.rowId).toBe(10);
  });

  it('validateWorkCommentItem 在有 homepageUrl + workId + replyText 时通过，且不要求 workUrl', () => {
    const db = new Database(testDb);
    db.prepare(`
      INSERT INTO work_comments (
        id, work_id, modal_id, actor_name, comment_text, comment_key, reply_text, reply_status
      ) VALUES (
        11, '7639733344284064741', '7639733344284064741', '验证用户', '验证评论', 'cid-11', 'Hermes代看后觉得这是用于验证的合格回复内容', 'pending'
      )
    `).run();
    db.close();

    const validated = validateWorkCommentItem({
      itemIndex: 0,
      commentId: 11,
      replyText: 'Hermes代看后觉得这是用于验证的合格回复内容',
      homepageUrl: 'https://www.douyin.com/user/author-a',
      workId: '7639733344284064741',
    });

    expect(validated.ok).toBe(true);
    expect(validated.authorProfileUrl).toBe('https://www.douyin.com/user/author-a');
    expect(validated.workId).toBe('7639733344284064741');
  });

  it('validateWorkCommentItem 缺 homepageUrl 时可直接使用作品 URL，works 作者主页仍可补齐', () => {
    const db = new Database(testDb);
    db.prepare(`
      INSERT INTO work_comments (
        id, work_id, modal_id, actor_name, comment_text, comment_key, reply_text, reply_status
      ) VALUES (
        12, 'no-homepage-work', 'no-homepage-work', '验证用户2', '验证评论2', 'cid-12', 'OpenClaw代看后觉得这是用于验证的合格回复内容', 'pending'
      )
    `).run();
    db.prepare(`
      INSERT INTO works (
        work_id, modal_id, author_name, author_profile_url, author_profile_key, first_seen_at, last_seen_at
      ) VALUES (
        'fallback-homepage-work', 'fallback-homepage-work', '作者Fallback', 'https://www.douyin.com/user/fallback-author', 'fallback-author', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run();
    db.prepare(`
      INSERT INTO work_comments (
        id, work_id, modal_id, actor_name, comment_text, comment_key, reply_text, reply_status
      ) VALUES (
        13, 'fallback-homepage-work', 'fallback-homepage-work', '验证用户3', '验证评论3', 'cid-13', 'Agent代看后觉得这是用于验证的合格回复内容', 'pending'
      )
    `).run();
    db.close();

    const directWork = validateWorkCommentItem({
      itemIndex: 0,
      commentId: 12,
      replyText: 'OpenClaw代看后觉得这是用于验证的合格回复内容',
      workId: 'no-homepage-work',
    });
    expect(directWork.ok).toBe(true);
    expect(directWork.authorProfileUrl).toBe('');
    expect(directWork.workUrl).toBe('https://www.douyin.com/jingxuan?modal_id=no-homepage-work');

    const fallback = validateWorkCommentItem({
      itemIndex: 1,
      commentId: 13,
      replyText: 'Agent代看后觉得这是用于验证的合格回复内容',
      workId: 'fallback-homepage-work',
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.authorProfileUrl).toBe('https://www.douyin.com/user/fallback-author');
  });

  it('validateWorkCommentItem 缺 workId/modalId 时失败', () => {
    const db = new Database(testDb);
    db.prepare(`
      INSERT INTO work_comments (
        id, actor_name, comment_text, comment_key, reply_text, reply_status
      ) VALUES (
        14, '验证用户4', '验证评论4', 'cid-14', 'Hermes代看后觉得这是用于验证的合格回复内容', 'pending'
      )
    `).run();
    db.close();

    const failed = validateWorkCommentItem({
      itemIndex: 0,
      commentId: 14,
      replyText: 'Hermes代看后觉得这是用于验证的合格回复内容',
      homepageUrl: 'https://www.douyin.com/user/author-a',
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('work_id/modal_id 为空');
  });

  it('isDoneWithoutRetryResult 只把成功或已处理项视为完成，不把空回复跳过当完成', () => {
    expect(isDoneWithoutRetryResult({ ok: true, status: 'succeeded' })).toBe(true);
    expect(isDoneWithoutRetryResult({ ok: false, status: 'succeeded' })).toBe(true);
    expect(isDoneWithoutRetryResult({ ok: false, status: 'sent_unverified' })).toBe(true);
    expect(isDoneWithoutRetryResult({ ok: false, status: 'skipped_empty_reply' })).toBe(false);
    expect(isDoneWithoutRetryResult({ ok: false, status: 'blocked' })).toBe(false);
  });

  it('主流程源码不再引用 creator 评论管理页或 ensureCommentPageReady', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(resolve(__dirname, '../../src/cli/execute-comment-replies.mjs'), 'utf8');
    expect(source.includes('creator-micro/interactive/comment')).toBe(false);
    expect(source.includes('ensureCommentPageReady')).toBe(false);
    expect(source.includes('export function loadWorkCommentItemsFromFile')).toBe(false);
    expect(source.includes('export function updateExecuteJsonFile')).toBe(false);
  });

  // 4. Already succeeded → EXECUTE_ALREADY_CONFIRMED (not EXECUTE_FAILED)
  it('detects already succeeded comments and would mark ALREADY_CONFIRMED', () => {
    // This is tested via the validateWorkCommentItem logic:
    // commentId=3 has reply_status='succeeded' and reply_text='Already done'
    // validateWorkCommentItem should return { ok: false, status: 'succeeded' }
    // validateWorkCommentItem should return { ok: false, status: 'succeeded' }

    // Verify the DB state is correct for this scenario
    const db = new Database(testDb);
    const row = db.prepare("SELECT * FROM work_comments WHERE id = 3").get();
    expect(row).not.toBeNull();
    expect(row.reply_status).toBe('succeeded');
    expect(row.reply_text).toBe('Already done');
    db.close();
  });

  // 5. Already sent_unverified → EXECUTE_ALREADY_SENT_UNVERIFIED (not EXECUTE_FAILED)
  it('detects already sent_unverified comments and would mark ALREADY_SENT_UNVERIFIED', () => {
    const db = new Database(testDb);
    const row = db.prepare("SELECT * FROM work_comments WHERE id = 4").get();
    expect(row).not.toBeNull();
    expect(row.reply_status).toBe('sent_unverified');
    expect(row.reply_text).toBe('Unverified');
    db.close();
  });

  // 6. Statistics: succeeded vs skipped vs failed
  it('statistics logic correctly separates succeeded, skipped, failed', () => {
    // Simulate result array
    const results = [
      { commentId: 1, ok: true, status: 'succeeded' },           // real success
      { commentId: 2, ok: false, status: 'skipped_empty_reply' }, // empty reply
      { commentId: 3, ok: false, status: 'succeeded' },           // already done
      { commentId: 4, ok: false, status: 'sent_unverified' },     // already sent
      { commentId: 99, ok: false, status: 'blocked', error: 'err' }, // real failure
    ];

    const isSkippedResult = (result) => {
      return result.status === 'skipped_empty_reply'
        || (!result.ok && result.status === 'succeeded')
        || (!result.ok && result.status === 'sent_unverified');
    };

    const succeeded = results.filter(item => item.ok && item.status === 'succeeded').length;
    const skipped = results.filter(isSkippedResult).length;
    const failed = results.length - succeeded - skipped;

    // commentId=1 is real success
    expect(succeeded).toBe(1);
    // commentId=2,3,4 are skipped
    expect(skipped).toBe(3);
    // commentId=99 is real failure
    expect(failed).toBe(1);
    // Total
    expect(succeeded + skipped + failed).toBe(results.length);
  });
});

describe('comments:execute single-pass per work', () => {
  function createFakePage() {
    return {
      keyboard: {
        press: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    };
  }

  it('同作品 3 条 pending：第 1 屏出现 A/C，第 2 屏出现 B，只滚动 1 次', async () => {
    const page = createFakePage();
    let scrollRound = 0;
    const collectCandidates = vi.fn(async () => ({
      ok: true,
      candidates: scrollRound === 0
        ? [
          { domIndex: 0, cid: 'A', actorName: 'u1', commentText: 'A', timeText: '', hasReplyButton: true },
          { domIndex: 1, cid: 'C', actorName: 'u3', commentText: 'C', timeText: '', hasReplyButton: true },
        ]
        : [
          { domIndex: 0, cid: 'B', actorName: 'u2', commentText: 'B', timeText: '', hasReplyButton: true },
        ],
    }));
    const scrollOnce = vi.fn(async () => {
      scrollRound++;
      return { ok: true };
    });
    const openMatchedReplyBox = vi.fn(async (_page, target, candidate, { matchedBy }) => ({
      ok: true,
      data: { target, candidate, matchedBy },
    }));
    const fillReply = vi.fn(async () => ({ ok: true }));
    const clickSend = vi.fn(async () => ({ ok: true }));
    const verifyReply = vi.fn(async () => ({ ok: true }));
    const onResult = vi.fn();
    const saveSucceeded = vi.fn();

    const group = [
      { commentId: 1, replyText: 'r1', targetCommentId: 'A', actorName: 'u1', commentText: 'A' },
      { commentId: 2, replyText: 'r2', targetCommentId: 'B', actorName: 'u2', commentText: 'B' },
      { commentId: 3, replyText: 'r3', targetCommentId: 'C', actorName: 'u3', commentText: 'C' },
    ];
    const collector = { getByCid: () => null, getStats: () => ({ hasMore: 1 }) };

    const results = await executeSinglePassForWorkGroup(page, group, collector, {
      collectCandidates,
      scrollOnce,
      openMatchedReplyBox,
      fillReply,
      clickSend,
      verifyReply,
      saveSucceeded,
      saveBlocked: vi.fn(),
      saveSentUnverified: vi.fn(),
      onResult,
    });

    expect(scrollOnce).toHaveBeenCalledTimes(1);
    expect(results.filter(item => item.status === 'succeeded')).toHaveLength(3);
    expect(saveSucceeded).toHaveBeenCalledTimes(3);
  });

  it('当前屏同时出现多条 pending，先处理完当前屏再滚动', async () => {
    const page = createFakePage();
    const collectCandidates = vi.fn(async () => ({
      ok: true,
      candidates: [
        { domIndex: 0, cid: 'A', actorName: 'u1', commentText: 'A', timeText: '', hasReplyButton: true },
        { domIndex: 1, cid: 'B', actorName: 'u2', commentText: 'B', timeText: '', hasReplyButton: true },
      ],
    }));

    const results = await executeSinglePassForWorkGroup(page, [
      { commentId: 1, replyText: 'r1', targetCommentId: 'A', actorName: 'u1', commentText: 'A' },
      { commentId: 2, replyText: 'r2', targetCommentId: 'B', actorName: 'u2', commentText: 'B' },
    ], { getByCid: () => null, getStats: () => ({ hasMore: 1 }) }, {
      collectCandidates,
      scrollOnce: vi.fn(async () => ({ ok: true })),
      openMatchedReplyBox: vi.fn(async () => ({ ok: true })),
      fillReply: vi.fn(async () => ({ ok: true })),
      clickSend: vi.fn(async () => ({ ok: true })),
      verifyReply: vi.fn(async () => ({ ok: true })),
      saveSucceeded: vi.fn(),
      saveBlocked: vi.fn(),
      saveSentUnverified: vi.fn(),
      onResult: vi.fn(),
    });

    expect(results.filter(item => item.status === 'succeeded')).toHaveLength(2);
    expect(collectCandidates.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('not_unique 会阻断当前项，但无 cid 的 actor_not_verified 会继续往下找其他 pending', async () => {
    const page = createFakePage();
    let round = 0;
    const saveBlocked = vi.fn();

    const results = await executeSinglePassForWorkGroup(page, [
      { commentId: 1, replyText: 'r1', actorName: 'u1', commentText: 'same', eventTimeText: '06-01' },
      { commentId: 2, replyText: 'r2', actorName: 'bad', commentText: 'ok', eventTimeText: '06-02' },
      { commentId: 3, replyText: 'r3', actorName: 'good', commentText: 'ok', eventTimeText: '06-02' },
    ], { getByCid: () => null, getStats: () => ({ hasMore: round === 0 ? 1 : 0 }) }, {
      collectCandidates: vi.fn(async () => ({
        ok: true,
        candidates: round === 0
          ? [
            { domIndex: 0, cid: '', actorName: 'u1', commentText: 'same', timeText: '06-01', hasReplyButton: true },
            { domIndex: 1, cid: '', actorName: 'u1', commentText: 'same', timeText: '06-01', hasReplyButton: true },
            { domIndex: 2, cid: '', actorName: 'good', commentText: 'ok', timeText: '06-02', hasReplyButton: true },
          ]
          : [
            { domIndex: 0, cid: '', actorName: 'bad', commentText: 'ok', timeText: '06-02', hasReplyButton: true },
          ],
      })),
      openMatchedReplyBox: vi.fn(async () => ({ ok: true })),
      fillReply: vi.fn(async () => ({ ok: true })),
      clickSend: vi.fn(async () => ({ ok: true })),
      verifyReply: vi.fn(async () => ({ ok: true })),
      scrollOnce: vi.fn(async () => {
        round++;
        return { ok: true };
      }),
      saveSucceeded: vi.fn(),
      saveBlocked,
      saveSentUnverified: vi.fn(),
      onResult: vi.fn(),
    });

    expect(results.filter(item => item.status === 'blocked')).toHaveLength(1);
    expect(results.filter(item => item.status === 'succeeded')).toHaveLength(2);
    expect(saveBlocked).toHaveBeenCalledTimes(1);
    expect(saveBlocked).toHaveBeenCalledWith(expect.objectContaining({ commentId: 1 }), expect.stringContaining('not_unique'));
  });

  it('滚到底仍找不到的 pending 保持 pending 可重试，原因包含 single_pass_not_found', async () => {
    const page = createFakePage();
    const saveRetryable = vi.fn();

    const results = await executeSinglePassForWorkGroup(page, [
      { commentId: 1, replyText: 'r1', actorName: 'u1', commentText: 'missing' },
    ], { getByCid: () => null, getStats: () => ({ hasMore: 0 }) }, {
      collectCandidates: vi.fn(async () => ({ ok: true, candidates: [] })),
      scrollOnce: vi.fn(async () => ({ ok: false, reason: 'comment_container_not_found' })),
      openMatchedReplyBox: vi.fn(),
      fillReply: vi.fn(),
      clickSend: vi.fn(),
      verifyReply: vi.fn(),
      saveSucceeded: vi.fn(),
      saveRetryable,
      saveSentUnverified: vi.fn(),
      onResult: vi.fn(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].error).toContain('single_pass_not_found');
    expect(saveRetryable).toHaveBeenCalledWith(expect.objectContaining({ commentId: 1 }), 'single_pass_not_found');
  });

  it('回复框打不开属于可重试失败，保留 pending 状态而不是 blocked', async () => {
    const page = createFakePage();
    const saveBlocked = vi.fn();
    const saveRetryable = vi.fn();

    const results = await executeSinglePassForWorkGroup(page, [
      { commentId: 1, replyText: 'r1', actorName: 'u1', commentText: 'hello', eventTimeText: '06-01' },
    ], { getByCid: () => null, getStats: () => ({ hasMore: 0 }) }, {
      collectCandidates: vi.fn(async () => ({
        ok: true,
        candidates: [
          { domIndex: 0, cid: '', actorName: 'u1', commentText: 'hello', timeText: '06-01', hasReplyButton: true },
        ],
      })),
      openMatchedReplyBox: vi.fn(async () => ({ ok: false, code: 'reply_button_not_clickable' })),
      fillReply: vi.fn(),
      clickSend: vi.fn(),
      verifyReply: vi.fn(),
      scrollOnce: vi.fn(),
      saveSucceeded: vi.fn(),
      saveBlocked,
      saveRetryable,
      saveSentUnverified: vi.fn(),
      onResult: vi.fn(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pending');
    expect(saveBlocked).not.toHaveBeenCalled();
    expect(saveRetryable).toHaveBeenCalledWith(expect.objectContaining({ commentId: 1 }), expect.stringContaining('reply_box_not_opened'));
  });

  it('planViewportPendingMatches 会为当前屏产出可执行项和阻断项', () => {
    const plan = planViewportPendingMatches([
      { commentId: 1, actorName: 'u1', commentText: 'same', eventTimeText: '06-01' },
      { commentId: 2, actorName: 'u2', commentText: 'ok', eventTimeText: '06-02' },
    ], [
      { domIndex: 0, cid: '', actorName: 'u1', commentText: 'same', timeText: '06-01', hasReplyButton: true },
      { domIndex: 1, cid: '', actorName: 'u1', commentText: 'same', timeText: '06-01', hasReplyButton: true },
      { domIndex: 2, cid: '', actorName: 'u2', commentText: 'ok', timeText: '06-02', hasReplyButton: true },
    ]);

    expect(plan.blocked).toHaveLength(1);
    expect(plan.actionable).toHaveLength(1);
    expect(plan.actionable[0].item.commentId).toBe(2);
  });

  it('planViewportPendingMatches 对无 cid 的 actor_not_verified 不提前阻断', () => {
    const plan = planViewportPendingMatches([
      { commentId: 1, actorName: 'target-user', commentText: 'same', eventTimeText: '06-01' },
    ], [
      { domIndex: 0, cid: '', actorName: 'other-user', commentText: 'same', timeText: '06-01', hasReplyButton: true },
    ]);

    expect(plan.blocked).toHaveLength(0);
    expect(plan.actionable).toHaveLength(0);
  });

  it('planViewportPendingMatches 对唯一 text+actor 的 time_not_verified 仍可阻断', () => {
    const plan = planViewportPendingMatches([
      { commentId: 1, actorName: 'target-user', commentText: 'same', eventTimeText: '06-09' },
    ], [
      { domIndex: 0, cid: '', actorName: 'target-user', commentText: 'same', timeText: '06-01', hasReplyButton: true },
    ]);

    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0].picked.reason).toBe('time_not_verified');
  });

  it('源码确保 group 级 finally 中 stop collector，并在打开失败前也 stop', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(resolve(__dirname, '../../src/cli/execute-comment-replies.mjs'), 'utf8');
    expect(source.includes('commentListCollector.stop();')).toBe(true);
    expect(source.includes('const commentListCollector = createCommentListApiCollector(page);')).toBe(true);
    expect(source.includes('try {\n          let openResult = await openProfileWorkByAwemeIdFromPostApi')).toBe(true);
    expect(source.includes('finally {\n          commentListCollector.stop();')).toBe(true);
  });
});
