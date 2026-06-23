import { describe, it, expect, vi } from 'vitest';
import { findNotificationBell, moveMouseIntoPanel, resolveNotificationCategoryOption, scrollPanelDown, selectNotificationCategory } from '../../src/adapters/notification-page.mjs';

function createPage({ panelBox = null } = {}) {
  return {
    mouse: {
      move: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      wheel: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => panelBox),
  };
}

function createLocator(count) {
  return {
    first() { return this; },
    count: vi.fn(async () => count),
  };
}

describe('notification-page scroll integration', () => {
  it('resolveNotificationCategoryOption maps scan type to panel menu label', () => {
    expect(resolveNotificationCategoryOption('all')).toMatchObject({
      label: '全部消息',
      shouldSelect: false,
    });
    expect(resolveNotificationCategoryOption('comment')).toMatchObject({
      label: '评论',
      shouldSelect: true,
    });
    expect(resolveNotificationCategoryOption('like')).toMatchObject({
      label: '赞',
      shouldSelect: true,
    });
    expect(resolveNotificationCategoryOption('reply')).toBeNull();
  });

  it('selectNotificationCategory clicks trigger then requested menu option by coordinates', async () => {
    const page = createPage();
    page.evaluate = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        trigger: { x: 300, y: 92, text: '全部消息' },
        panelRect: { left: 40, top: 64, right: 380, bottom: 520, width: 340, height: 456 },
      })
      .mockResolvedValueOnce({
        ok: true,
        option: { x: 294, y: 292, text: '评论' },
      });

    const result = await selectNotificationCategory(page, 'comment');

    expect(result).toMatchObject({ ok: true, selected: true, label: '评论' });
    expect(page.mouse.click).toHaveBeenNthCalledWith(1, 300, 92);
    expect(page.mouse.click).toHaveBeenNthCalledWith(2, 294, 292);
  });

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

  it('findNotificationBell 优先使用 data-e2e 语义选择器', async () => {
    const hit = createLocator(1);
    const miss = createLocator(0);
    const page = {
      locator: vi.fn((selector) => {
        if (selector === '[data-e2e="something-button"]:has-text("通知")') return hit;
        return miss;
      }),
    };

    const result = await findNotificationBell(page);

    expect(result).toBeTruthy();
    expect(result.selector).toBe('[data-e2e="something-button"]:has-text("通知")');
    expect(result.locator).toBe(hit);
  });

  it('findNotificationBell 在语义选择器缺失时回退到旧 svg 类名', async () => {
    const hit = createLocator(1);
    const miss = createLocator(0);
    const page = {
      locator: vi.fn((selector) => {
        if (selector === 'svg.LtuRRess') return hit;
        return miss;
      }),
    };

    const result = await findNotificationBell(page);

    expect(result).toBeTruthy();
    expect(result.selector).toBe('svg.LtuRRess');
    expect(result.locator).toBe(hit);
  });
});
