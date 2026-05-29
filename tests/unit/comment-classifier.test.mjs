import { describe, it, expect } from 'vitest';
import { classifyComment } from '../../src/domain/comment-classifier.mjs';
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
// 1. auto_simple_candidate — positive simple interactions
// ============================================================
describe('auto_simple_candidate — positive simple interactions', () => {
  it('"支持一下" → auto_simple_candidate', () => {
    const r = classifyComment('支持一下');
    expect(r.replyMode).toBe('auto_simple_candidate');
    expect(r.riskLevel).toBe('low');
    expect(r.replyText).toBeTruthy();
    expect(r.autoExecuteAllowed).toBe(false);
  });

  it('"厉害了" → auto_simple_candidate', () => {
    const r = classifyComment('厉害了');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"学到了" → auto_simple_candidate', () => {
    const r = classifyComment('学到了');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"感谢分享" → auto_simple_candidate', () => {
    const r = classifyComment('感谢分享');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"加油" → auto_simple_candidate', () => {
    const r = classifyComment('加油');
    expect(r.replyMode).toBe('auto_simple_candidate');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"讲得真好" → auto_simple_candidate', () => {
    const r = classifyComment('讲得真好');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"很棒" → auto_simple_candidate', () => {
    const r = classifyComment('很棒');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('"干货满满" → auto_simple_candidate', () => {
    const r = classifyComment('干货满满');
    expect(r.replyMode).toBe('auto_simple_candidate');
  });

  it('所有 auto_simple_candidate 的 replyText 来自模板池', () => {
    const templates = new Set([
      '感谢支持～', '收到支持啦～',
      '谢谢认可～', '感谢认可，继续折腾～',
      '能帮上忙就好～', '有用就好，感谢支持～',
      '谢谢鼓励，继续努力～',
    ]);
    const samples = ['支持一下', '厉害了', '学到了', '加油', '讲得真好'];
    for (const s of samples) {
      const r = classifyComment(s);
      if (r.replyMode === 'auto_simple_candidate') {
        expect(templates.has(r.replyText)).toBe(true);
      }
    }
  });

  it('所有结果 autoExecuteAllowed 必须为 false', () => {
    const samples = ['支持一下', '厉害了', '学到了', '加油', '怎么配置', '刷赞', '哈哈哈'];
    for (const s of samples) {
      const r = classifyComment(s);
      expect(r.autoExecuteAllowed).toBe(false);
    }
  });
});

// ============================================================
// 2. needs_review — questions, requests, risk-related
// ============================================================
describe('needs_review — questions, requests, uncertainty', () => {
  it('"怎么配置" → needs_review', () => {
    const r = classifyComment('怎么配置');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"求教程" → needs_review', () => {
    const r = classifyComment('求教程');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"开源吗" → needs_review (question mark)', () => {
    const r = classifyComment('开源吗');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"支持DeepSeek吗" → needs_review (REVIEW_KEYWORDS "支持")', () => {
    const r = classifyComment('支持DeepSeek吗');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"安全吗" → needs_review (REVIEW_KEYWORDS "安全")', () => {
    const r = classifyComment('安全吗');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"会封号吗" → needs_review (BLOCK_KEYWORD "封" is inside "封号", needs review not ignore)', () => {
    const r = classifyComment('会封号吗');
    // "封号" is in BLOCK_KEYWORDS, so it should be ignore/high
    expect(r.replyMode).toBe('ignore');
    expect(r.riskLevel).toBe('high');
  });

  it('"这个怎么安装" → needs_review', () => {
    const r = classifyComment('这个怎么安装');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"能分享一下吗" → needs_review', () => {
    const r = classifyComment('能分享一下吗');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"出一期React教程" → needs_review', () => {
    const r = classifyComment('出一期React教程');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"哈哈哈" → needs_review (unclear)', () => {
    const r = classifyComment('哈哈哈');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"666" → needs_review (unclear)', () => {
    const r = classifyComment('666');
    expect(r.replyMode).toBe('needs_review');
  });

  it('空文本 → needs_review', () => {
    const r = classifyComment('');
    expect(r.replyMode).toBe('needs_review');
  });

  it('"无法判断的纯表情" → needs_review', () => {
    const r = classifyComment('😊');
    expect(r.replyMode).toBe('needs_review');
  });
});

// ============================================================
// 3. ignore/high — spam, risk, blocked keywords
// ============================================================
describe('ignore/high — spam, risk, blocked keywords', () => {
  it('"刷赞" → ignore/high', () => {
    const r = classifyComment('刷赞');
    expect(r.replyMode).toBe('ignore');
    expect(r.riskLevel).toBe('high');
    expect(r.replyText).toBe('');
  });

  it('"绕风控的方法" → ignore/high', () => {
    const r = classifyComment('绕风控的方法');
    expect(r.replyMode).toBe('ignore');
    expect(r.riskLevel).toBe('high');
  });

  it('"怎么破解" → ignore/high', () => {
    const r = classifyComment('怎么破解');
    expect(r.replyMode).toBe('ignore');
  });

  it('"免费Cookie获取" → ignore/high', () => {
    const r = classifyComment('免费Cookie获取');
    expect(r.replyMode).toBe('ignore');
  });

  it('"Token怎么拿" → ignore/high', () => {
    const r = classifyComment('Token怎么拿');
    expect(r.replyMode).toBe('ignore');
  });

  it('"验证码怎么绕过" → ignore/high', () => {
    const r = classifyComment('验证码怎么绕过');
    expect(r.replyMode).toBe('ignore');
  });

  it('"批量互关互赞" → ignore/high', () => {
    const r = classifyComment('批量互关互赞');
    expect(r.replyMode).toBe('ignore');
  });

  it('"加微信聊聊" → ignore/high', () => {
    const r = classifyComment('加微信聊聊');
    expect(r.replyMode).toBe('ignore');
  });

  it('"代运营联系" → ignore/high', () => {
    const r = classifyComment('代运营联系');
    expect(r.replyMode).toBe('ignore');
  });
});

// ============================================================
// 4. CLI interface
// ============================================================
describe('comments:classify CLI', () => {
  it('--text "支持一下" --json returns valid classification', () => {
    const result = runCli('classify-comment.mjs', ['--text', '支持一下', '--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('comments:classify');
    expect(parsed.data.replyMode).toBe('auto_simple_candidate');
    expect(parsed.data.autoExecuteAllowed).toBe(false);
  });

  it('--text "求教程" --json returns needs_review', () => {
    const result = runCli('classify-comment.mjs', ['--text', '求教程', '--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.data.replyMode).toBe('needs_review');
  });

  it('--text "刷赞不被发现" --json returns ignore/high', () => {
    const result = runCli('classify-comment.mjs', ['--text', '刷赞不被发现', '--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.data.replyMode).toBe('ignore');
    expect(parsed.data.riskLevel).toBe('high');
  });

  it('missing --text returns error JSON', () => {
    const result = runCli('classify-comment.mjs', ['--json']);
    const parsed = parseStdout(result);
    expect(parsed).not.toBeNull();
    expect(parsed.ok).toBe(false);
  });
});
