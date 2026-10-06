import type { Logger } from '../logger';

/**
 * Who may use an IPC channel. Every feature's registrar (src/main/ipc.ts for capture, and each
 * feature's own `*Ipc.ts`) registers through handleTrusted and onTrusted, never through ipcMain
 * directly: a handler registered without the check answers any page, including one a navigation
 * or an injected frame put in the window. No Electron import, so registrars test under Node.
 */

/** The part of an IPC event this reads: which page sent it. */
export interface SenderEvent {
  readonly sender: { readonly id: number };
}

/** The parts of Electron's `ipcMain` this needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEvent, payload: unknown) => unknown): void;
  on(channel: string, listener: (event: SenderEvent, payload: unknown) => void): unknown;
}

/** The window whose page a registrar trusts: the main window, or the prompt panel for its own. */
export interface TrustedWindow {
  readonly webContents: { readonly id: number };
}

export interface IpcTrust {
  ipcMain: IpcMainLike;
  /** The one window whose page may use these channels; null while it is not open. */
  getWindow: () => TrustedWindow | null;
  logger: Logger;
}

/** True when the event comes from the trusted window's page; anything else is logged. */
export function isTrustedSender(trust: IpcTrust, event: SenderEvent, channel: string): boolean {
  const window = trust.getWindow();
  const ok = window !== null && event.sender.id === window.webContents.id;
  if (!ok) {
    trust.logger.warn('ipc message from unexpected sender ignored', {
      senderId: event.sender.id,
      channel,
    });
  }
  return ok;
}

/**
 * Answers an invoke from the trusted page with `run`'s result. Another sender's invoke rejects
 * with "untrusted sender" and `run` never sees it. The payload is the page's one argument,
 * unvalidated: `run` checks it before use.
 */
export function handleTrusted<T>(
  trust: IpcTrust,
  channel: string,
  run: (payload: unknown) => Promise<T> | T,
): void {
  trust.ipcMain.handle(channel, (event, payload) => {
    if (!isTrustedSender(trust, event, channel)) throw new Error('untrusted sender');
    return run(payload);
  });
}

/** Passes a fire-and-forget message from the trusted page to `listener`; drops any other. */
export function onTrusted(
  trust: IpcTrust,
  channel: string,
  listener: (payload: unknown) => void,
): void {
  trust.ipcMain.on(channel, (event, payload) => {
    if (isTrustedSender(trust, event, channel)) listener(payload);
  });
}
