import { describe, expect, it, vi } from 'vitest';
import { type LoginItemState, loginItemChannels } from '../../shared/ipc/loginItem';
import type { IpcMainLike, SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { registerLoginItemIpc } from './loginItemIpc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;

type Handler = (event: SenderEvent, payload: unknown) => unknown;

function setup(state: LoginItemState = { status: 'disabled' }) {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: () => undefined,
  };
  const sent: { channel: string; payload: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: MAIN_PAGE,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
  let listener: (next: LoginItemState) => void = () => undefined;
  const controller = {
    getState: vi.fn(() => state),
    onChange: (next: (state: LoginItemState) => void) => {
      listener = next;
      return () => undefined;
    },
  };
  registerLoginItemIpc({
    ipcMain,
    controller,
    getWindow: () => window,
    logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
  });
  return {
    handlers,
    sent,
    change: (next: LoginItemState) => {
      listener(next);
    },
    controller,
  };
}

describe('registerLoginItemIpc', () => {
  it('answers the main window page with the state', () => {
    const { handlers } = setup({ status: 'requires-approval' });
    const handler = handlers.get(loginItemChannels.LoginItemGetState);
    expect(handler?.({ sender: { id: MAIN_PAGE } }, undefined)).toEqual({
      status: 'requires-approval',
    });
  });

  it('refuses every other window, the prompt panel included', () => {
    const { handlers, controller } = setup();
    const handler = handlers.get(loginItemChannels.LoginItemGetState);
    expect(() => handler?.({ sender: { id: PROMPT_PANEL } }, undefined)).toThrow(
      'untrusted sender',
    );
    expect(controller.getState).not.toHaveBeenCalled();
  });

  it('sends every change of the state to the main window', () => {
    const { sent, change } = setup();
    change({ status: 'enabled' });
    expect(sent).toEqual([
      { channel: loginItemChannels.LoginItemStateChanged, payload: { status: 'enabled' } },
    ]);
  });
});
