import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import {
  handleTrusted,
  isTrustedSender,
  onTrusted,
  type IpcMainLike,
  type IpcTrust,
  type SenderEvent,
} from './trust';

const MAIN_PAGE = 7;
const OTHER_PAGE = 9;

type Handler = (event: SenderEvent, payload: unknown) => unknown;

/** ipcMain as the preload drives it: an invoke or a send from a page with a webContents id. */
function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: (channel, listener) => listeners.set(channel, listener),
  };
  const registered = (map: Map<string, Handler>, channel: string): Handler => {
    const handler = map.get(channel);
    if (!handler) throw new Error(`nothing registered on ${channel}`);
    return handler;
  };
  const from = (senderId: number): SenderEvent => ({ sender: { id: senderId } });
  return {
    ipcMain,
    /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
    invoke: (channel: string, senderId: number, payload?: unknown): Promise<unknown> =>
      Promise.resolve().then(() => registered(handlers, channel)(from(senderId), payload)),
    send: (channel: string, senderId: number, payload?: unknown): void => {
      registered(listeners, channel)(from(senderId), payload);
    },
  };
}

function harness(
  window: { webContents: { id: number } } | null = { webContents: { id: MAIN_PAGE } },
) {
  const ipc = fakeIpcMain();
  const lines: string[] = [];
  const trust: IpcTrust = {
    ipcMain: ipc.ipcMain,
    getWindow: () => window,
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
  };
  return { ...ipc, trust, lines };
}

describe('handleTrusted', () => {
  it("answers the trusted window's page with the handler's result, given the payload", async () => {
    const h = harness();
    handleTrusted(h.trust, 'vocabulary:set', (payload) => ({ saved: payload }));
    await expect(h.invoke('vocabulary:set', MAIN_PAGE, ['Roger'])).resolves.toEqual({
      saved: ['Roger'],
    });
  });

  it('refuses another page and logs which sender and channel', async () => {
    const h = harness();
    const run = vi.fn();
    handleTrusted(h.trust, 'capture:start', run);
    await expect(h.invoke('capture:start', OTHER_PAGE)).rejects.toThrow('untrusted sender');
    expect(run).not.toHaveBeenCalled();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('ipc message from unexpected sender ignored');
    expect(h.lines[0]).toContain(`"senderId":${OTHER_PAGE}`);
    expect(h.lines[0]).toContain('"channel":"capture:start"');
  });

  it('refuses every page while the trusted window is not open', async () => {
    const h = harness(null);
    const run = vi.fn();
    handleTrusted(h.trust, 'capture:start', run);
    await expect(h.invoke('capture:start', MAIN_PAGE)).rejects.toThrow('untrusted sender');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('onTrusted', () => {
  it("passes the trusted window's messages on and drops another page's", () => {
    const h = harness();
    const listener = vi.fn();
    onTrusted(h.trust, 'audio:chunk', listener);
    h.send('audio:chunk', MAIN_PAGE, { source: 'mic' });
    h.send('audio:chunk', OTHER_PAGE, { source: 'system' });
    expect(listener.mock.calls).toEqual([[{ source: 'mic' }]]);
    expect(h.lines.filter((line) => line.includes('"channel":"audio:chunk"'))).toHaveLength(1);
  });
});

describe('isTrustedSender', () => {
  it("trusts only the window's own page, and nothing while it is closed", () => {
    expect(isTrustedSender(harness().trust, { sender: { id: MAIN_PAGE } }, 'app:ready')).toBe(true);
    expect(isTrustedSender(harness().trust, { sender: { id: OTHER_PAGE } }, 'app:ready')).toBe(
      false,
    );
    expect(isTrustedSender(harness(null).trust, { sender: { id: MAIN_PAGE } }, 'app:ready')).toBe(
      false,
    );
  });
});
