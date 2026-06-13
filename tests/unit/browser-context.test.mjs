import { describe, expect, it, vi } from 'vitest';
import { replaceContextPage } from '../../src/browser/browser-context.mjs';

describe('browser context page replacement', () => {
  it('creates a fresh page and closes the previous one', async () => {
    const previousPage = {
      isClosed: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const nextPage = { marker: 'next-page' };
    const context = {
      newPage: vi.fn().mockResolvedValue(nextPage),
    };

    const result = await replaceContextPage(context, previousPage);

    expect(result).toBe(nextPage);
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(previousPage.close).toHaveBeenCalledTimes(1);
  });

  it('does not try to close an already-closed page', async () => {
    const previousPage = {
      isClosed: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const nextPage = { marker: 'next-page' };
    const context = {
      newPage: vi.fn().mockResolvedValue(nextPage),
    };

    const result = await replaceContextPage(context, previousPage);

    expect(result).toBe(nextPage);
    expect(previousPage.close).not.toHaveBeenCalled();
  });
});
