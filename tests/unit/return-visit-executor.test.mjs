import { describe, expect, it, vi } from 'vitest';
import { detectWorkPresentationKind } from '../../src/services/return-visit-executor.mjs';

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
