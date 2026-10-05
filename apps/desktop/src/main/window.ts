import { join } from 'node:path';
import { BrowserWindow, type Session } from 'electron';
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
 * The decision lives in page-policy.ts; read its CAPTURE_MEDIA_TYPES note before narrowing it.
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

/** The single app window. Renderer isolation is non-negotiable (house rule 5). */
export function createMainWindow(
  preloadPath: string,
  page: AppPage,
  logger: Logger,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: 'Roger',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
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
