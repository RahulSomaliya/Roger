import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalendarEvent,
  CalendarEventsPage,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../shared/calendar';
import { ApiError } from '../api/http';
import { createLogger, type Logger } from '../logger';
import {
  CALENDAR_CATCH_UP_MAX_MS,
  CALENDAR_FOCUS_THROTTLE_MS,
  CALENDAR_POLL_INTERVAL_MS,
  CALENDAR_STALE_AFTER_MS,
  CalendarSync,
  type CalendarCatchUp,
} from './CalendarSync';
import type { CalendarApiPort, CalendarWindow } from './ports';
import { cacheKey, SqliteCalendarCache } from './SqliteCalendarCache';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-06T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ACCOUNT = 'rahul@linkt.ai';

const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function call(id: string, start: string, overrides: Partial<TimedCalendarEvent> = {}) {
  const event: TimedCalendarEvent = {
    provider: 'fake',
    id,
    icalUid: `${id}@google.com`,
    recurringEventId: null,
    title: `Call ${id}`,
    status: 'confirmed',
    allDay: false,
    start,
    end: iso(Date.parse(start) + 30 * MINUTE),
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

const page = (items: CalendarEvent[]): CalendarEventsPage => ({
  items,
  fetchedAt: new Date().toISOString(),
});

const down = (): ApiError => new ApiError(0, 'network_error', 'GET /v1/calendar/events failed');
const refused = (): ApiError =>
  new ApiError(
    424,
    'calendar_reconnect_required',
    'Google refused the calendar grant. Reconnect Google Calendar in Settings.',
  );

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  cache: SqliteCalendarCache;
  /** The API's `listEvents`; set its answers with the usual mock helpers. */
  listEvents: ReturnType<typeof vi.fn<CalendarApiPort['listEvents']>>;
  sync: CalendarSync;
  /** The minutes after START at which each request went out, whatever answered it. */
  requestMinutes: () => number[];
  windows: () => CalendarWindow[];
}

function harness(options: { connectedAt?: number | null; logger?: Logger } = {}): Harness {
  const cache = new SqliteCalendarCache(':memory:');
  const connectedAt = options.connectedAt === undefined ? START : options.connectedAt;
  if (connectedAt !== null) cache.recordConnected(ACCOUNT, iso(connectedAt));
  const requestTimes: number[] = [];
  const listEvents = vi.fn<CalendarApiPort['listEvents']>(() => Promise.resolve(page([])));
  const sync = new CalendarSync({
    api: {
      listEvents: (window) => {
        requestTimes.push(Date.now());
        return listEvents(window);
      },
    },
    cache,
    logger: options.logger ?? silentLogger,
  });
  return {
    cache,
    listEvents,
    sync,
    requestMinutes: () => requestTimes.map((at) => (at - START) / MINUTE),
    windows: () => listEvents.mock.calls.map(([window]) => window),
  };
}

describe('CalendarSync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes at launch, every 5 min, on wake, and on focus at most every 30 s', async () => {
    const { sync, listEvents } = harness();
    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS - 1);
    expect(listEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listEvents).toHaveBeenCalledTimes(2);

    sync.onWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10 * SECOND);
    sync.onWindowFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(CALENDAR_FOCUS_THROTTLE_MS - 10 * SECOND);
    sync.onWindowFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(4);

    // Any refresh restarts the 5-minute wait.
    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS - 1);
    expect(listEvents).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(listEvents).toHaveBeenCalledTimes(5);

    sync.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    sync.onWake();
    expect(listEvents).toHaveBeenCalledTimes(5);
  });

  it('asks for now - 36 h to now + 36 h, moving with the clock', async () => {
    const { sync, windows } = harness();
    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);

    expect(windows()).toEqual([
      { from: '2026-10-04T20:00:00.000Z', to: '2026-10-07T20:00:00.000Z' },
      { from: '2026-10-04T20:05:00.000Z', to: '2026-10-07T20:05:00.000Z' },
    ]);
    sync.stop();
  });

  it('does not poll while no calendar is connected; connecting refreshes at once', async () => {
    const { sync, listEvents, cache } = harness({ connectedAt: null });
    sync.start({ previousRunLastTickAt: iso(START - HOUR) });
    sync.onWake();
    sync.onWindowFocus();
    await expect(sync.ensureFresh(2 * MINUTE)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(listEvents).not.toHaveBeenCalled();
    expect(sync.getState().staleSince).toBeNull();

    listEvents.mockResolvedValueOnce(page([call('a', '2026-10-06T10:00:00Z')]));
    await sync.connected(ACCOUNT);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(cache.listEvents().map((event) => event.id)).toEqual(['a']);
    expect(cache.activeConnection()?.accountEmail).toBe(ACCOUNT);

    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);
    expect(listEvents).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  describe('catch-up at launch', () => {
    it('fetches from the last tick (less the 10 min a prompt stays open) to launch, before the refresh', async () => {
      const { sync, listEvents, windows, cache } = harness();
      const missed = call('missed', '2026-10-06T07:00:00Z');
      const upcoming = call('upcoming', '2026-10-06T10:00:00Z');
      // The previous run's copy, from its last refresh.
      cache.replaceEvents([missed], '2026-10-06T05:58:00.000Z');
      listEvents.mockResolvedValueOnce(page([missed])).mockResolvedValueOnce(page([upcoming]));
      const catchUps: CalendarCatchUp[] = [];
      const cachedDuringCatchUp: string[][] = [];
      sync.onCatchUp((catchUp) => {
        catchUps.push(catchUp);
        cachedDuringCatchUp.push(cache.listEvents().map((event) => event.id));
      });

      sync.start({ previousRunLastTickAt: '2026-10-06T06:00:00.000Z' });
      await vi.advanceTimersByTimeAsync(0);

      expect(windows()[0]).toEqual({
        from: '2026-10-06T05:50:00.000Z',
        to: '2026-10-06T08:00:00.000Z',
      });
      expect(catchUps).toEqual([
        { from: '2026-10-06T05:50:00.000Z', to: '2026-10-06T08:00:00.000Z', events: [missed] },
      ]);
      // The listener reads the previous run's copy: first sightings are still there to judge by.
      expect(cachedDuringCatchUp).toEqual([['missed']]);
      // It feeds the missed-prompt log only, never the copy.
      expect(cache.listEvents().map((event) => event.id)).toEqual(['upcoming']);
      expect(listEvents).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);
      expect(catchUps).toHaveLength(1);
      sync.stop();
    });

    it('reaches back at most 6 days, inside the API 7-day limit', async () => {
      const { sync, windows } = harness();
      sync.start({ previousRunLastTickAt: iso(START - 10 * DAY) });
      await vi.advanceTimersByTimeAsync(0);

      expect(windows()[0]).toEqual({ from: iso(START - CALENDAR_CATCH_UP_MAX_MS), to: iso(START) });
      expect(CALENDAR_CATCH_UP_MAX_MS).toBe(6 * DAY);
      sync.stop();
    });

    it('skips the catch-up on a first launch and after a clock that went back', async () => {
      for (const previousRunLastTickAt of [null, iso(START + HOUR)]) {
        const { sync, listEvents } = harness();
        sync.start({ previousRunLastTickAt });
        await vi.advanceTimersByTimeAsync(0);
        expect(listEvents).toHaveBeenCalledTimes(1);
        expect(listEvents.mock.calls[0]?.[0].from).toBe('2026-10-04T20:00:00.000Z');
        sync.stop();
      }
    });

    it('retries a failed catch-up with the next refresh, for the same window', async () => {
      const { sync, listEvents, windows } = harness();
      listEvents.mockRejectedValueOnce(down());
      const catchUps: CalendarCatchUp[] = [];
      sync.onCatchUp((catchUp) => catchUps.push(catchUp));

      sync.start({ previousRunLastTickAt: '2026-10-06T06:00:00.000Z' });
      await vi.advanceTimersByTimeAsync(0);
      expect(catchUps).toEqual([]);

      await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);
      expect(catchUps).toHaveLength(1);
      expect(windows()[2]).toEqual({
        from: '2026-10-06T05:50:00.000Z',
        to: '2026-10-06T08:00:00.000Z',
      });
      sync.stop();
    });
  });

  it('replaces the copy in one go: a deleted event goes, a kept one keeps its first sighting', async () => {
    const { sync, listEvents, cache } = harness();
    const kept = call('kept', '2026-10-06T10:00:00Z');
    const deleted = call('deleted', '2026-10-06T11:00:00Z');
    const added = call('added', '2026-10-06T12:00:00Z');
    listEvents
      .mockResolvedValueOnce(page([kept, deleted]))
      .mockResolvedValueOnce(page([kept, added]));
    const lists: string[][] = [];
    sync.onEventsChange((events) => lists.push(events.map((event) => event.id)));

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);

    expect(cache.listEvents()).toEqual([kept, added]);
    expect(cache.firstSeenAt(cacheKey(kept))).toBe(iso(START));
    expect(cache.firstSeenAt(cacheKey(added))).toBe(iso(START + CALENDAR_POLL_INTERVAL_MS));
    expect(cache.firstSeenAt(cacheKey(deleted))).toBeNull();
    expect(lists).toEqual([
      ['kept', 'deleted'],
      ['kept', 'added'],
    ]);
    sync.stop();
  });

  it('keeps the last good list with its time when a refresh fails or its answer is bad', async () => {
    const { sync, listEvents, cache } = harness();
    const good = call('good', '2026-10-06T10:00:00Z');
    listEvents
      .mockResolvedValueOnce(page([good]))
      .mockRejectedValueOnce(down())
      // A local time with no zone: one bad event fails the whole answer, never half of it.
      .mockResolvedValueOnce(
        page([call('other', '2026-10-06T11:00:00Z'), call('bad', '2026-10-06T12:00:00')]),
      );

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);
    expect(cache.listEvents()).toEqual([good]);
    expect(sync.getState()).toEqual({
      lastSuccessAt: iso(START),
      lastError: 'GET /v1/calendar/events failed',
      staleSince: null,
      reconnectRequired: false,
    });

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(listEvents).toHaveBeenCalledTimes(3);
    expect(cache.listEvents()).toEqual([good]);
    expect(sync.getState().lastSuccessAt).toBe(iso(START));
    expect(sync.getState().lastError).toMatch(/Not an ISO 8601 instant/);
    sync.stop();
  });

  it('backs off x2 up to 30 min after failures, and a success resets it', async () => {
    const { sync, listEvents, cache, requestMinutes } = harness();
    // Already stale, so the stale check adds no request of its own to the sequence.
    cache.markStale(iso(START));
    listEvents.mockRejectedValue(down());

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(121 * MINUTE);
    expect(requestMinutes()).toEqual([0, 1, 3, 7, 15, 31, 61, 91, 121]);

    listEvents.mockResolvedValue(page([]));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(requestMinutes().slice(-1)).toEqual([151]);
    expect(sync.getState().lastError).toBeNull();

    // After a success the next poll waits 5 min, and the next failure starts again at 1 min.
    listEvents.mockRejectedValue(down());
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(requestMinutes().slice(-2)).toEqual([156, 157]);
    sync.stop();
  });

  it('stops polling on 424 until the next connect', async () => {
    const { sync, listEvents } = harness();
    listEvents.mockRejectedValue(refused());
    const states: CalendarSyncState[] = [];
    sync.onStateChange((state) => states.push(state));

    sync.start({ previousRunLastTickAt: '2026-10-06T06:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(0);
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(sync.getState()).toMatchObject({
      reconnectRequired: true,
      lastError: 'Google refused the calendar grant. Reconnect Google Calendar in Settings.',
    });
    expect(states.at(-1)?.reconnectRequired).toBe(true);

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    sync.onWake();
    sync.onWindowFocus();
    await expect(sync.ensureFresh(2 * MINUTE)).resolves.toBe(false);
    expect(listEvents).toHaveBeenCalledTimes(1);

    listEvents.mockResolvedValue(page([]));
    await sync.connected(ACCOUNT);
    // The catch-up the 424 interrupted, then the refresh.
    expect(listEvents).toHaveBeenCalledTimes(3);
    expect(sync.getState()).toMatchObject({ reconnectRequired: false, lastError: null });

    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);
    expect(listEvents).toHaveBeenCalledTimes(4);
    sync.stop();
  });

  it('tries once at launch although the last run ended on a 424', async () => {
    const { sync, listEvents, cache } = harness();
    cache.markReconnectRequired('Reconnect Google Calendar', iso(START - HOUR));

    sync.start({ previousRunLastTickAt: null });
    // The mark shows at once, before the API answers.
    expect(sync.getState().reconnectRequired).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(sync.getState().reconnectRequired).toBe(false);
    sync.stop();
  });

  it('shares one request between the triggers that arrive while it runs', async () => {
    const { sync, listEvents } = harness();
    const answer = deferred<CalendarEventsPage>();
    listEvents.mockReturnValueOnce(answer.promise);

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(0);
    sync.onWake();
    await vi.advanceTimersByTimeAsync(CALENDAR_FOCUS_THROTTLE_MS);
    sync.onWindowFocus();
    const beforePrompt = sync.ensureFresh(2 * MINUTE);
    const beforeAnotherPrompt = sync.ensureFresh(2 * MINUTE);
    expect(listEvents).toHaveBeenCalledTimes(1);

    answer.resolve(page([call('a', '2026-10-06T10:00:00Z')]));
    await expect(beforePrompt).resolves.toBe(true);
    await expect(beforeAnotherPrompt).resolves.toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('refreshes before a prompt only when the copy is older than asked', async () => {
    const { sync, listEvents } = harness();
    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(MINUTE);

    await expect(sync.ensureFresh(2 * MINUTE)).resolves.toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await expect(sync.ensureFresh(2 * MINUTE)).resolves.toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(2);

    listEvents.mockRejectedValueOnce(down());
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await expect(sync.ensureFresh(2 * MINUTE)).resolves.toBe(false);
    expect(listEvents).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  describe('stale state', () => {
    it('turns stale 1 h after the last success, and the next success clears it', async () => {
      const { sync, listEvents } = harness();
      listEvents.mockResolvedValueOnce(page([])).mockRejectedValue(down());
      const states: CalendarSyncState[] = [];
      sync.onStateChange((state) => states.push(state));

      sync.start({ previousRunLastTickAt: null });
      await vi.advanceTimersByTimeAsync(CALENDAR_STALE_AFTER_MS - 1);
      expect(sync.getState().staleSince).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(sync.getState()).toMatchObject({
        lastSuccessAt: iso(START),
        staleSince: iso(START + CALENDAR_STALE_AFTER_MS),
      });
      expect(states.filter((state) => state.staleSince !== null)).toHaveLength(1);

      listEvents.mockResolvedValue(page([]));
      sync.onWake();
      await vi.advanceTimersByTimeAsync(0);
      expect(sync.getState()).toMatchObject({
        lastSuccessAt: iso(START + CALENDAR_STALE_AFTER_MS),
        staleSince: null,
      });
      sync.stop();
    });

    it('counts a copy that never had an answer from the connect', async () => {
      const { sync, listEvents } = harness({ connectedAt: START - 30 * MINUTE });
      listEvents.mockRejectedValue(down());

      sync.start({ previousRunLastTickAt: null });
      await vi.advanceTimersByTimeAsync(30 * MINUTE);

      expect(sync.getState()).toMatchObject({
        lastSuccessAt: null,
        staleSince: iso(START + 30 * MINUTE),
      });
      sync.stop();
    });

    it('asks the API before calling an old copy stale at launch or after a sleep', async () => {
      // Relaunched 3 h after the last success: the launch answer decides, not the clock.
      const relaunch = harness();
      relaunch.cache.replaceEvents([], iso(START - 3 * HOUR));
      const relaunchStates: CalendarSyncState[] = [];
      relaunch.sync.onStateChange((state) => relaunchStates.push(state));
      relaunch.sync.start({ previousRunLastTickAt: iso(START - 3 * HOUR) });
      await vi.advanceTimersByTimeAsync(0);
      expect(relaunchStates.some((state) => state.staleSince !== null)).toBe(false);
      relaunch.sync.stop();

      // Asleep through the hour while backing off: on wake the stale timer is due before the next
      // retry (minute 60 against 66), so it fires first, and the answer it asks for decides.
      const sleeper = harness();
      sleeper.listEvents.mockResolvedValueOnce(page([])).mockRejectedValue(down());
      sleeper.sync.start({ previousRunLastTickAt: null });
      await vi.advanceTimersByTimeAsync(40 * MINUTE);
      expect(sleeper.requestMinutes()).toEqual([0, 5, 6, 8, 12, 20, 36]);
      const sleeperStates: CalendarSyncState[] = [];
      sleeper.sync.onStateChange((state) => sleeperStates.push(state));
      vi.setSystemTime(START + 3 * HOUR);
      sleeper.listEvents.mockResolvedValue(page([]));
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(sleeper.requestMinutes()).toHaveLength(8);
      expect(sleeperStates.some((state) => state.staleSince !== null)).toBe(false);
      expect(sleeper.sync.getState().lastError).toBeNull();
      sleeper.sync.stop();

      // The same relaunch with the API down is stale from the hour after the last success.
      const down3h = harness();
      down3h.cache.replaceEvents([], iso(START - 3 * HOUR));
      down3h.listEvents.mockRejectedValue(down());
      down3h.sync.start({ previousRunLastTickAt: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(down3h.sync.getState().staleSince).toBe(iso(START - 2 * HOUR));
      down3h.sync.stop();
    });

    it('waits for a request on its way before calling the copy stale', async () => {
      const { sync, listEvents } = harness();
      sync.start({ previousRunLastTickAt: null });
      await vi.advanceTimersByTimeAsync(0);
      const states: CalendarSyncState[] = [];
      sync.onStateChange((state) => states.push(state));

      // Asleep for 3 h; on wake the poll goes out first and is slow to answer.
      vi.setSystemTime(START + 3 * HOUR);
      const answer = deferred<CalendarEventsPage>();
      listEvents.mockReturnValueOnce(answer.promise);
      await vi.advanceTimersByTimeAsync(CALENDAR_STALE_AFTER_MS);
      expect(listEvents).toHaveBeenCalledTimes(2);
      expect(sync.getState().staleSince).toBeNull();

      answer.resolve(page([]));
      await vi.advanceTimersByTimeAsync(0);
      expect(states.some((state) => state.staleSince !== null)).toBe(false);
      sync.stop();
    });
  });

  it('drops an answer that lands after a disconnect, and polls no more', async () => {
    const { sync, listEvents, cache } = harness();
    const answer = deferred<CalendarEventsPage>();
    listEvents.mockReturnValueOnce(answer.promise);
    const states: CalendarSyncState[] = [];
    sync.onStateChange((state) => states.push(state));

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(0);
    sync.disconnected();
    answer.resolve(page([call('late', '2026-10-06T10:00:00Z')]));
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(cache.listEvents()).toEqual([]);
    expect(cache.activeConnection()).toBeNull();
    expect(sync.getState()).toEqual({
      lastSuccessAt: null,
      lastError: null,
      staleSince: null,
      reconnectRequired: false,
    });
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.lastSuccessAt).toBeNull();
    sync.stop();
  });

  it('logs a listener that throws, and the refresh still counts', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      format: 'json',
      sink: (line) => lines.push(line),
    });
    const { sync, listEvents } = harness({ logger });
    sync.onEventsChange(() => {
      throw new Error('renderer gone');
    });

    sync.start({ previousRunLastTickAt: null });
    await vi.advanceTimersByTimeAsync(CALENDAR_POLL_INTERVAL_MS);

    expect(listEvents).toHaveBeenCalledTimes(2);
    expect(sync.getState().lastError).toBeNull();
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'calendar sync listener failed',
        event: 'events',
        error: 'renderer gone',
      }),
    );
    sync.stop();
  });
});
