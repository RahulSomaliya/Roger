import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import type { AppRoute } from '../shared/ipc/app';
import { buildAppMenu } from './appMenu';

function appMenuItems(opened: AppRoute[] = []): MenuItemConstructorOptions[] {
  const [appMenu] = buildAppMenu({ appName: 'Roger', open: (route) => opened.push(route) });
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

  it("keeps Electron's default menus, so copy, paste, undo, reload and quit still work", () => {
    const roles = buildAppMenu({ appName: 'Roger', open: () => undefined }).map(
      (entry) => entry.role,
    );
    expect(roles).toEqual([undefined, 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
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
});
