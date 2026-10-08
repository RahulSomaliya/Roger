import type { IpcMainLike } from '../ipc/trust';
import type { Logger } from '../logger';
import { LoginItemController, type LoginItemApp } from './loginItem';
import { registerLoginItemIpc, type LoginItemIpcWindow } from './loginItemIpc';
import type { LoginItemBuild } from './loginItemPolicy';
import {
  createElectronTrayView,
  type ElectronTrayParts,
  MenuBarTray,
  type TrayCalendarSource,
  type TrayCapture,
  trayIconPath,
} from './tray';
import { createTrayFormat } from './trayMenu';
import {
  keepRunningWithoutWindows,
  type AppEvents,
  type MainWindowLike,
  revealOnReopen,
  revealWindow,
} from './windowLifecycle';
import type { OpenAtLogin } from '../../shared/calendarPrefs';
import type { AppRoute } from '../../shared/ipc/app';
import type { PreferenceChange } from '../../shared/preferences';

/** The main window: BrowserWindow fits. */
export type KeepRunningWindow = LoginItemIpcWindow &
  Pick<MainWindowLike, 'show' | 'focus' | 'restore' | 'isMinimized'>;

export interface KeepRunningDeps {
  /** Electron's `app`. */
  app: AppEvents & LoginItemApp & { quit(): void };
  electron: ElectronTrayParts;
  build: LoginItemBuild;
  /** `wasOpenedAtLogin`, as read once at launch (the login item controller logs it). */
  openedAtLogin: boolean;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** `app.getAppPath()`. */
  appPath: string;
  capture: TrayCapture;
  /** Null: no calendar runtime, so the menu names no meetings and a connect turns no login item on. */
  calendar: TrayCalendarSource | null;
  preferences: {
    get(key: 'app.openAtLogin'): OpenAtLogin;
    onChange(listener: (change: PreferenceChange) => void): () => void;
  };
  ipcMain: IpcMainLike;
  getWindow: () => KeepRunningWindow | null;
  /** Opens a route in the main window's page (main/navigation.ts). */
  navigate: (route: AppRoute) => void;
  logger: Logger;
}

/**
 * Roger stays running when its window closes (M5-T11): the menu bar item, open at login, and the
 * window coming back from the Dock. `[slot M5-T11 lifecycle]` in index.ts calls it once, after the
 * window exists.
 */
export function startKeepRunning(deps: KeepRunningDeps): { stop(): void } {
  const { app, build, calendar, preferences, getWindow, logger } = deps;
  keepRunningWithoutWindows(app);
  revealOnReopen(app, getWindow);

  const loginItem = new LoginItemController({
    app,
    build,
    preference: () => preferences.get('app.openAtLogin'),
    logger: logger.child({ component: 'login-item' }),
  });
  registerLoginItemIpc({
    ipcMain: deps.ipcMain,
    controller: loginItem,
    getWindow,
    logger: logger.child({ component: 'ipc' }),
  });
  preferences.onChange((change) => {
    if (change.key === 'app.openAtLogin') loginItem.preferenceChanged();
  });
  // The first connect turns the login item on while the preference is `auto`.
  calendar?.account.onConnectionChange((connection) => {
    loginItem.setCalendarConnected(connection !== null);
  });
  loginItem.start({ openedAtLogin: deps.openedAtLogin });

  const iconContext = {
    isPackaged: build.isPackaged,
    resourcesPath: deps.resourcesPath,
    appPath: deps.appPath,
  };
  const openSettings = (): void => {
    deps.navigate('settings');
    const window = getWindow();
    if (window !== null && !window.isDestroyed()) revealWindow(window);
  };
  const tray = new MenuBarTray({
    view: createElectronTrayView(deps.electron, trayIconPath('idle', iconContext)),
    iconPath: (state) => trayIconPath(state, iconContext),
    capture: deps.capture,
    calendar,
    actions: {
      open: () => {
        const window = getWindow();
        if (window !== null && !window.isDestroyed()) revealWindow(window);
      },
      reconnect: openSettings,
      settings: openSettings,
      quit: () => {
        // Nothing else: RecordingLifecycle stops the recording and runs the quit hooks.
        app.quit();
      },
    },
    now: () => Date.now(),
    format: createTrayFormat(),
    logger: logger.child({ component: 'tray' }),
  });
  tray.start();
  return {
    stop: () => {
      tray.stop();
    },
  };
}
