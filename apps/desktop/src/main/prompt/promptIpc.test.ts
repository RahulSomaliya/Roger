import { describe, expect, it, vi } from 'vitest';
import {
  promptChannels,
  type PromptActionRequest,
  type PromptPanelState,
} from '../../shared/ipc/prompt';
import type { IpcMainLike, SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { parsePromptActionRequest, registerPromptIpc, type PromptPanelWindow } from './promptIpc';

const PROMPT_PANEL = 9;
const MAIN_PAGE = 7;

const EMPTY: PromptPanelState = { cards: [], recording: false, recordingTitle: null };

type Handler = (event: SenderEvent, payload: unknown) => unknown;

function harness(options: { panelOpen?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const sent: [string, unknown][] = [];
  let destroyed = false;
  const panel: PromptPanelWindow = {
    webContents: {
      id: PROMPT_PANEL,
      send: (channel, payload) => {
        sent.push([channel, payload]);
      },
      isDestroyed: () => destroyed,
    },
  };
  let open = options.panelOpen ?? true;
  const listeners = new Set<(state: PromptPanelState) => void>();
  const prompts = {
    getState: vi.fn(() => EMPTY),
    act: vi.fn((_request: PromptActionRequest) => Promise.resolve()),
    onChange: (listener: (state: PromptPanelState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const stop = registerPromptIpc({
    ipcMain,
    getWindow: () => (open ? panel : null),
    prompts,
    logger,
  });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, payload?: unknown, senderId = PROMPT_PANEL): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });

  return {
    prompts,
    sent,
    lines,
    invoke,
    stop,
    change: (state: PromptPanelState) => {
      for (const listener of [...listeners]) listener(state);
    },
    close: () => {
      open = false;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('prompt IPC', () => {
  it("answers the panel's state", async () => {
    const h = harness();
    await expect(h.invoke(promptChannels.PromptGetState)).resolves.toEqual(EMPTY);
  });

  it('refuses every other sender, the main window included', async () => {
    const h = harness();
    await expect(h.invoke(promptChannels.PromptGetState, undefined, MAIN_PAGE)).rejects.toThrow(
      'untrusted sender',
    );
    await expect(
      h.invoke(promptChannels.PromptAct, { cardId: 'prompt-1', action: 'dismiss' }, MAIN_PAGE),
    ).rejects.toThrow('untrusted sender');
    expect(h.prompts.getState).not.toHaveBeenCalled();
    expect(h.prompts.act).not.toHaveBeenCalled();
  });

  it('refuses everyone while the panel is not open', async () => {
    const h = harness({ panelOpen: false });
    await expect(h.invoke(promptChannels.PromptGetState)).rejects.toThrow('untrusted sender');
  });

  it('passes a checked action on, built afresh', async () => {
    const h = harness();
    const payload = { cardId: 'prompt-1', action: 'take_notes', eventId: 'abc', extra: 'x' };
    await h.invoke(promptChannels.PromptAct, payload);
    expect(h.prompts.act).toHaveBeenCalledWith({
      cardId: 'prompt-1',
      action: 'take_notes',
      eventId: 'abc',
    });
  });

  it('refuses an action that is not one, naming what is wrong', async () => {
    const h = harness();
    await expect(h.invoke(promptChannels.PromptAct, { action: 'dismiss' })).rejects.toThrow(
      'prompt:act refused: cardId is not a card id',
    );
    expect(h.prompts.act).not.toHaveBeenCalled();
  });

  it('sends each change to the panel, and nothing once it is closed or destroyed', () => {
    const h = harness();
    const state: PromptPanelState = { ...EMPTY, recording: true };
    h.change(state);
    expect(h.sent).toEqual([[promptChannels.PromptStateChanged, state]]);

    h.destroy();
    h.change(EMPTY);
    h.close();
    h.change(EMPTY);
    expect(h.sent).toHaveLength(1);

    h.stop();
    expect(h.lines).toEqual([]);
  });
});

describe('parsePromptActionRequest', () => {
  it.each([
    [
      { cardId: 'prompt-1', action: 'take_notes' },
      { cardId: 'prompt-1', action: 'take_notes' },
    ],
    [
      { cardId: 'prompt-1', action: 'take_notes', eventId: 'e1' },
      { cardId: 'prompt-1', action: 'take_notes', eventId: 'e1' },
    ],
    [
      { cardId: 'prompt-2', action: 'join_and_take_notes', eventId: 'e1' },
      { cardId: 'prompt-2', action: 'join_and_take_notes', eventId: 'e1' },
    ],
    [
      { cardId: 'prompt-3', action: 'dismiss', eventId: 'ignored' },
      { cardId: 'prompt-3', action: 'dismiss' },
    ],
    [
      { cardId: 'prompt-3', action: 'dismiss' },
      { cardId: 'prompt-3', action: 'dismiss' },
    ],
    [
      { cardId: 'prompt-3', action: 'open_roger' },
      { cardId: 'prompt-3', action: 'open_roger' },
    ],
  ])('takes %j', (payload, request) => {
    expect(parsePromptActionRequest(payload)).toEqual(request);
  });

  it.each([
    [null, 'not an object'],
    [['prompt-1', 'dismiss'], 'not an object'],
    [{ cardId: '', action: 'dismiss' }, 'cardId is not a card id'],
    [{ cardId: 'x'.repeat(65), action: 'dismiss' }, 'cardId is not a card id'],
    [{ cardId: 'prompt-1', action: 'start' }, 'action is not a prompt action'],
    // Copy notice left the panel with the redesign: a stale page must not reach the service.
    [{ cardId: 'prompt-1', action: 'copy_notice' }, 'action is not a prompt action'],
    [{ cardId: 'prompt-1', action: 'join_and_take_notes' }, 'eventId is not an event id'],
    [{ cardId: 'prompt-1', action: 'take_notes', eventId: 7 }, 'eventId is not an event id'],
    [
      { cardId: 'prompt-1', action: 'take_notes', eventId: 'e'.repeat(2049) },
      'eventId is not an event id',
    ],
  ])('refuses %j', (payload, why) => {
    expect(() => parsePromptActionRequest(payload)).toThrow(`prompt:act refused: ${why}`);
  });
});
