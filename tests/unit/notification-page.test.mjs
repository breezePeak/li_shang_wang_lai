import { describe, it, expect, vi } from 'vitest';
import { moveMouseIntoPanel, scrollPanelDown } from '../../src/adapters/notification-page.mjs';

function createPage({ panelBox = null } = {}) {
  return {
    mouse: {
      move: vi.fn(async () => {}),
      wheel: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => panelBox),
  };
}

describe('notification-page scroll integration', () => {
  it('moveMouseIntoPanel 复用通用 moveMouseIntoBox', async () => {
    const page = createPage();
    const result = await moveMouseIntoPanel(page, { x: 20, y: 40, width: 300, height: 240 });

    expect(result.ok).toBe(true);
    expect(page.mouse.move).toHaveBeenCalledOnce();
    const [x, y] = page.mouse.move.mock.calls[0];
    expect(x).toBe(170);
    expect(y).toBe(120);
  });

  it('scrollPanelDown 仍依赖 getPanelBoundingBox，且使用 wheel', async () => {
    const page = createPage({
      panelBox: { x: 10, y: 20, width: 280, height: 400 },
    });

    const result = await scrollPanelDown(page, { deltaY: 700 });

    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 700);
    expect(result.scrolled).toBe(true);
  });

  it('找不到 panelBox 时返回 scrolled=false', async () => {
    const page = createPage({ panelBox: null });
    const result = await scrollPanelDown(page);

    expect(result.scrolled).toBe(false);
    expect(result.reason).toBe('panel_box_not_found');
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });
});
