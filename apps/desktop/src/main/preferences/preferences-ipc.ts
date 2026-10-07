import { prefsChannels } from '../../shared/ipc/prefs';
import { handleTrusted, type IpcMainLike, type IpcTrust } from '../ipc/trust';
import { errorMessage, type Logger } from '../logger';
import type { PreferencesStore } from './PreferencesStore';

/** The parts of the main window this needs; a BrowserWindow is one. */
export interface PreferencesWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; send(channel: string, payload: unknown): void };
}

export interface PreferencesIpcDeps {
  ipcMain: IpcMainLike;
  store: PreferencesStore;
  /** The main window, whose page alone may read and set preferences; null while it is closed. */
  getWindow: () => PreferencesWindow | null;
  logger: Logger;
}

/**
 * Wires the preferences' channels (src/shared/ipc/prefs.ts) to the store, for the main window's
 * page only (ipc/trust.ts): the prompt panel shows calendar cards and has no business changing
 * settings. Every change, from the page or from main, goes to the page as one prefs:changed.
 */
export function registerPreferencesIpc({
  ipcMain,
  store,
  getWindow,
  logger,
}: PreferencesIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };

  handleTrusted(trust, prefsChannels.PrefsGetAll, () => store.getAll());
  handleTrusted(trust, prefsChannels.PrefsSet, (payload) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('key' in payload) ||
      !('value' in payload)
    ) {
      throw new Error(`${prefsChannels.PrefsSet} takes { key, value }`);
    }
    try {
      store.parseAndSet(payload.key, payload.value);
    } catch (error) {
      // The page gets the message too (the invoke rejects with it) and must show it.
      logger.warn('preference set refused', { error: errorMessage(error) });
      throw error;
    }
  });

  store.onChange((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(prefsChannels.PrefsChanged, change);
  });
}
