import { join } from 'node:path';
import type { Menu, nativeImage, Tray } from 'electron';
import type { CalendarConnection, CalendarEvent, CalendarSyncState } from '../../shared/calendar';
import type { CapturePhase, StartCaptureRequest } from '../../shared/capture';
import { errorMessage, type Logger } from '../logger';
import {
  buildTrayModel,
  type TrayAction,
  type TrayFormat,
  type TrayIconState,
  type TrayModel,
} from './trayMenu';

/**
 * Roger's menu bar item (M5-T11): the icon (idle, recording, warning), the next meeting, Start
 * notes now, Stop note, calendar warnings, Open Roger and Quit Roger. What the menu says is
 * decided in trayMenu.ts; this file feeds it, routes each click and keeps Electron's Tray current.
 *
 * Quit calls `app.quit()` and nothing else: RecordingLifecycle stops the recording and runs the
 * quit hooks (P2-F1 forbids a second before-quit listener), so the tray adds no stop of its own.
 */

/** The menu item shape Electron's `Menu.buildFromTemplate` takes, as far as this builds one. */
export interface TrayMenuItem {
  type?: 'separator';
  label?: string;
  enabled?: boolean;
  click?: () => void;
}

/** Electron's Tray, as MenuBarTray drives it (createElectronTrayView builds the real one). */
export interface TrayView {
  setIcon(iconPath: string): void;
  setToolTip(text: string): void;
  setMenu(items: TrayMenuItem[]): void;
  destroy(): void;
}

/** The parts of CaptureService the tray uses. */
export interface TrayCapture {
  /** Not getStatus(): that reads the store, which a quit's cleanup closes. */
  readonly phase: CapturePhase;
  on(event: 'status', listener: () => void): () => void;
  /** Asks the window to start a recording: audio capture runs in the page, so main cannot alone. */
  requestStart(request: StartCaptureRequest): void;
  stop(): Promise<unknown>;
}

/**
 * The calendar runtime's parts the menu reads (M5-T9c builds them): the connection as the API last
 * told it, this Mac's copy and its health. All in memory after start: a refresh never reads the
 * cache, which a quit closes.
 */
export interface TrayCalendarSource {
  account: {
    onConnectionChange(listener: (connection: CalendarConnection | null) => void): () => void;
  };
  sync: {
    getState(): CalendarSyncState;
    onStateChange(listener: (state: CalendarSyncState) => void): () => void;
    onEventsChange(listener: (events: CalendarEvent[]) => void): () => void;
  };
  cache: { listEvents(): CalendarEvent[] };
}

export interface MenuBarTrayOptions {
  view: TrayView;
  iconPath: (state: TrayIconState) => string;
  capture: TrayCapture;
  /** Null: no calendar runtime, so the menu says nothing of meetings. */
  calendar: TrayCalendarSource | null;
  actions: {
    /** Brings the main window forward. */
    open: () => void;
    /** Opens Settings, where the Google sign-in is run again. */
    reconnect: () => void;
    /** `app.quit()`. */
    quit: () => void;
  };
  now: () => number;
  format: TrayFormat;
  logger: Logger;
}

/** The next meeting line turns from "Next" to "Now" at its start: a minute is fine enough. */
const REFRESH_MS = 60_000;

export class MenuBarTray {
  private connection: CalendarConnection | null = null;
  private events: readonly CalendarEvent[] = [];
  private sync: CalendarSyncState | null = null;
  /** The model last given to the view, as text: an unchanged model touches nothing. */
  private shown: string | null = null;
  private shownIcon: TrayIconState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stops: (() => void)[] = [];

  constructor(private readonly options: MenuBarTrayOptions) {}

  start(): void {
    const { capture, calendar } = this.options;
    this.stops.push(
      capture.on('status', () => {
        this.refresh();
      }),
    );
    if (calendar !== null) {
      this.events = calendar.cache.listEvents();
      this.sync = calendar.sync.getState();
      this.stops.push(
        calendar.account.onConnectionChange((connection) => {
          this.connection = connection;
          this.refresh();
        }),
        calendar.sync.onEventsChange((events) => {
          this.events = events;
          this.refresh();
        }),
        calendar.sync.onStateChange((state) => {
          this.sync = state;
          this.refresh();
        }),
      );
    }
    this.timer = setInterval(() => {
      this.refresh();
    }, REFRESH_MS);
    this.refresh();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const stop of this.stops.splice(0)) stop();
    this.options.view.destroy();
  }

  /** Rebuilds the menu when what it says changed. Called from events, so it never throws. */
  private refresh(): void {
    const { view, iconPath, capture, now, format, logger } = this.options;
    try {
      const model = buildTrayModel({
        recording: capture.phase === 'recording',
        nowMs: now(),
        events: this.events,
        connection: this.connection,
        sync: this.sync,
        format,
      });
      const key = JSON.stringify(model);
      if (key === this.shown) return;
      if (model.icon !== this.shownIcon) view.setIcon(iconPath(model.icon));
      view.setToolTip(model.tooltip);
      view.setMenu(this.template(model));
      this.shown = key;
      this.shownIcon = model.icon;
    } catch (error) {
      // Nobody to tell in an event handler, and the menu bar item is not worth the app: the log
      // says what failed, and the next change or minute tries again with the menu as it was.
      logger.error('menu bar item not updated', { error: errorMessage(error) });
    }
  }

  private template(model: TrayModel): TrayMenuItem[] {
    return model.entries.map((entry): TrayMenuItem => {
      switch (entry.kind) {
        case 'separator':
          return { type: 'separator' };
        case 'label':
          return { label: entry.text, enabled: false };
        case 'action':
          return {
            label: entry.text,
            click: () => {
              this.act(entry.action);
            },
          };
      }
    });
  }

  private act(action: TrayAction): void {
    const { capture, actions, logger } = this.options;
    try {
      switch (action) {
        case 'start':
          // The page opens the microphone, so main asks it (a hidden window still captures,
          // window.ts `backgroundThrottling: false`). `tray` is kept with the meeting.
          capture.requestStart({ source: 'tray' });
          return;
        case 'stop':
          capture.stop().catch((error: unknown) => {
            logger.error('stop from the menu bar failed', { error: errorMessage(error) });
          });
          return;
        case 'open':
          actions.open();
          return;
        case 'reconnect':
          actions.reconnect();
          return;
        case 'quit':
          actions.quit();
          return;
      }
    } catch (error) {
      logger.error('menu bar action failed', { action, error: errorMessage(error) });
    }
  }
}

// Electron ---------------------------------------------------------------------------------------

/** The icon files in `build/` (copied to `Resources/tray/` by electron-builder.yml's extraResources). */
export const TRAY_ICON_FILES: Readonly<Record<TrayIconState, string>> = {
  idle: 'trayTemplate.png',
  recording: 'trayRecordingTemplate.png',
  warning: 'trayWarningTemplate.png',
};

/** Under `process.resourcesPath` when packaged; `build/` is not inside the asar. */
export const TRAY_ICON_BUNDLE_DIR = 'tray';

export interface TrayIconContext {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` when unpackaged (helperPath.ts relies on the same). */
  appPath: string;
}

/**
 * Where an icon lives. Trap: the file name ends in `Template` and has an `@2x` beside it: Electron
 * (nativeImage.createFromPath) treats a name ending in `Template` as a template image, which
 * macOS tints for the light and dark menu bar, and finds the `@2x` file by name. Rename one file
 * and the icon turns black on a dark menu bar, or blurry. Keep the three files together.
 */
export function trayIconPath(state: TrayIconState, context: TrayIconContext): string {
  const file = TRAY_ICON_FILES[state];
  return context.isPackaged
    ? join(context.resourcesPath, TRAY_ICON_BUNDLE_DIR, file)
    : join(context.appPath, 'build', file);
}

/** The Electron classes `createElectronTrayView` uses; index.ts passes the real ones. */
export interface ElectronTrayParts {
  Tray: typeof Tray;
  Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  nativeImage: Pick<typeof nativeImage, 'createFromPath'>;
}

/**
 * The real Tray. Throws when the icon file is missing: `createFromPath` answers an empty image,
 * which makes an invisible menu bar item with no error, and Roger would run with no way to quit
 * from the menu bar and no sign it is there.
 */
export function createElectronTrayView(parts: ElectronTrayParts, iconPath: string): TrayView {
  const load = (path: string) => {
    const image = parts.nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error(`menu bar icon not found or unreadable: ${path}`);
    return image;
  };
  const tray = new parts.Tray(load(iconPath));
  return {
    setIcon: (path) => {
      tray.setImage(load(path));
    },
    setToolTip: (text) => {
      tray.setToolTip(text);
    },
    setMenu: (items) => {
      tray.setContextMenu(parts.Menu.buildFromTemplate(items));
    },
    destroy: () => {
      tray.destroy();
    },
  };
}
