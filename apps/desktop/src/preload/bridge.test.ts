import { describe, expect, it, vi } from 'vitest';
import { invoke, send, subscribe } from './bridge';

// Electron's ipcRenderer, as far as the bridge helpers use it. Hoisted, because vi.mock runs
// before the imports.
const ipc = vi.hoisted(() => {
  type Listener = (event: { senderId: number }, payload: unknown) => void;
  const listeners = new Map<string, Listener[]>();
  const invoked: unknown[][] = [];
  const sent: unknown[][] = [];
  return {
    invoked,
    sent,
    renderer: {
      invoke: (...args: unknown[]): Promise<unknown> => {
        invoked.push(args);
        return Promise.resolve('answer from main');
      },
      send: (...args: unknown[]): void => {
        sent.push(args);
      },
      on: (channel: string, listener: Listener): void => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: Listener): void => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    /** A main → renderer event, as webContents.send delivers it: the event first. */
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({ senderId: 0 }, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

describe('the preload bridge helpers', () => {
  it("invoke sends the channel and its one payload, and resolves with main's answer", async () => {
    await expect(invoke('vocabulary:set', { terms: ['Roger'] })).resolves.toBe('answer from main');
    await invoke('capture:start');
    expect(ipc.invoked).toEqual([
      ['vocabulary:set', { terms: ['Roger'] }],
      ['capture:start', undefined],
    ]);
  });

  it('send fires the payload and forgets it', () => {
    send('audio:chunk', { source: 'mic' });
    expect(ipc.sent).toEqual([['audio:chunk', { source: 'mic' }]]);
  });

  it('subscribe hands the payload without the event, until its unsubscribe', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = subscribe('capture:status-changed', (payload) => first.push(payload));
    subscribe('capture:status-changed', (payload) => second.push(payload));
    ipc.emit('capture:status-changed', 'recording');
    stopFirst();
    ipc.emit('capture:status-changed', 'idle');

    expect(first).toEqual(['recording']);
    expect(second).toEqual(['recording', 'idle']);
  });
});
