import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import type { AppRoute } from '../shared/ipc/app';
import { buildAppMenu, type AppMenuOptions } from './appMenu';

function options(overrides: Partial<AppMenuOptions> = {}): AppMenuOptions {
  return {
    appName: 'Roger',
    open: () => undefined,
    startNotes: () => undefined,
    stopNotes: () => undefined,
    isPackaged: true,
    ...overrides,
  };
}

function menuItems(label: string, overrides: Partial<AppMenuOptions> = {}) {
  const menu = buildAppMenu(options(overrides)).find((entry) => entry.label === label);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`no ${label} menu`);
  return menu.submenu;
}

function appMenuItems(opened: AppRoute[] = []): MenuItemConstructorOptions[] {
  const [appMenu] = buildAppMenu(options({ open: (route) => opened.push(route) }));
  if (!appMenu || !Array.isArray(appMenu.submenu)) throw new Error('no app menu');
  expect(appMenu.label).toBe('Roger');
  return appMenu.submenu;
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no menu item "${label}"`);
  return found;
}

/** Clicks a menu item as Electron would; the menu's handlers read none of the arguments. */
function click(entry: MenuItemConstructorOptions): void {
  if (!entry.click) throw new Error(`"${entry.label ?? ''}" has no click handler`);
  // Electron passes the item, the window and the keyboard event, none of which exist under Node;
  // the handlers in appMenu.ts read none of them.
  (entry.click as () => void)();
}

describe('buildAppMenu', () => {
  it('opens Settings from the app menu, with Cmd+,', () => {
    const opened: AppRoute[] = [];
    const settings = item(appMenuItems(opened), 'Settings…');
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    click(settings);
    expect(opened).toEqual(['settings']);
  });

  it('opens the setup route from "Set up Roger…"', () => {
    const opened: AppRoute[] = [];
    click(item(appMenuItems(opened), 'Set up Roger…'));
    expect(opened).toEqual(['setup']);
  });

  it("keeps Electron's default menus, so copy, paste, undo and quit still work", () => {
    const menus = buildAppMenu(options()).map((entry) => entry.role ?? entry.label);
    expect(menus).toEqual(['Roger', 'File', 'editMenu', 'Go', 'View', 'windowMenu']);
    expect(appMenuItems().map((entry) => entry.role ?? entry.label ?? entry.type)).toEqual([
      'about',
      'separator',
      'Settings…',
      'Set up Roger…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
  });

  it('File: Start notes with Cmd+N and Stop with no shortcut', () => {
    const calls: string[] = [];
    const file = menuItems('File', {
      startNotes: () => calls.push('start'),
      stopNotes: () => calls.push('stop'),
    });
    const start = item(file, 'Start notes');
    expect(start.accelerator).toBe('CmdOrCtrl+N');
    click(start);
    const stop = item(file, 'Stop');
    expect(stop.accelerator).toBeUndefined();
    click(stop);
    expect(calls).toEqual(['start', 'stop']);
  });

  it('Go: Home with Cmd+[, Settings and Set up Roger; the shortcut Cmd+, stays with the app menu', () => {
    const opened: AppRoute[] = [];
    const go = menuItems('Go', { open: (route) => opened.push(route) });
    const home = item(go, 'Home');
    expect(home.accelerator).toBe('CmdOrCtrl+[');
    click(home);
    const settings = item(go, 'Settings');
    expect(settings.registerAccelerator).toBe(false);
    click(settings);
    click(item(go, 'Set up Roger'));
    expect(opened).toEqual(['home', 'settings', 'setup']);
  });

  it('a packaged build has no Reload, Force Reload or Developer Tools; a development build does', () => {
    const roles = (isPackaged: boolean): (string | undefined)[] => {
      const view = buildAppMenu(options({ isPackaged })).find(
        (entry) => entry.label === 'View' || entry.role === 'viewMenu',
      );
      if (!view) throw new Error('no View menu');
      return Array.isArray(view.submenu) ? view.submenu.map((entry) => entry.role) : [view.role];
    };
    const packaged = roles(true);
    expect(packaged).toEqual(expect.arrayContaining(['zoomIn', 'zoomOut', 'togglefullscreen']));
    for (const forbidden of ['reload', 'forceReload', 'toggleDevTools']) {
      expect(packaged).not.toContain(forbidden);
    }
    expect(roles(false)).toEqual(['viewMenu']);
  });
});
