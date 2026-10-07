import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnection } from '../../shared/calendar';
import type { OpenAtLogin } from '../../shared/calendarPrefs';
import type { PreferenceChange } from '../../shared/preferences';
import type { IpcMainLike } from '../ipc/trust';
import { createLogger } from '../logger';
import { startKeepRunning, type KeepRunningDeps } from './keepRunning';
import type { MacLoginStatus } from './loginItemPolicy';
import type { TrayMenuItem } from './tray';

const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-06T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};

function setup(options: { isPackaged: boolean; e2eOn?: boolean; preference?: OpenAtLogin }) {
  const mac: { status: MacLoginStatus } = { status: 'not-registered' };
  const app = Object.assign(new EventEmitter(), {
    sets: [] as boolean[],
    quits: 0,
    quit: () => {
      app.quits += 1;
    },
    getLoginItemSettings: () => ({ status: mac.status }),
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
      app.sets.push(settings.openAtLogin);
      mac.status = settings.openAtLogin ? 'enabled' : 'not-registered';
    },
  });
  const preference = { value: options.preference ?? 'off' };
  const prefListeners: ((change: PreferenceChange) => void)[] = [];
  const connectionListeners: ((connection: CalendarConnection | null) => void)[] = [];
  const trays = { created: 0, menus: [] as TrayMenuItem[][], destroyed: 0 };
  class FakeTray {
    constructor() {
      trays.created += 1;
    }
    setImage = () => undefined;
    setToolTip = () => undefined;
    setContextMenu = (menu: { items: TrayMenuItem[] }) => void trays.menus.push(menu.items);
    destroy = () => void (trays.destroyed += 1);
  }
  const navigated: string[] = [];
  const shown: string[] = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => void shown.push('show'),
    focus: () => void shown.push('focus'),
    restore: () => undefined,
    webContents: { id: 7, send: () => undefined },
  };
  const handlers = new Map<string, unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: () => undefined,
  };
  const deps: KeepRunningDeps = {
    app,
    electron: {
      // The test's stand-ins for Electron's classes, as far as the tray view calls them.
      Tray: FakeTray as unknown as KeepRunningDeps['electron']['Tray'],
      Menu: { buildFromTemplate: (items) => ({ items }) as never },
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) as never },
    },
    build: { isPackaged: options.isPackaged, e2eOn: options.e2eOn ?? false },
    resourcesPath: '/Applications/Roger.app/Contents/Resources',
    capture: {
      phase: 'idle',
      on: () => () => undefined,
      requestStart: () => undefined,
      stop: () => Promise.resolve(),
    },
    calendar: {
      account: {
        onConnectionChange: (listener) => {
          connectionListeners.push(listener);
          return () => undefined;
        },
      },
      sync: {
        getState: () => ({
          lastSuccessAt: null,
          lastError: null,
          staleSince: null,
          reconnectRequired: false,
        }),
        onStateChange: () => () => undefined,
        onEventsChange: () => () => undefined,
      },
      cache: { listEvents: () => [] },
    },
    preferences: {
      get: () => preference.value,
      onChange: (listener) => {
        prefListeners.push(listener);
        return () => undefined;
      },
    },
    appPath: '/repo/apps/desktop',
    ipcMain,
    getWindow: () => window,
    navigate: (route) => void navigated.push(route),
    logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
  };
  return {
    app,
    mac,
    deps,
    trays,
    navigated,
    shown,
    handlers,
    preference,
    setPreference: (value: OpenAtLogin) => {
      preference.value = value;
      for (const listener of prefListeners) listener({ key: 'app.openAtLogin', value });
    },
    emitPreference: (change: PreferenceChange) => {
      for (const listener of prefListeners) listener(change);
    },
    click: (label: string) => {
      const item = trays.menus.at(-1)?.find((each) => each.label === label);
      if (item?.click === undefined) throw new Error(`no clickable "${label}" in the tray menu`);
      item.click();
    },
    connect: (next: CalendarConnection | null) => {
      for (const listener of connectionListeners) listener(next);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startKeepRunning', () => {
  it('keeps Roger running when the last window goes, and shows the window on reopen', () => {
    const h = setup({ isPackaged: false });
    startKeepRunning(h.deps);
    h.app.emit('window-all-closed');
    expect(h.app.quits).toBe(0);
    h.app.emit('activate');
    expect(h.shown).toEqual(['show', 'focus']);
  });

  it('puts the tray in the menu bar, with the calendar, and Quit calls app.quit()', () => {
    const h = setup({ isPackaged: false });
    startKeepRunning(h.deps);
    expect(h.trays.created).toBe(1);
    h.click('Quit Roger');
    expect(h.app.quits).toBe(1);
  });

  it('opens Settings for a reconnect and brings the window forward', () => {
    const h = setup({ isPackaged: false });
    startKeepRunning(h.deps);
    h.connect({ ...connection, status: 'reconnect_required' });
    h.click('Reconnect Google Calendar');
    expect(h.navigated).toEqual(['settings']);
    expect(h.shown).toEqual(['show', 'focus']);
  });

  it('answers the page its login item state', () => {
    const h = setup({ isPackaged: false });
    startKeepRunning(h.deps);
    expect([...h.handlers.keys()]).toEqual(['login-item:get-state']);
  });

  it('registers no login item in a build that is not packaged, whatever is chosen', () => {
    const h = setup({ isPackaged: false, preference: 'on' });
    startKeepRunning(h.deps);
    h.setPreference('on');
    h.connect(connection);
    expect(h.app.sets).toEqual([]);
  });

  it('registers none in the e2e run either', () => {
    const h = setup({ isPackaged: true, e2eOn: true, preference: 'on' });
    startKeepRunning(h.deps);
    expect(h.app.sets).toEqual([]);
  });

  it('follows the preference and the calendar connection in a packaged build', () => {
    const h = setup({ isPackaged: true, preference: 'off' });
    startKeepRunning(h.deps);
    expect(h.app.sets).toEqual([]);
    h.setPreference('on');
    expect(h.app.sets).toEqual([true]);
    h.setPreference('off');
    expect(h.app.sets).toEqual([true, false]);
    h.setPreference('auto');
    h.connect(connection);
    expect(h.app.sets).toEqual([true, false, true]);
  });

  it('ignores every other preference', () => {
    const h = setup({ isPackaged: true, preference: 'on' });
    startKeepRunning(h.deps);
    const sets = h.app.sets.length;
    h.mac.status = 'not-registered';
    h.emitPreference({ key: 'theme', value: 'dark' });
    expect(h.app.sets.length).toBe(sets);
  });
});
