import { describe, it, expect, vi } from 'vitest';
import {
  moveMouseIntoBox,
  wheelInBox,
  findScrollableContainerBox,
  scrollContainerByWheel,
} from '../../src/adapters/scroll-container.mjs';

function createPage({ evaluateResult } = {}) {
  return {
    mouse: {
      move: vi.fn(async () => {}),
      wheel: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => evaluateResult),
  };
}

describe('scroll-container', () => {
  it('moveMouseIntoBox 会移动鼠标到 box 内部', async () => {
    const page = createPage();
    const result = await moveMouseIntoBox(page, { x: 10, y: 20, width: 200, height: 100 });

    expect(result.ok).toBe(true);
    expect(page.mouse.move).toHaveBeenCalledWith(110, 70, { steps: 5 });
  });

  it('wheelInBox 会先移动鼠标再 wheel', async () => {
    const page = createPage();
    await wheelInBox(page, { x: 0, y: 0, width: 100, height: 100 }, { deltaY: 480, waitMs: 50 });

    expect(page.mouse.move).toHaveBeenCalledOnce();
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 480);
    expect(page.waitForTimeout).toHaveBeenLastCalledWith(50);
  });

  it('findScrollableContainerBox 能返回 evaluate 命中的容器', async () => {
    const page = createPage({
      evaluateResult: {
        ok: true,
        count: 1,
        box: { x: 1, y: 2, width: 320, height: 480, selector: '.comment-mainContent' },
      },
    });

    const result = await findScrollableContainerBox(page, {
      selectors: ['.comment-mainContent'],
      requiredText: ['回复'],
    });

    expect(result.ok).toBe(true);
    expect(result.box.selector).toBe('.comment-mainContent');
    expect(page.evaluate).toHaveBeenCalledOnce();
  });

  it('找不到容器时返回 ok=false', async () => {
    const page = createPage({
      evaluateResult: { ok: false, reason: 'container_not_found' },
    });

    const result = await findScrollableContainerBox(page, { selectors: ['.missing'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('container_not_found');
  });

  it('scrollContainerByWheel 找到容器后调用 wheel', async () => {
    const page = createPage({
      evaluateResult: {
        ok: true,
        count: 1,
        box: { x: 5, y: 6, width: 300, height: 260, selector: '.list' },
      },
    });

    const result = await scrollContainerByWheel(page, {
      selectors: ['.list'],
      requiredText: ['回复'],
      deltaY: 600,
    });

    expect(result.ok).toBe(true);
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 600);
  });
});
