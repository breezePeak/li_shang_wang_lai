import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { resolve } from 'path';
import { detectWorkPresentationKind, waitForInteractionWatchGate } from '../../src/services/return-visit-executor.mjs';

describe('return-visit executor work presentation detection', () => {
  it('modal_id 图文页会被识别为 note-like 页面', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/jingxuan?modal_id=7636032429409601465'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: false }),
    };

    const result = await detectWorkPresentationKind(page, { awemeType: 68 });
    expect(result.isModalPage).toBe(true);
    expect(result.isNotePage).toBe(true);
    expect(result.hasVideoElement).toBe(false);
  });

  it('modal_id 视频页有 video 元素时仍按视频处理', async () => {
    const page = {
      url: vi.fn().mockReturnValue('https://www.douyin.com/jingxuan?modal_id=7647191897097693115'),
      evaluate: vi.fn().mockResolvedValue({ hasVideoElement: true }),
    };

    const result = await detectWorkPresentationKind(page, { awemeType: 0 });
    expect(result.isModalPage).toBe(true);
    expect(result.isNotePage).toBe(false);
    expect(result.hasVideoElement).toBe(true);
  });
});

describe('return-visit executor interaction watch gate', () => {
  it('打开作品后先启动 Agent，再等待观看门槛', () => {
    const source = fs.readFileSync(resolve(import.meta.dirname, '../../src/services/return-visit-executor.mjs'), 'utf8');
    const agentStart = source.indexOf('打开作品后立即请求生成评论');
    const watchGate = source.indexOf('等待最短观看门槛');

    expect(agentStart).toBeGreaterThan(0);
    expect(watchGate).toBeGreaterThan(agentStart);
  });

  it('默认只观看 3 秒就进入互动', async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ duration: 120, paused: false, currentTime: 0 })
        .mockResolvedValueOnce(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const waited = await waitForInteractionWatchGate(page);

    expect(waited).toBe(3);
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
  });

  it('full policy only waits the configured interaction gate before continuing', async () => {
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ duration: 120, paused: false, currentTime: 0 })
        .mockResolvedValueOnce(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const waited = await waitForInteractionWatchGate(page, 'full', [3, 3]);

    expect(waited).toBe(3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
  });

  it('skips the interaction gate when no video is present', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const waited = await waitForInteractionWatchGate(page, 'seconds', [5, 5]);

    expect(waited).toBe(0);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });
});
