import { describe, expect, it, vi } from 'vitest';
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { CalendarApi, CalendarMeetingLink } from '../../../shared/ipc/calendar';
import { CalendarStore } from './calendarStore';

const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-06T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};
const sync: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T08:55:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

function event(id: string): TimedCalendarEvent {
  return {
    provider: 'fake',
    id,
    icalUid: null,
    recurringEventId: null,
    title: id,
    status: 'confirmed',
    selfResponse: 'accepted',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    allDay: false,
    start: '2026-10-06T09:00:00.000Z',
    end: '2026-10-06T09:30:00.000Z',
    startDate: null,
    endDate: null,
  };
}

/** A promise a test settles by hand. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

interface FakeCalendar {
  api: CalendarApi;
  emit: {
    connection(value: CalendarConnection | null): void;
    events(value: CalendarEvent[]): void;
    sync(value: CalendarSyncState): void;
  };
  /** How many listeners of each event are attached now. */
  attached(): number;
}

function fakeCalendar(overrides: Partial<CalendarApi> = {}): FakeCalendar {
  const connectionListeners = new Set<(value: CalendarConnection | null) => void>();
  const eventListeners = new Set<(value: CalendarEvent[]) => void>();
  const syncListeners = new Set<(value: CalendarSyncState) => void>();
  const subscribe =
    <T>(set: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    };
  const api: CalendarApi = {
    getCalendarConnection: () => Promise.resolve(connection),
    connectCalendar: () => Promise.resolve(connection),
    disconnectCalendar: () => Promise.resolve(),
    getCalendarEvents: () => Promise.resolve([event('a')]),
    getCalendarSyncState: () => Promise.resolve(sync),
    findCalendarMeetings: () => Promise.resolve([]),
    onCalendarConnectionChanged: subscribe(connectionListeners),
    onCalendarEventsChanged: subscribe(eventListeners),
    onCalendarSyncStateChanged: subscribe(syncListeners),
    ...overrides,
  };
  return {
    api,
    emit: {
      connection: (value) => {
        connectionListeners.forEach((listener) => {
          listener(value);
        });
      },
      events: (value) => {
        eventListeners.forEach((listener) => {
          listener(value);
        });
      },
      sync: (value) => {
        syncListeners.forEach((listener) => {
          listener(value);
        });
      },
    },
    attached: () => connectionListeners.size + eventListeners.size + syncListeners.size,
  };
}

describe('CalendarStore reads', () => {
  it('starts loading, then holds the connection, the events and their health', async () => {
    const store = new CalendarStore(fakeCalendar().api);
    expect(store.getState()).toMatchObject({ connectionStatus: 'loading', loaded: false });
    store.retain();
    await settle();
    const state = store.getState();
    expect(state.connectionStatus).toBe('ready');
    expect(state.connection).toEqual(connection);
    expect(state.events.map((each) => each.id)).toEqual(['a']);
    expect(state.sync).toEqual(sync);
    expect(state.loaded).toBe(true);
  });

  it('lets an event that arrives during a read win over the read, which is older', async () => {
    const read = deferred<CalendarEvent[]>();
    const calendar = fakeCalendar({ getCalendarEvents: () => read.promise });
    const store = new CalendarStore(calendar.api);
    store.retain();
    calendar.emit.events([event('fresh')]);
    read.resolve([event('old')]);
    await settle();
    expect(store.getState().events.map((each) => each.id)).toEqual(['fresh']);
    expect(store.getState().loaded).toBe(true);
  });

  it('says why the connection could not be read while the events still show', async () => {
    const calendar = fakeCalendar({
      getCalendarConnection: () =>
        Promise.reject(
          new Error("Error invoking remote method 'calendar:get-connection': Error: API is down"),
        ),
    });
    const store = new CalendarStore(calendar.api);
    store.retain();
    await settle();
    expect(store.getState()).toMatchObject({
      connectionStatus: 'failed',
      connectionError: 'API is down',
      loaded: true,
    });
    expect(store.getState().events).toHaveLength(1);
  });

  it('says why the calendar copy could not be read, and reads again on reload', async () => {
    const getCalendarEvents = vi
      .fn<CalendarApi['getCalendarEvents']>()
      .mockRejectedValueOnce(new Error('calendar.sqlite is locked'))
      .mockResolvedValue([event('b')]);
    const store = new CalendarStore(fakeCalendar({ getCalendarEvents }).api);
    store.retain();
    await settle();
    expect(store.getState().copyError).toBe('calendar.sqlite is locked');
    store.reload();
    await settle();
    expect(store.getState().copyError).toBeNull();
    expect(store.getState().events.map((each) => each.id)).toEqual(['b']);
  });

  it('follows the connection and the health main sends', async () => {
    const calendar = fakeCalendar();
    const store = new CalendarStore(calendar.api);
    store.retain();
    await settle();
    const refused = { ...connection, status: 'reconnect_required' as const };
    calendar.emit.connection(refused);
    calendar.emit.sync({ ...sync, reconnectRequired: true });
    expect(store.getState().connection).toEqual(refused);
    expect(store.getState().sync?.reconnectRequired).toBe(true);
  });
});

describe('CalendarStore retain', () => {
  it('listens once for any number of holders and stops with the last', async () => {
    const calendar = fakeCalendar();
    const store = new CalendarStore(calendar.api);
    const first = store.retain();
    const second = store.retain();
    expect(calendar.attached()).toBe(3);
    first();
    first(); // a second release of one hold changes nothing
    expect(calendar.attached()).toBe(3);
    second();
    expect(calendar.attached()).toBe(0);
    await settle();
  });

  it('drops the answer to a read that a stop overtook', async () => {
    const read = deferred<CalendarConnection | null>();
    const calendar = fakeCalendar({ getCalendarConnection: () => read.promise });
    const store = new CalendarStore(calendar.api);
    store.retain()();
    read.resolve(connection);
    await settle();
    expect(store.getState().connection).toBeNull();
  });
});

describe('CalendarStore connect and disconnect', () => {
  const notConnected = { getCalendarConnection: () => Promise.resolve(null) };

  it('stores the connection once connected', async () => {
    const store = new CalendarStore(fakeCalendar(notConnected).api);
    store.retain();
    await settle();
    await store.connect();
    expect(store.getState()).toMatchObject({
      connection,
      connecting: false,
      connectError: null,
    });
  });

  it('shows why a connect failed, and stays unconnected', async () => {
    const store = new CalendarStore(
      fakeCalendar({
        ...notConnected,
        connectCalendar: () => Promise.reject(new Error('Tick the calendar box and try again')),
      }).api,
    );
    store.retain();
    await settle();
    await store.connect();
    expect(store.getState()).toMatchObject({
      connection: null,
      connecting: false,
      connectError: 'Tick the calendar box and try again',
    });
  });

  it('shows nothing for a connect a newer one replaced: main rejects the first by design', async () => {
    const first = deferred<CalendarConnection>();
    const second = deferred<CalendarConnection>();
    const connectCalendar = vi
      .fn<CalendarApi['connectCalendar']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = new CalendarStore(fakeCalendar({ ...notConnected, connectCalendar }).api);
    store.retain();
    await settle();
    const olderRun = store.connect();
    const newerRun = store.connect();
    first.reject(new Error('Replaced by a newer sign-in'));
    await olderRun;
    expect(store.getState()).toMatchObject({ connecting: true, connectError: null });
    second.resolve(connection);
    await newerRun;
    expect(store.getState()).toMatchObject({ connecting: false, connection });
  });

  it('clears the connection, the copy and the links on disconnect', async () => {
    const calendar = fakeCalendar({
      findCalendarMeetings: () => Promise.resolve([{ eventId: 'a', meetingId: 'm1' }]),
    });
    const store = new CalendarStore(calendar.api);
    store.retain();
    await settle();
    await store.refreshLinks(['a']);
    await store.disconnect();
    expect(store.getState()).toMatchObject({
      connection: null,
      events: [],
      disconnecting: false,
    });
    expect(store.getState().links.size).toBe(0);
  });

  it('keeps the connection and says why when the revoke fails', async () => {
    const store = new CalendarStore(
      fakeCalendar({
        disconnectCalendar: () => Promise.reject(new Error('Google did not answer')),
      }).api,
    );
    store.retain();
    await settle();
    await store.disconnect();
    expect(store.getState().connection).toEqual(connection);
    expect(store.getState().disconnectError).toBe('Google did not answer');
  });
});

describe('CalendarStore links to meetings', () => {
  it('maps each event to the meeting started for it', async () => {
    const found: CalendarMeetingLink[] = [{ eventId: 'a', meetingId: 'm1' }];
    const findCalendarMeetings = vi.fn<CalendarApi['findCalendarMeetings']>(() =>
      Promise.resolve(found),
    );
    const store = new CalendarStore(fakeCalendar({ findCalendarMeetings }).api);
    await store.refreshLinks(['a', 'b']);
    expect(findCalendarMeetings).toHaveBeenCalledWith(['a', 'b']);
    expect(store.getState().links.get('a')).toBe('m1');
    expect(store.getState().links.has('b')).toBe(false);
  });

  it('asks nothing for an empty list', async () => {
    const findCalendarMeetings = vi.fn<CalendarApi['findCalendarMeetings']>();
    const store = new CalendarStore(fakeCalendar({ findCalendarMeetings }).api);
    await store.refreshLinks([]);
    expect(findCalendarMeetings).not.toHaveBeenCalled();
  });

  it('keeps the answer to the last question when an earlier one lands late', async () => {
    const older = deferred<CalendarMeetingLink[]>();
    const newer = deferred<CalendarMeetingLink[]>();
    const findCalendarMeetings = vi
      .fn<CalendarApi['findCalendarMeetings']>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const store = new CalendarStore(fakeCalendar({ findCalendarMeetings }).api);
    const first = store.refreshLinks(['a']);
    const second = store.refreshLinks(['a']);
    newer.resolve([{ eventId: 'a', meetingId: 'new' }]);
    await second;
    older.resolve([{ eventId: 'a', meetingId: 'old' }]);
    await first;
    expect(store.getState().links.get('a')).toBe('new');
  });

  it('says so when the lookup fails, and keeps the links it had', async () => {
    const findCalendarMeetings = vi
      .fn<CalendarApi['findCalendarMeetings']>()
      .mockResolvedValueOnce([{ eventId: 'a', meetingId: 'm1' }])
      .mockRejectedValueOnce(new Error('event id is too long'));
    const store = new CalendarStore(fakeCalendar({ findCalendarMeetings }).api);
    await store.refreshLinks(['a']);
    await store.refreshLinks(['a']);
    expect(store.getState().linksError).toBe('event id is too long');
    expect(store.getState().links.get('a')).toBe('m1');
  });
});
