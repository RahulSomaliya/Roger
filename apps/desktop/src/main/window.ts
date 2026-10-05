import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';

/** The single app window. Renderer isolation is non-negotiable (house rule 5). */
export function createMainWindow(preloadPath: string): BrowserWindow {
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
}
