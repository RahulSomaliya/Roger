import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnection, CalendarEvent, CalendarSyncState } from '../../shared/calendar';
import type { CapturePhase, StartCaptureRequest } from '../../shared/capture';
import { createLogger } from '../logger';
import {
  MenuBarTray,
  TRAY_ICON_BUNDLE_DIR,
  TRAY_ICON_FILES,
  trayIconPath,
  type TrayCalendarSource,
  type TrayCapture,
  type TrayMenuItem,
} from './tray';
import { createTrayFormat, type TrayIconState } from './trayMenu';

const NOW = Date.parse('2026-10-06T09:00:00.000Z');
const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-06T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};
const fresh: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T08:55:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};
const meeting: CalendarEvent = {
  provider: 'google',
  id: 'a',
  icalUid: null,
  recurringEventId: null,
  title: 'Acme renewal',
  status: 'confirmed',
  allDay: false,
  start: '2026-10-06T10:00:00.000Z',
  end: '2026-10-06T10:30:00.000Z',
  startDate: null,
  endDate: null,
  selfResponse: 'accepted',
  attendees: [],
  attendeesOmitted: false,
  videoLink: null,
  videoLinkSource: null,
  htmlLink: null,
};

function fakeView() {
  const view = {
    icons: [] as string[],
    tooltips: [] as string[],
    menus: [] as TrayMenuItem[][],
    destroyed: 0,
    setIcon: (path: string) => void view.icons.push(path),
    setToolTip: (text: string) => void view.tooltips.push(text),
    setMenu: (items: TrayMenuItem[]) => void view.menus.push(items),
    destroy: () => void (view.destroyed += 1),
    get labels(): string[] {
      return (view.menus.at(-1) ?? []).flatMap((item) =>
        item.label === undefined ? [] : [item.label],
      );
    },
    /** Clicks the item with this label, as the user does in the menu. */
    click: (label: string) => {
      const item = view.menus.at(-1)?.find((each) => each.label === label);
      if (item?.click === undefined)
        throw new Error(`no clickable "${label}" in ${view.labels.join(' | ')}`);
      item.click();
    },
  };
  return view;
}

function fakeCapture() {
  const listeners = new Set<() => void>();
  const capture = {
    phase: 'idle' as CapturePhase,
    starts: [] as StartCaptureRequest[],
    stops: 0,
    failStart: null as Error | null,
    on: (_event: 'status', listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    requestStart: (request: StartCaptureRequest) => {
      if (capture.failStart !== null) throw capture.failStart;
      capture.starts.push(request);
    },
    stop: () => {
      capture.stops += 1;
      return Promise.resolve();
    },
    setPhase: (phase: CapturePhase) => {
      capture.phase = phase;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  } satisfies TrayCapture & Record<string, unknown>;
  return capture;
}

function fakeCalendar(events: CalendarEvent[] = [meeting]) {
  const listeners = {
    connection: new Set<(c: CalendarConnection | null) => void>(),
    events: new Set<(e: CalendarEvent[]) => void>(),
    state: new Set<(s: CalendarSyncState) => void>(),
  };
  const track =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener);
      return () => void set.delete(listener);
    };
  const copy: { events: CalendarEvent[]; state: CalendarSyncState } = { events, state: fresh };
  const calendar = {
    copy,
    account: { onConnectionChange: track(listeners.connection) },
    sync: {
      getState: () => copy.state,
      onStateChange: track(listeners.state),
      onEventsChange: track(listeners.events),
    },
    cache: { listEvents: () => copy.events },
    emitConnection: (next: CalendarConnection | null) => {
      listeners.connection.forEach((l) => {
        l(next);
      });
    },
    emitEvents: (next: CalendarEvent[]) => {
      listeners.events.forEach((l) => {
        l(next);
      });
    },
    emitState: (next: CalendarSyncState) => {
      listeners.state.forEach((l) => {
        l(next);
      });
    },
    listenerCount: () => listeners.connection.size + listeners.events.size + listeners.state.size,
  } satisfies TrayCalendarSource & Record<string, unknown>;
  return calendar;
}

function setup(options: { calendar?: ReturnType<typeof fakeCalendar> | null } = {}) {
  const view = fakeView();
  const capture = fakeCapture();
  const calendar = options.calendar === undefined ? fakeCalendar() : options.calendar;
  const calls: string[] = [];
  const lines: string[] = [];
  const clock = { ms: NOW };
  const tray = new MenuBarTray({
    view,
    iconPath: (state: TrayIconState) => `/icons/${state}.png`,
    capture,
    calendar,
    actions: {
      open: () => calls.push('open'),
      reconnect: () => calls.push('reconnect'),
      quit: () => calls.push('quit'),
    },
    now: () => clock.ms,
    format: createTrayFormat('Asia/Kolkata'),
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
  });
  return { tray, view, capture, calendar, calls, lines, clock };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MenuBarTray', () => {
  it('shows an idle icon and the menu when it starts', () => {
    const h = setup();
    h.tray.start();
    expect(h.view.icons).toEqual(['/icons/idle.png']);
    expect(h.view.tooltips).toEqual(['Roger']);
    expect(h.view.labels).toEqual(['Start notes now', 'Open Roger', 'Quit Roger']);
  });

  it('shows the next meeting once the calendar is connected, and follows its changes', () => {
    const h = setup();
    h.tray.start();
    h.calendar?.emitConnection(connection);
    expect(h.view.labels[0]).toBe('Next: Acme renewal, 15:30');

    h.calendar?.emitEvents([]);
    expect(h.view.labels[0]).toBe('No upcoming meetings');

    h.calendar?.emitState({ ...fresh, staleSince: '2026-10-06T04:42:00.000Z' });
    expect(h.view.labels).toContain('Calendar not updated since 14:25');
    expect(h.view.icons.at(-1)).toBe('/icons/warning.png');

    h.calendar?.emitConnection(null);
    expect(h.view.labels[0]).toBe('Start notes now');
  });

  it('reads the copy as it stands at launch', () => {
    const h = setup({ calendar: fakeCalendar([meeting]) });
    h.tray.start();
    h.calendar?.emitConnection(connection);
    expect(h.view.labels[0]).toBe('Next: Acme renewal, 15:30');
  });

  it('turns the icon to recording and offers Stop note while a note is taken', () => {
    const h = setup();
    h.tray.start();
    h.capture.setPhase('recording');
    expect(h.view.icons.at(-1)).toBe('/icons/recording.png');
    expect(h.view.labels).toContain('Stop note');
    h.capture.setPhase('idle');
    expect(h.view.icons.at(-1)).toBe('/icons/idle.png');
  });

  it('does not rebuild the menu for a status change that changes nothing', () => {
    const h = setup();
    h.tray.start();
    const menus = h.view.menus.length;
    h.capture.setPhase('idle');
    h.capture.setPhase('idle');
    expect(h.view.menus).toHaveLength(menus);
  });

  it('turns Next into Now when the meeting starts, with no event to say so', () => {
    const h = setup();
    h.tray.start();
    h.calendar?.emitConnection(connection);
    h.clock.ms = Date.parse('2026-10-06T10:00:30.000Z');
    vi.advanceTimersByTime(60_000);
    expect(h.view.labels[0]).toBe('Now: Acme renewal');
  });

  it('starts a note as the tray, through the window that captures the audio', () => {
    const h = setup();
    h.tray.start();
    h.view.click('Start notes now');
    expect(h.capture.starts).toEqual([{ source: 'tray' }]);
  });

  it('stops the note through the normal stop, with no stop of its own on quit', () => {
    const h = setup();
    h.tray.start();
    h.capture.setPhase('recording');
    h.view.click('Stop note');
    expect(h.capture.stops).toBe(1);
    h.view.click('Quit Roger');
    // Quit goes through app.quit(), where RecordingLifecycle stops the recording; none here.
    expect(h.capture.stops).toBe(1);
    expect(h.calls).toEqual(['quit']);
  });

  it('opens Roger, and reconnects through Settings', () => {
    const h = setup();
    h.tray.start();
    h.calendar?.emitConnection({ ...connection, status: 'reconnect_required' });
    h.view.click('Reconnect Google Calendar');
    h.view.click('Open Roger');
    expect(h.calls).toEqual(['reconnect', 'open']);
  });

  it('logs a start it cannot make and carries on', () => {
    const h = setup();
    h.tray.start();
    h.capture.failStart = new Error('title is too long');
    expect(() => {
      h.view.click('Start notes now');
    }).not.toThrow();
    expect(h.lines.some((line) => line.includes('title is too long'))).toBe(true);
  });

  it('logs a stop that fails', async () => {
    const h = setup();
    h.tray.start();
    h.capture.setPhase('recording');
    h.capture.stop = () => Promise.reject(new Error('vendor hung'));
    h.view.click('Stop note');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lines.some((line) => line.includes('vendor hung'))).toBe(true);
  });

  it('works without a calendar: no meeting lines, and no calendar listeners', () => {
    const h = setup({ calendar: null });
    h.tray.start();
    expect(h.view.labels).toEqual(['Start notes now', 'Open Roger', 'Quit Roger']);
  });

  it('removes the icon and every listener and timer when stopped', () => {
    const h = setup();
    h.tray.start();
    h.tray.stop();
    expect(h.view.destroyed).toBe(1);
    expect(h.capture.listenerCount()).toBe(0);
    expect(h.calendar?.listenerCount()).toBe(0);
    const menus = h.view.menus.length;
    vi.advanceTimersByTime(120_000);
    expect(h.view.menus).toHaveLength(menus);
  });

  it('keeps the menu it has when a rebuild fails, and logs why', () => {
    const h = setup();
    h.tray.start();
    h.view.setMenu = () => {
      throw new Error('menu refused');
    };
    h.capture.setPhase('recording');
    expect(h.lines.some((line) => line.includes('menu refused'))).toBe(true);
  });
});

// The icon files are named in three places: this table, build/, and electron-builder.yml's
// extraResources. A rename in one alone ships a menu bar item with no icon.
describe('the menu bar icon files', () => {
  const desktop = new URL('../../../', import.meta.url).pathname;

  it('exist beside their @2x, named Template so macOS tints them for a dark menu bar', () => {
    for (const file of Object.values(TRAY_ICON_FILES)) {
      expect(file).toMatch(/Template\.png$/);
      expect(existsSync(join(desktop, 'build', file))).toBe(true);
      expect(existsSync(join(desktop, 'build', file.replace('.png', '@2x.png')))).toBe(true);
    }
  });

  it('are bundled by electron-builder.yml to the folder the packaged app reads', () => {
    const builder = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8');
    expect(builder).toMatch(
      new RegExp(
        `- from: build\\n\\s+to: ${TRAY_ICON_BUNDLE_DIR}\\n\\s+filter:\\n\\s+- tray\\*Template\\*\\.png\\n`,
      ),
    );
  });

  it('are read from Resources/tray when packaged and from build/ in a dev run', () => {
    const where = {
      resourcesPath: '/Applications/Roger.app/Contents/Resources',
      appPath: '/repo/apps/desktop',
    };
    expect(trayIconPath('recording', { ...where, isPackaged: true })).toBe(
      '/Applications/Roger.app/Contents/Resources/tray/trayRecordingTemplate.png',
    );
    expect(trayIconPath('idle', { ...where, isPackaged: false })).toBe(
      '/repo/apps/desktop/build/trayTemplate.png',
    );
  });
});
