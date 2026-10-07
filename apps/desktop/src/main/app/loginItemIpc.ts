import { loginItemChannels, type LoginItemState } from '../../shared/ipc/loginItem';
import { handleTrusted, type IpcMainLike, type IpcTrust } from '../ipc/trust';
import type { Logger } from '../logger';
import type { LoginItemController } from './loginItem';

/** The parts of the main window this needs; a BrowserWindow is one. */
export interface LoginItemIpcWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; send(channel: string, payload: unknown): void };
}

export interface LoginItemIpcDeps {
  ipcMain: IpcMainLike;
  controller: Pick<LoginItemController, 'getState' | 'onChange'>;
  /** The main window, whose page alone may use these channels; null while it is closed. */
  getWindow: () => LoginItemIpcWindow | null;
  logger: Logger;
}

/**
 * Wires the login item's channels (src/shared/ipc/loginItem.ts), for the main window's page only
 * (ipc/trust.ts): Settings reads the state and hears each change. The choice itself is the
 * preference `app.openAtLogin`, set through the preferences channels; main follows it in
 * LoginItemController.preferenceChanged, so there is no setter here.
 */
export function registerLoginItemIpc({
  ipcMain,
  controller,
  getWindow,
  logger,
}: LoginItemIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };
  handleTrusted(trust, loginItemChannels.LoginItemGetState, (): LoginItemState =>
    controller.getState(),
  );
  controller.onChange((state) => {
    const window = getWindow();
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(loginItemChannels.LoginItemStateChanged, state);
    }
  });
}
