import type { MenuItemConstructorOptions } from 'electron';
import type { AppRoute } from '../shared/ipc/app';

export interface AppMenuOptions {
  /** Shown as the first menu's title; macOS shows the app's own name there anyway. */
  appName: string;
  /** Opens a route in the main window and brings the window forward (main/navigation.ts). */
  open: (route: AppRoute) => void;
  /** File > Start notes: asks the window to start (audio capture runs in the page). */
  startNotes: () => void;
  /** File > Stop: stops a recording; does nothing while none runs. */
  stopNotes: () => void;
  /**
   * The shipped app has no Reload, Force Reload or Developer Tools: Cmd+R mid-call reloads the page
   * that records the audio and the call is lost from that point. A development build keeps them.
   */
  isPackaged: boolean;
}

/**
 * The menu bar names every place (redesign sweep): Roger > Settings…, Set up Roger…; File > Start
 * notes (Cmd+N), Stop; Go > Home (Cmd+[), Settings, Set up Roger. Setting a menu replaces the whole
 * default one, so every default role is listed again: without the Edit menu's roles, Cmd+C, Cmd+V
 * and Cmd+Z do nothing in any text field on macOS. Index.ts builds it with Menu.buildFromTemplate;
 * no Electron import here, so this tests under Node.
 */
export function buildAppMenu({
  appName,
  open,
  startNotes,
  stopNotes,
  isPackaged,
}: AppMenuOptions): MenuItemConstructorOptions[] {
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
    {
      label: 'File',
      submenu: [
        { label: 'Start notes', accelerator: 'CmdOrCtrl+N', click: startNotes },
        // No shortcut: ending a recording is a click, never a stray keystroke.
        { label: 'Stop', click: stopNotes },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    // A page is one step under Home, so Back is Home: one item, no history.
    {
      label: 'Go',
      submenu: [
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            open('home');
          },
        },
        {
          label: 'Settings',
          // Shown, not registered: Roger > Settings… owns Cmd+, and two owners would both fire.
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,
          click: () => {
            open('settings');
          },
        },
        {
          label: 'Set up Roger',
          click: () => {
            open('setup');
          },
        },
      ],
    },
    isPackaged
      ? {
          label: 'View',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        }
      : { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
