import type { MenuItemConstructorOptions } from 'electron';
import type { AppRoute } from '../shared/ipc/app';

export interface AppMenuOptions {
  /** Shown as the first menu's title; macOS shows the app's own name there anyway. */
  appName: string;
  /** Opens a route in the main window and brings the window forward (main/navigation.ts). */
  open: (route: AppRoute) => void;
}

/**
 * The menu bar: Electron's default menus, plus "Settings…" and "Set up Roger…" in the app menu.
 * Setting a menu replaces the whole default one, so every default role is listed again: without
 * the Edit menu's roles, Cmd+C, Cmd+V and Cmd+Z do nothing in any text field on macOS, and
 * without the View menu there is no reload. Index.ts builds it with Menu.buildFromTemplate; no
 * Electron import here, so this tests under Node.
 */
export function buildAppMenu({ appName, open }: AppMenuOptions): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            open('settings');
          },
        },
        {
          label: 'Set up Roger…',
          click: () => {
            open('setup');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
