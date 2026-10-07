import { describe, expect, it, vi } from 'vitest';
import { loginItemChannels } from '../../shared/ipc/loginItem';
import { loginItemBridge } from './loginItem';

// Electron's ipcRenderer, as far as the bridge helpers use it (see ../bridge.test.ts). Hoisted,
// because vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, ((event: object, payload: unknown) => void)[]>();
  const calls: { channel: string; payload?: unknown }[] = [];
  return {
    calls,
    renderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ channel, payload });
        return Promise.resolve({ status: 'enabled' });
      },
      on: (channel: string, listener: (event: object, payload: unknown) => void): void => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: (event: object, payload: unknown) => void) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

describe('the login item bridge', () => {
  it('asks for the state on its own channel', async () => {
    await expect(loginItemBridge.getLoginItemState()).resolves.toEqual({ status: 'enabled' });
    expect(ipc.calls).toEqual([
      { channel: loginItemChannels.LoginItemGetState, payload: undefined },
    ]);
  });

  it("hands main's state changes to its listener until it unsubscribes", () => {
    const heard: unknown[] = [];
    const stop = loginItemBridge.onLoginItemStateChanged((state) => heard.push(state));
    ipc.emit(loginItemChannels.LoginItemStateChanged, { status: 'requires-approval' });
    stop();
    ipc.emit(loginItemChannels.LoginItemStateChanged, { status: 'disabled' });
    expect(heard).toEqual([{ status: 'requires-approval' }]);
  });
});
