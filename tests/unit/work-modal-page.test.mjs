import { describe, it, expect, vi } from 'vitest';
import {
  buildWorkReplyTarget,
  extractModalIdFromUrl,
  fillWorkReplyText,
  parseDouyinTimeText,
  pickWorkCommentCandidate,
  postWorkModalComment,
  resolveReplyTypingOptions,
  scrollCommentAreaOnce,
  typeReplyTextWithEffect,
} from '../../src/adapters/work-modal-page.mjs';
import { checkWorkOwner } from '../../src/adapters/work-context-page.mjs';

describe('extractModalIdFromUrl', () => {
  it('从 URL 提取 modal_id', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=7643770606596888954')).toBe('7643770606596888954');
  });

  it('modal_id 在中间', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=123&foo=bar')).toBe('123');
  });

  it('无 modal_id 返回 null', () => {
    expect(extractModalIdFromUrl('https://www.douyin.com/user/self')).toBeNull();
  });

  it('空 URL 返回 null', () => {
    expect(extractModalIdFromUrl('')).toBeNull();
    expect(extractModalIdFromUrl(null)).toBeNull();
  });

  it('modal_id 作为 workId', () => {
    const modalId = extractModalIdFromUrl('https://www.douyin.com/user/self?modal_id=7643770606596888954');
    expect(modalId).toBe('7643770606596888954');
    const workId = modalId;
    expect(workId).toBe('7643770606596888954');
  });
});

describe('replyText 前缀匹配逻辑', () => {
  it('完整匹配', () => {
    const replyText = '感谢支持，一起交流。';
    const pageText = '感谢支持，一起交流。';
    expect(pageText.includes(replyText)).toBe(true);
  });

  it('前20字符前缀匹配', () => {
    const replyText = '这个问题挺关键，后面我可以单独展开讲一下。';
    const prefix = replyText.slice(0, 20);
    const pageText = '这个问题挺关键，后面我可以单独展开讲一下。';
    expect(prefix.length).toBe(20);
    expect(pageText.includes(prefix)).toBe(true);
  });

  it('前缀至少5字符才匹配', () => {
    const replyText = '感谢';
    const prefix = replyText.slice(0, 20);
    expect(prefix.length).toBeLessThan(5);
    const shouldUsePrefix = prefix.length >= 5;
    expect(shouldUsePrefix).toBe(false);
  });
});

describe('回复输入打字效果', () => {
  it('默认逐字 insertText 并等待短暂停顿', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const page = {
      keyboard: { insertText: vi.fn(async () => {}) },
      waitForTimeout: vi.fn(async () => {}),
    };

    try {
      const result = await typeReplyTextWithEffect(page, '谢谢支持', { enabled: true, delayMs: 10, jitterMs: 0 });
      expect(result.method).toBe('keyboard_type_effect');
      expect(page.keyboard.insertText).toHaveBeenCalledTimes(4);
      expect(page.keyboard.insertText.mock.calls.map(([text]) => text)).toEqual(['谢', '谢', '支', '持']);
      expect(page.waitForTimeout).toHaveBeenCalledTimes(4);
      expect(page.waitForTimeout).toHaveBeenCalledWith(10);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('可通过环境变量关闭打字效果', async () => {
    const page = {
      keyboard: { insertText: vi.fn(async () => {}) },
      waitForTimeout: vi.fn(async () => {}),
    };

    const options = resolveReplyTypingOptions({ LISHANGWANGLAI_REPLY_TYPING: '0' });
    const result = await typeReplyTextWithEffect(page, '一次填入', options);

    expect(result.method).toBe('keyboard_insert_text');
    expect(page.keyboard.insertText).toHaveBeenCalledTimes(1);
    expect(page.keyboard.insertText).toHaveBeenCalledWith('一次填入');
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('fillWorkReplyText 使用单对象参数调用 evaluate，兼容 Playwright', async () => {
    const originalTyping = process.env.LISHANGWANGLAI_REPLY_TYPING;
    process.env.LISHANGWANGLAI_REPLY_TYPING = '0';

    const page = {
      evaluate: vi.fn(async function(fn, arg) {
        expect(arguments.length).toBeLessThanOrEqual(2);
        if (arg?.text && arg?.method) {
          expect(arg).toEqual({ text: '收到啦', method: 'keyboard_insert_text' });
          return { ok: true, method: arg.method, sendButtonVisible: true };
        }
        return { ok: true };
      }),
      locator: vi.fn(() => ({
        last: () => ({
          waitFor: vi.fn(async () => {}),
          click: vi.fn(async () => {}),
        }),
      })),
      keyboard: {
        press: vi.fn(async () => {}),
        insertText: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    };

    try {
      const result = await fillWorkReplyText(page, '收到啦');
      expect(result.ok).toBe(true);
      expect(result.data.method).toBe('keyboard_insert_text');
      expect(page.keyboard.insertText).toHaveBeenCalledWith('收到啦');
    } finally {
      if (originalTyping === undefined) delete process.env.LISHANGWANGLAI_REPLY_TYPING;
      else process.env.LISHANGWANGLAI_REPLY_TYPING = originalTyping;
    }
  });

  it('postWorkModalComment 输入框清空时按页面已接受发送处理', async () => {
    const originalTyping = process.env.LISHANGWANGLAI_REPLY_TYPING;
    process.env.LISHANGWANGLAI_REPLY_TYPING = '0';

    let phase = 'prepare';
    const page = {
      evaluate: vi.fn(async (fn, arg) => {
        if (arg?.text && arg?.method) {
          phase = 'filled';
          return { ok: true, method: arg.method, sendButtonVisible: true };
        }
        if (arg?.replyNeedle && arg?.replyPrefix) {
          return { visible: false, inputCleared: true, commentPreview: '' };
        }
        return { ok: true, phase };
      }),
      locator: vi.fn(() => ({
        last: () => ({
          waitFor: vi.fn(async () => {}),
          click: vi.fn(async () => {}),
        }),
      })),
      keyboard: {
        press: vi.fn(async () => {}),
        insertText: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    };

    try {
      const result = await postWorkModalComment(page, '程序员快乐时刻：脚本跑通了');
      expect(result.ok).toBe(true);
      expect(result.data.unconfirmed).toBe(false);
      expect(result.data.verified).toBe(true);
      expect(result.data.method).toBe('editor_cleared_after_send');
    } finally {
      if (originalTyping === undefined) delete process.env.LISHANGWANGLAI_REPLY_TYPING;
      else process.env.LISHANGWANGLAI_REPLY_TYPING = originalTyping;
    }
  });
});

describe('parseDouyinTimeText', () => {
  it('支持 昨天00:11', () => {
    const iso = parseDouyinTimeText('昨天00:11');
    expect(iso).toBeTruthy();
    const date = new Date(iso);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(11);
  });

  it('支持 1小时前', () => {
    const iso = parseDouyinTimeText('1小时前');
    expect(iso).toBeTruthy();
  });

  it('支持 10分钟前', () => {
    const iso = parseDouyinTimeText('10分钟前');
    expect(iso).toBeTruthy();
  });

  it('支持 刚刚', () => {
    const iso = parseDouyinTimeText('刚刚');
    expect(iso).toBeTruthy();
  });

  it('支持 星期日，并按最近一次该周几回推', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00+08:00'));
    try {
      const iso = parseDouyinTimeText('星期日');
      expect(iso).toBeTruthy();
      const date = new Date(iso);
      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth() + 1).toBe(5);
      expect(date.getDate()).toBe(31);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ownerCheck 分支', () => {
  it('high: profileKey 匹配', () => {
    const self = { profileKey: 'MY_KEY', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'MY_KEY', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('high: profileUrl 匹配', () => {
    const self = { profileKey: '', profileUrl: 'https://www.douyin.com/user/MY_KEY', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '//www.douyin.com/user/MY_KEY', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('medium: authorName 匹配', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '我的昵称' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '我的昵称' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckConfidence).toBe('medium');
  });

  it('null: 无 self 配置', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'some', authorProfileUrl: 'some', authorName: 'some' }, self);
    expect(result.isOwnWork).toBeNull();
    expect(result.ownerCheckConfidence).toBe('low');
  });

  it('false: profileKey 不匹配', () => {
    const self = { profileKey: 'MY_KEY', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'OTHER_KEY', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(false);
    expect(result.ownerCheckConfidence).toBe('high');
  });
});

describe('作品评论区回复定位', () => {
  it('buildWorkReplyTarget 优先合并 cid 与 API 评论信息', () => {
    const target = buildWorkReplyTarget(
      { actor_name: '张三', comment_text: '求更新', event_time_text: '06-01', cid: 'c1' },
      { actorName: '张三', commentText: '求更新' }
    );

    expect(target.targetCommentId).toBe('c1');
    expect(target.actorName).toBe('张三');
    expect(target.commentText).toBe('求更新');
  });

  it('pickWorkCommentCandidate 优先按 cid 精确命中', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: 'c1', actorName: '张三', commentText: 'A', timeText: '', hasReplyButton: true },
      { domIndex: 1, cid: 'c2', actorName: '李四', commentText: 'B', timeText: '', hasReplyButton: true },
    ], {
      targetCommentId: 'c2',
      actorName: '李四',
      commentText: 'B',
    });

    expect(result.ok).toBe(true);
    expect(result.candidate.domIndex).toBe(1);
    expect(result.matchedBy).toBe('cid');
  });

  it('pickWorkCommentCandidate 多候选时阻断', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: '', actorName: '张三', commentText: '求更新', timeText: '06-01', hasReplyButton: true },
      { domIndex: 1, cid: '', actorName: '张三', commentText: '求更新', timeText: '06-01', hasReplyButton: true },
    ], {
      actorName: '张三',
      commentText: '求更新',
      eventTimeText: '06-01',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_unique');
  });

  it('pickWorkCommentCandidate actor 不匹配时阻断', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: '', actorName: '李四', commentText: '求更新', timeText: '06-01', hasReplyButton: true },
    ], {
      actorName: '张三',
      commentText: '求更新',
      eventTimeText: '06-01',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('actor_not_verified');
  });

  it('pickWorkCommentCandidate 对 epoch eventTimeText 不强制做 DOM 时间校验', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: '', actorName: '北漂全栈猿（来回）', commentText: '111', timeText: '1天前·北京', hasReplyButton: true },
    ], {
      actorName: '北漂全栈猿（来回）',
      commentText: '111',
      eventTimeText: '1780399462',
    });

    expect(result.ok).toBe(true);
    expect(result.candidate.domIndex).toBe(0);
    expect(result.matchedBy).toBe('actor+text');
  });

  it('pickWorkCommentCandidate 短文本必须精确匹配，2222 不误命中 22222', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: '', actorName: '北漂全栈猿（来回）', commentText: '22222', timeText: '1周前·北京', hasReplyButton: true },
      { domIndex: 1, cid: '', actorName: '北漂全栈猿（来回）', commentText: '2222', timeText: '5天前·北京', hasReplyButton: true },
    ], {
      actorName: '北漂全栈猿（来回）',
      commentText: '2222',
      eventTimeText: '1780404999',
    });

    expect(result.ok).toBe(true);
    expect(result.candidate.domIndex).toBe(1);
    expect(result.matchedBy).toBe('actor+text');
  });

  it('pickWorkCommentCandidate 长文本仍允许包含匹配', () => {
    const result = pickWorkCommentCandidate([
      { domIndex: 0, cid: '', actorName: '张三', commentText: '这个内容写得很真实，想继续看后续', timeText: '06-01', hasReplyButton: true },
    ], {
      actorName: '张三',
      commentText: '内容写得很真实',
      eventTimeText: '1780404999',
    });

    expect(result.ok).toBe(true);
    expect(result.candidate.domIndex).toBe(0);
    expect(result.matchedBy).toBe('actor+text');
  });

  it('scrollCommentAreaOnce 使用统一 wheel 滚动评论容器', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const page = {
      evaluate: vi.fn(async () => ({
        ok: true,
        count: 1,
        box: { x: 0, y: 0, width: 320, height: 300, selector: '.comment-mainContent' },
      })),
      mouse: {
        move: vi.fn(async () => {}),
        wheel: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    };

    try {
      const result = await scrollCommentAreaOnce(page);
      expect(result.ok).toBe(true);
      const [, deltaY] = page.mouse.wheel.mock.calls[0];
      expect(deltaY).toBeGreaterThanOrEqual(600);
      expect(typeof result.jitter).toBe('number');
    } finally {
      randomSpy.mockRestore();
    }
  });
});
