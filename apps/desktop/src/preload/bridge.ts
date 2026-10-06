import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Unsubscribe } from '../shared/ipc';

/**
 * What every bridge in ./bridges/ is built from. A bridge is one feature's part of `window.roger`
 * (src/shared/ipc/<feature>.ts) over these three helpers; nothing else from Node or Electron
 * reaches the page.
 */

/**
 * A request to main, answered by the feature's handleTrusted handler (src/main/ipc/trust.ts).
 * One payload at most: main validates it as `unknown` before use.
 */
export function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  // The answer's type is fixed by the feature's API signature; main only answers what it says.
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

/** A fire-and-forget message to main (onTrusted in src/main/ipc/trust.ts). */
export function send(channel: string, payload: unknown): void {
  ipcRenderer.send(channel, payload);
}

/** Listens for a main → renderer event; the returned function stops listening. */
export function subscribe(channel: string, listener: (payload: never) => void): Unsubscribe {
  // Payload types are fixed by the API signatures; main only sends what the contract says.
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload as never);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}
