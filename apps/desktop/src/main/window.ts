import { join } from 'node:path';
import { BrowserWindow, screen, type Session } from 'electron';
import {
  loadWindowBounds,
  MIN_WINDOW_SIZE,
  restoreBounds,
  saveWindowBounds,
} from './app/windowBounds';
import { hideOnClose, showWhenReady } from './app/windowLifecycle';
import type { RecordingLifecycle } from './lifecycle';
import { errorMessage, type Logger } from './logger';
import { isAppPageUrl, isPermissionAllowed, type AppPage } from './page-policy';

/** Where the page is loaded from. The guards below allow exactly this page and nothing else. */
export function resolveAppPage(): AppPage {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return {
    devServerUrl: devUrl !== undefined && devUrl !== '' ? devUrl : null,
    rendererDir: join(__dirname, '../renderer'),
  };
}

/**
 * Web permissions for the whole session: `media` for the app's own page (mic and system audio),
 * nothing else, for no other origin. Electron's default with no handler is to grant everything.
 * The decision lives in page-policy.ts; read its notes before changing it or the Electron version.
 */
export function installPermissionHandlers(session: Session, page: AppPage, logger: Logger): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details.requestingUrl !== '' ? details.requestingUrl : webContents.getURL();
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const allowed = isPermissionAllowed({ permission, url, mediaTypes }, page);
    if (!allowed) logger.warn('permission request denied', { permission, url, mediaTypes });
    callback(allowed);
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    isPermissionAllowed(
      {
        permission,
        url: details.requestingUrl ?? webContents?.getURL() ?? requestingOrigin,
        mediaTypes: details.mediaType === undefined ? [] : [details.mediaType],
      },
      page,
    ),
  );
}

/**
 * Traffic lights (sweep D1): the system title bar row is gone (`hiddenInset`) and the page's 52 px
 * header takes its place, so "Roger" shows once. The lights are 12 px circles 8 px apart (52 px
 * together) and sit at x 16, y 18: that centres them on the header's middle line (18 + 16 / 2 =
 * 26 = 52 / 2) and leaves 80 px at the left of the header for them. Renderer/src header (T4) keeps
 * that 80 px empty and `-webkit-app-region: drag` elsewhere; change a number here, change it there
 * and in docs/design.md (Window and layout).
 */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 } as const;

/** How long a resize or move must rest before the bounds are written (a drag fires many). */
const SAVE_BOUNDS_AFTER_MS = 400;

/**
 * The single app window. Renderer isolation is non-negotiable (house rule 5).
 *
 * Closing it hides it (app/windowLifecycle.ts): the page keeps capturing the microphone and Roger
 * keeps running in the menu bar. `lifecycle.quitting` lets the close of a quit through; without
 * it Cmd+Q would be turned into a hide and Roger would never exit. `openedAtLogin` starts the
 * window hidden when macOS launched Roger at login.
 */
export function createMainWindow(
  preloadPath: string,
  page: AppPage,
  logger: Logger,
  {
    lifecycle,
    openedAtLogin,
    boundsPath,
    backgroundColor,
  }: {
    lifecycle: Pick<RecordingLifecycle, 'quitting'>;
    openedAtLogin: boolean;
    /** `userData/window-bounds.json`: the size and place the person left it at. */
    boundsPath: string;
    /** The canvas of the theme in force (app/appearance.ts); the window shows no other colour. */
    backgroundColor: string;
  },
): BrowserWindow {
  // Landscape by default (Rahul, 2026-10-08), or where the person left it when that still lies on
  // a connected display (app/windowBounds.ts). The display under the cursor hosts a first launch.
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = restoreBounds(
    loadWindowBounds(boundsPath, logger),
    screen.getAllDisplays().map((display) => display.workArea),
    cursorDisplay.workArea,
  );
  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: 'Roger',
    backgroundColor,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Chromium throttles timers and rendering in a hidden window. The page captures the
      // microphone and runs call detection, so a recording or a prompt would degrade the moment
      // the window is closed (M2, M5): its timers must keep their pace while it is hidden.
      backgroundThrottling: false,
    },
  });
  showWhenReady(window, { openedAtLogin });
  hideOnClose(window, lifecycle);
  rememberBounds(window, boundsPath, logger);
  // No new windows: the app has no links, and a new window would sit outside these guards.
  window.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn('new window blocked', { url });
    return { action: 'deny' };
  });
  // The page may reload itself but never navigate away: any other page would get window.roger.
  window.webContents.on('will-navigate', (event) => {
    if (isAppPageUrl(event.url, page)) return;
    event.preventDefault();
    logger.warn('navigation away from the app blocked', { url: event.url });
  });

  const loading =
    page.devServerUrl !== null
      ? window.loadURL(page.devServerUrl)
      : window.loadFile(join(page.rendererDir, 'index.html'));
  loading.catch((error: unknown) => {
    logger.error('app page failed to load', { error: errorMessage(error) });
  });
  return window;
}

/**
 * Writes the window's normal (not maximised or full-screen) bounds once a move or resize rests, and
 * on close. Close only hides the window (hideOnClose), so a quit may never see a 'closed': saving on
 * 'close' as well keeps the last place across a quit from the menu bar.
 */
function rememberBounds(window: BrowserWindow, path: string, logger: Logger): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    saveWindowBounds(path, window.getNormalBounds(), logger);
  };
  const later = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, SAVE_BOUNDS_AFTER_MS);
  };
  window.on('resized', later);
  window.on('moved', later);
  window.on('close', save);
}
