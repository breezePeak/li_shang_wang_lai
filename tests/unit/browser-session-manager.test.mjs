import { describe, expect, it, vi } from 'vitest';
import { createBrowserSessionManager } from '../../src/browser/session-manager.mjs';

describe('browser session manager', () => {
  it('opens a session and reuses it until restart', async () => {
    const firstPage = { marker: 'first' };
    const createContext = vi.fn().mockResolvedValue({
      browser: { close: vi.fn().mockResolvedValue(undefined) },
      context: { pages: () => [], newPage: vi.fn() },
    });
    const replacePage = vi.fn().mockResolvedValue(firstPage);

    const manager = createBrowserSessionManager({ createContext, replacePage });

    const a = await manager.open();
    const b = await manager.open();

    expect(a.page).toBe(firstPage);
    expect(b.page).toBe(firstPage);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(replacePage).toHaveBeenCalledTimes(1);
  });

  it('replaces current page within the same context', async () => {
    const browser = { close: vi.fn().mockResolvedValue(undefined) };
    const context = { pages: () => [], newPage: vi.fn() };
    const firstPage = { marker: 'first' };
    const secondPage = { marker: 'second' };
    const createContext = vi.fn().mockResolvedValue({ browser, context });
    const replacePage = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const manager = createBrowserSessionManager({ createContext, replacePage });
    await manager.open();
    const page = await manager.replacePage();

    expect(page).toBe(secondPage);
    expect(replacePage).toHaveBeenNthCalledWith(2, context, firstPage);
  });

  it('restarts by closing current browser and opening a fresh session', async () => {
    const firstBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    const secondBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    const firstPage = { isClosed: vi.fn().mockReturnValue(false), close: vi.fn().mockResolvedValue(undefined) };
    const secondPage = { marker: 'second-page' };
    const firstContext = { pages: () => [], newPage: vi.fn() };
    const secondContext = { pages: () => [], newPage: vi.fn() };
    const createContext = vi.fn()
      .mockResolvedValueOnce({ browser: firstBrowser, context: firstContext })
      .mockResolvedValueOnce({ browser: secondBrowser, context: secondContext });
    const replacePage = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const manager = createBrowserSessionManager({ createContext, replacePage });
    await manager.open();
    const restarted = await manager.restart('test');

    expect(firstPage.close).toHaveBeenCalledTimes(1);
    expect(firstBrowser.close).toHaveBeenCalledTimes(1);
    expect(restarted.browser).toBe(secondBrowser);
    expect(restarted.page).toBe(secondPage);
    expect(createContext).toHaveBeenCalledTimes(2);
  });
});
