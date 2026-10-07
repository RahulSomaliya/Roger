import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, TimedCalendarEvent } from '../../shared/calendar';
import { idleCaptureStatus, type StartCaptureRequest } from '../../shared/capture';
import { APP_PREFERENCES } from '../../shared/preferences';
import type { StartRequestEnricher } from '../capture/CaptureService';
import { createLogger } from '../logger';
import { PreferencesStore } from '../preferences/PreferencesStore';
import {
  createCalendarRuntime,
  createStartRequestEnricher,
  meetingAttendees,
  type CalendarRuntimeDeps,
  type CalendarWindow,
} from './createCalendarRuntime';
import type { CalendarApiPort } from './ports';
import { SqliteCalendarCache } from './SqliteCalendarCache';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-06T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ACCOUNT = 'rahul@linkt.ai';
const silent = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function call(id: string, minutes: number, overrides: Partial<TimedCalendarEvent> = {}) {
  const event: TimedCalendarEvent = {
    provider: 'fake',
    id,
    icalUid: null,
    recurringEventId: null,
    title: `Call ${id}`,
    status: 'confirmed',
    allDay: false,
    start: iso(NOW + minutes * MINUTE),
    end: iso(NOW + (minutes + 30) * MINUTE),
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [
      {
        email: 'jane@example.com',
        displayName: 'Jane',
        responseStatus: 'accepted',
        isSelf: false,
        isOrganizer: true,
      },
    ],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    ...overrides,
  };
  return event;
}

describe('createStartRequestEnricher', () => {
  const enrich = (events: CalendarEvent[], request: StartCaptureRequest): StartCaptureRequest =>
    createStartRequestEnricher({ events: () => events, clock: () => new Date(NOW) })(request);

  it('links the one call that is running or starts within 5 minutes, with its title', () => {
    expect(enrich([call('running', -10)], { source: 'tray' })).toMatchObject({
      source: 'tray',
      title: 'Call running',
      calendarEvent: { eventId: 'running' },
    });
    expect(enrich([call('soon', 5)], {}).calendarEvent?.eventId).toBe('soon');
    // Not yet 5 minutes away, and not over: nothing to link.
    expect(enrich([call('later', 6)], {})).toEqual({});
    expect(enrich([call('over', -30)], {})).toEqual({});
  });

  it('links nothing for two calls at once, and skips what never gets a prompt', () => {
    expect(enrich([call('a', 0), call('b', 3)], {})).toEqual({});
    // Declined, and a block with nobody else on it: neither is a call.
    const declined = call('declined', 0, { selfResponse: 'declined' });
    const solo = call('solo', 0, { attendees: [] });
    expect(enrich([declined, solo], {})).toEqual({});
    expect(enrich([declined, call('real', 0)], {}).calendarEvent?.eventId).toBe('real');
  });

  it('leaves a request that names an event alone, and a title the user typed', () => {
    const named = enrich([call('running', 0)], { title: 'Mine' });
    expect(named).toMatchObject({ title: 'Mine', calendarEvent: { eventId: 'running' } });

    const linked = enrich([], {});
    expect(linked).toEqual({});
    const withEvent: StartCaptureRequest = {
      source: 'notification',
      calendarEvent: named.calendarEvent ?? null,
    };
    expect(enrich([call('other', 1)], withEvent)).toBe(withEvent);
  });

  it('keeps a blank title blank when the invite has none either', () => {
    const untitled = enrich([call('x', 0, { title: '' })], { title: '   ' });
    expect(untitled.title).toBe('   ');
    expect(untitled.calendarEvent?.eventId).toBe('x');
    expect(enrich([call('y', 0)], { title: '  ' }).title).toBe('Call y');
  });
});

describe('meetingAttendees', () => {
  it('reads the invitees off the local meeting, and none for a start with no event', () => {
    const attendees = call('a', 0).attendees;
    const read = meetingAttendees({
      getMeeting: (id) =>
        id === 'linked'
          ? {
              id,
              title: 'T',
              startedAt: iso(NOW),
              endedAt: null,
              remoteState: 'pending',
              startSource: 'notification',
              calendarEvent: {
                provider: 'fake',
                eventId: 'a',
                icalUid: null,
                recurringEventId: null,
                scheduledStart: iso(NOW),
                scheduledEnd: iso(NOW + MINUTE),
                attendees,
              },
            }
          : id === 'manual'
            ? {
                id,
                title: 'T',
                startedAt: iso(NOW),
                endedAt: null,
                remoteState: 'pending',
                startSource: 'manual',
                calendarEvent: null,
              }
            : null,
    });
    expect(read('linked')).toEqual(attendees);
    expect(read('manual')).toEqual([]);
    expect(read('no such meeting')).toEqual([]);
  });
});

describe('createCalendarRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function build(overrides: Partial<CalendarRuntimeDeps> = {}) {
    const cache = new SqliteCalendarCache(':memory:');
    const enrichers: StartRequestEnricher[] = [];
    const status = idleCaptureStatus({
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    const api: CalendarApiPort = {
      createGoogleAuthorization: () => Promise.reject(new Error('unused')),
      connectGoogle: () => Promise.reject(new Error('unused')),
      getConnection: () =>
        Promise.resolve({
          provider: 'fake',
          accountEmail: ACCOUNT,
          status: 'active',
          connectedAt: iso(NOW - 60 * MINUTE),
          expiresHint: null,
          lastError: null,
        }),
      disconnect: () => Promise.resolve(),
      listEvents: () => Promise.reject(new Error('unused')),
    };
    const preferences = new PreferencesStore({
      path: '/preferences.json',
      logger: silent,
      files: {
        readFileSync: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        writeFileSync: () => undefined,
        renameSync: () => undefined,
      },
    });
    preferences.register(APP_PREFERENCES);
    const powerMonitor = new EventEmitter();
    const focusListeners: ((event: unknown, window: object) => void)[] = [];
    const mainWindow: CalendarWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      showInactive: () => undefined,
      webContents: { id: 7, send: () => undefined },
    };
    const deps: CalendarRuntimeDeps = {
      cache,
      apiConnection: { baseUrl: 'http://api.invalid', token: 't' },
      api,
      preferences,
      store: { findMeetingIdsByEventIds: () => new Map() },
      capture: {
        phase: 'idle',
        getStatus: () => status,
        on: () => () => undefined,
        stop: () => Promise.resolve(status),
        requestStart: () => undefined,
        takePendingStart: () => null,
        setStartRequestEnricher: (enricher) => {
          enrichers.push(enricher);
        },
      },
      navigation: { navigate: () => undefined },
      ipcMain: { handle: () => undefined, on: () => undefined },
      getWindow: () => mainWindow,
      openWindow: () => undefined,
      electron: {
        app: {
          on: (_event, listener) => {
            focusListeners.push(listener);
          },
        },
        powerMonitor,
        powerSaveBlocker: { start: () => 1, stop: () => undefined },
        shell: { openExternal: () => Promise.resolve() },
      },
      logger: silent,
      ...overrides,
    };
    return { cache, api, deps, enrichers, powerMonitor, focusListeners, mainWindow, preferences };
  }

  it("sets the start-request enricher once, reading this Mac's copy of the calendar", () => {
    const h = build();
    h.cache.recordConnected(ACCOUNT, iso(NOW - 60 * MINUTE));
    h.cache.replaceEvents([call('running', 0)], iso(NOW));
    createCalendarRuntime(h.deps);

    expect(h.enrichers).toHaveLength(1);
    expect(h.enrichers[0]?.({})).toMatchObject({ calendarEvent: { eventId: 'running' } });
  });

  it('registers the calendar preferences before anything reads them', () => {
    const h = build();
    expect(() => h.preferences.get('calendar.reminderLeadMinutes')).toThrow(/unknown preference/);
    createCalendarRuntime(h.deps);
    expect(h.preferences.get('calendar.reminderLeadMinutes')).toBe(1);
  });

  it('refreshes the calendar when the main window gains focus, and for no other window', async () => {
    const h = build();
    h.cache.recordConnected(ACCOUNT, iso(NOW - 60 * MINUTE));
    const listEvents = vi.fn<CalendarApiPort['listEvents']>(() =>
      Promise.resolve({ items: [], fetchedAt: iso(Date.now()) }),
    );
    createCalendarRuntime({ ...h.deps, api: { ...h.api, listEvents } });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(1);
    // Past the 30 s focus throttle.
    await vi.advanceTimersByTimeAsync(31_000);

    for (const focus of h.focusListeners) focus({}, { id: 'the prompt panel' });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(1);

    for (const focus of h.focusListeners) focus({}, h.mainWindow);
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it('refreshes the calendar when the Mac wakes', async () => {
    const h = build();
    h.cache.recordConnected(ACCOUNT, iso(NOW - 60 * MINUTE));
    const listEvents = vi.fn<CalendarApiPort['listEvents']>(() =>
      Promise.resolve({ items: [], fetchedAt: iso(Date.now()) }),
    );
    createCalendarRuntime({ ...h.deps, api: { ...h.api, listEvents } });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(1);

    h.powerMonitor.emit('resume');
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it('stops the calendar at quit, waits for the account, and only then closes calendar.sqlite', async () => {
    const h = build();
    const order: string[] = [];
    let finishExchange = (): void => undefined;
    const getConnection = vi.fn<CalendarApiPort['getConnection']>(
      () =>
        new Promise((resolve) => {
          order.push('exchange started');
          finishExchange = () => {
            order.push('exchange answered');
            resolve(null);
          };
        }),
    );
    const runtime = createCalendarRuntime({ ...h.deps, api: { ...h.api, getConnection } });
    const close = vi.spyOn(h.cache, 'close').mockImplementation(() => {
      order.push('cache closed');
    });
    await vi.advanceTimersByTimeAsync(0);

    const stopped = runtime.stop().then(() => order.push('stopped'));
    await vi.advanceTimersByTimeAsync(0);
    // The read the account sent is still out: nothing closes under it.
    expect(close).not.toHaveBeenCalled();
    finishExchange();
    await stopped;
    expect(order).toEqual(['exchange started', 'exchange answered', 'cache closed', 'stopped']);
  });
});
