import { describe, expect, it, vi } from 'vitest';
import {
  clearPrivateMessages,
  confirmPrivateMessageDeletion,
  findPrivateMessageTrigger,
  openPrivateMessagePanel,
} from '../../src/adapters/message-page.mjs';

function createLocator(count, actions = {}) {
  return {
    first() { return this; },
    count: vi.fn(async () => count),
    hover: vi.fn(actions.hover || (async () => {})),
    click: vi.fn(actions.click || (async () => {})),
  };
}

describe('message-page', () => {
  it('findPrivateMessageTrigger returns the first matched selector', async () => {
    const hit = createLocator(1);
    const miss = createLocator(0);
    const page = {
      locator: vi.fn((selector) => {
        if (selector === '[data-e2e="something-button"]:has-text("私信")') return hit;
        return miss;
      }),
    };

    const result = await findPrivateMessageTrigger(page);

    expect(result).toBeTruthy();
    expect(result.selector).toBe('[data-e2e="something-button"]:has-text("私信")');
    expect(result.locator).toBe(hit);
  });

  it('openPrivateMessagePanel prefers hover when panel appears', async () => {
    const locator = createLocator(1);
    const page = {
      locator: vi.fn(() => locator),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true),
      waitForTimeout: vi.fn(async () => {}),
    };

    const result = await openPrivateMessagePanel(page, { timeoutMs: 1000 });

    expect(result).toMatchObject({ ok: true, method: 'hover' });
    expect(locator.hover).toHaveBeenCalledOnce();
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('confirmPrivateMessageDeletion clicks the confirm button coordinates', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        ok: true,
        target: { x: 260, y: 420 },
      })),
      mouse: {
        move: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
      },
    };

    const result = await confirmPrivateMessageDeletion(page);

    expect(result).toEqual({ ok: true });
    expect(page.mouse.move).toHaveBeenCalledWith(260, 420);
    expect(page.mouse.click).toHaveBeenCalledWith(260, 420);
  });

  it('clearPrivateMessages deletes the requested number of sessions', async () => {
    const page = {
      locator: vi.fn(() => createLocator(1)),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          conversation: { x: 120, y: 180, text: '会话A\n13:06', conversationType: 'personal', toParticipantSecUserId: 'sec-a', participantCount: 2 },
        })
        .mockResolvedValueOnce({
          ok: true,
          target: { x: 200, y: 240 },
        })
        .mockResolvedValueOnce({
          ok: true,
          target: { x: 260, y: 420 },
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          conversation: { x: 120, y: 240, text: '会话B\n13:05', conversationType: 'personal', toParticipantSecUserId: 'sec-b', participantCount: 2 },
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          conversation: { x: 120, y: 240, text: '会话B\n13:05', conversationType: 'personal', toParticipantSecUserId: 'sec-b', participantCount: 2 },
        })
        .mockResolvedValueOnce({
          ok: true,
          target: { x: 200, y: 240 },
        })
        .mockResolvedValueOnce({
          ok: true,
          target: { x: 260, y: 420 },
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          conversation: { x: 120, y: 300, text: '会话C\n13:04', conversationType: 'personal', toParticipantSecUserId: 'sec-c', participantCount: 2 },
        }),
      waitForTimeout: vi.fn(async () => {}),
      mouse: {
        move: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
      },
    };

    const result = await clearPrivateMessages(page, { count: 2 });

    expect(result).toMatchObject({
      ok: true,
      deletedCount: 2,
      requestedCount: 2,
    });
    expect(page.mouse.click).toHaveBeenCalledWith(120, 180, { button: 'right' });
    expect(page.mouse.click).toHaveBeenCalledWith(120, 240, { button: 'right' });
  });

  it('clearPrivateMessages stops when delete action is missing', async () => {
    const page = {
      locator: vi.fn(() => createLocator(1)),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: true,
          conversation: { x: 120, y: 180, text: '会话A\n13:06', conversationType: 'personal', toParticipantSecUserId: 'sec-a', participantCount: 2 },
        })
        .mockResolvedValueOnce({
          ok: false,
          reason: 'menu_action_not_found',
        }),
      waitForTimeout: vi.fn(async () => {}),
      mouse: {
        move: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
      },
    };

    const result = await clearPrivateMessages(page, { count: 1 });

    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe('menu_action_not_found');
  });

  it('clearPrivateMessages stops when only group chats are present', async () => {
    const page = {
      locator: vi.fn(() => createLocator(1)),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          ok: false,
          reason: 'personal_conversation_not_found',
        }),
      waitForTimeout: vi.fn(async () => {}),
      mouse: {
        move: vi.fn(async () => {}),
        click: vi.fn(async () => {}),
      },
    };

    const result = await clearPrivateMessages(page, { count: 1 });

    expect(result.ok).toBe(false);
    expect(page.mouse.click).not.toHaveBeenCalled();
  });
});
