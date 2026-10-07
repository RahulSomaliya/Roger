import { describe, expect, it, vi } from 'vitest';
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../shared/calendar';
import {
  calendarChannels,
  MAX_CALENDAR_EVENT_ID_LENGTH,
  MAX_CALENDAR_MEETINGS_LOOKUP,
} from '../../shared/ipc/calendar';
import type { IpcMainLike, SenderEvent } from '../ipc/trust';
import { MAX_CALENDAR_TEXT_LENGTH } from '../ipc-validation';
import { createLogger } from '../logger';
import { type CalendarIpcDeps, type CalendarIpcWindow, registerCalendarIpc } from './calendarIpc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;
const MEETING_A = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const MEETING_B = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

type Handler = (event: SenderEvent, payload: unknown) => unknown;

const connection: CalendarConnection = {
  provider: 'fake',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-06T08:00:00Z',
  expiresHint: null,
  lastError: null,
};

const event: TimedCalendarEvent = {
  provider: 'fake',
  id: 'fake-call',
  icalUid: null,
  recurringEventId: null,
  title: 'Acme Holdings renewal',
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

const state: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T09:55:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });

  const listeners = {
    connection: [] as ((connection: CalendarConnection | null) => void)[],
    state: [] as ((state: CalendarSyncState) => void)[],
    events: [] as ((events: CalendarEvent[]) => void)[],
  };
  const account = {
    connect: vi.fn<CalendarIpcDeps['account']['connect']>(() => Promise.resolve(connection)),
    disconnect: vi.fn<CalendarIpcDeps['account']['disconnect']>(() => Promise.resolve()),
    getConnection: vi.fn<CalendarIpcDeps['account']['getConnection']>(() =>
      Promise.resolve(connection),
    ),
    onConnectionChange: (listener: (connection: CalendarConnection | null) => void) => {
      listeners.connection.push(listener);
      return () => undefined;
    },
  };
  const sync = {
    getState: vi.fn<CalendarIpcDeps['sync']['getState']>(() => state),
    onStateChange: (listener: (state: CalendarSyncState) => void) => {
      listeners.state.push(listener);
      return () => undefined;
    },
    onEventsChange: (listener: (events: CalendarEvent[]) => void) => {
      listeners.events.push(listener);
      return () => undefined;
    },
  };
  const cache = { listEvents: vi.fn<CalendarIpcDeps['cache']['listEvents']>(() => [event]) };
  const findMeetingIdsByEventIds = vi.fn<CalendarIpcDeps['findMeetingIdsByEventIds']>(
    () => new Map([['fake-call', MEETING_A]]),
  );

  const sent: [string, unknown][] = [];
  let destroyed = false;
  let window: CalendarIpcWindow | null = {
    isDestroyed: () => destroyed,
    webContents: {
      id: MAIN_PAGE,
      send: (channel, payload) => {
        sent.push([channel, payload]);
      },
    },
  };
  registerCalendarIpc({
    ipcMain,
    account,
    sync,
    cache,
    findMeetingIdsByEventIds,
    getWindow: () => window,
    logger,
  });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, payload?: unknown, senderId = MAIN_PAGE): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });

  return {
    handlers,
    account,
    sync,
    cache,
    findMeetingIdsByEventIds,
    listeners,
    sent,
    lines,
    invoke,
    destroy: () => {
      destroyed = true;
    },
    close: () => {
      window = null;
    },
  };
}

const INVOKED = [
  calendarChannels.CalendarGetConnection,
  calendarChannels.CalendarConnect,
  calendarChannels.CalendarDisconnect,
  calendarChannels.CalendarGetEvents,
  calendarChannels.CalendarGetSyncState,
  calendarChannels.CalendarFindMeetings,
];

describe('registerCalendarIpc', () => {
  it('registers every request channel, for the main window only', async () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual([...INVOKED].sort());
    for (const channel of INVOKED) {
      await expect(h.invoke(channel, { eventIds: [] }, PROMPT_PANEL)).rejects.toThrow(
        'untrusted sender',
      );
    }
    expect(h.account.connect).not.toHaveBeenCalled();
    expect(h.account.disconnect).not.toHaveBeenCalled();
    expect(h.findMeetingIdsByEventIds).not.toHaveBeenCalled();
  });

  it('answers the connection, Connect and Disconnect through the account', async () => {
    const h = harness();
    await expect(h.invoke(calendarChannels.CalendarGetConnection)).resolves.toEqual(connection);
    await expect(h.invoke(calendarChannels.CalendarConnect)).resolves.toEqual(connection);
    await expect(h.invoke(calendarChannels.CalendarDisconnect)).resolves.toBeUndefined();
    expect(h.account.getConnection).toHaveBeenCalledTimes(1);
    expect(h.account.connect).toHaveBeenCalledTimes(1);
    expect(h.account.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects with the account's message, which the page shows", async () => {
    const h = harness();
    h.account.connect.mockRejectedValueOnce(new Error('You cancelled the Google sign-in.'));
    await expect(h.invoke(calendarChannels.CalendarConnect)).rejects.toThrow(
      'You cancelled the Google sign-in.',
    );
  });

  it("answers the events and the sync state from this Mac's copy", async () => {
    const h = harness();
    await expect(h.invoke(calendarChannels.CalendarGetEvents)).resolves.toEqual([event]);
    await expect(h.invoke(calendarChannels.CalendarGetSyncState)).resolves.toEqual(state);
    expect(h.cache.listEvents).toHaveBeenCalledTimes(1);
    expect(h.sync.getState).toHaveBeenCalledTimes(1);
  });

  it('logs a failed read of the copy without an event in it, and rejects', async () => {
    const h = harness();
    h.cache.listEvents.mockImplementationOnce(() => {
      throw new Error('database is not open');
    });
    await expect(h.invoke(calendarChannels.CalendarGetEvents)).rejects.toThrow(
      'database is not open',
    );
    expect(h.lines.join('\n')).toContain('calendar read failed');
    expect(h.lines.join('\n')).not.toContain('Acme');
  });

  it("sends main's changes to the page, and nothing to a closed or destroyed window", () => {
    const h = harness();
    for (const listener of h.listeners.connection) listener(null);
    for (const listener of h.listeners.events) listener([event]);
    for (const listener of h.listeners.state) listener(state);
    expect(h.sent).toEqual([
      [calendarChannels.CalendarConnectionChanged, null],
      [calendarChannels.CalendarEventsChanged, [event]],
      [calendarChannels.CalendarSyncStateChanged, state],
    ]);

    h.destroy();
    for (const listener of h.listeners.state) listener(state);
    h.close();
    for (const listener of h.listeners.events) listener([]);
    expect(h.sent).toHaveLength(3);
  });
});

describe('calendar:find-meetings', () => {
  it('answers the newest meeting per event through the port, leaving out events with none', async () => {
    const h = harness();
    h.findMeetingIdsByEventIds.mockReturnValueOnce(
      new Map([
        ['fake-standup_20261006T100000Z', MEETING_B],
        ['fake-call', MEETING_A],
      ]),
    );
    await expect(
      h.invoke(calendarChannels.CalendarFindMeetings, {
        eventIds: ['fake-call', 'fake-solo', 'fake-standup_20261006T100000Z'],
      }),
    ).resolves.toEqual([
      { eventId: 'fake-call', meetingId: MEETING_A },
      { eventId: 'fake-standup_20261006T100000Z', meetingId: MEETING_B },
    ]);
    expect(h.findMeetingIdsByEventIds).toHaveBeenCalledWith([
      'fake-call',
      'fake-solo',
      'fake-standup_20261006T100000Z',
    ]);
  });

  it('answers an empty list without asking the store', async () => {
    const h = harness();
    await expect(
      h.invoke(calendarChannels.CalendarFindMeetings, { eventIds: [] }),
    ).resolves.toEqual([]);
    expect(h.findMeetingIdsByEventIds).not.toHaveBeenCalled();
  });

  it('refuses anything but a capped list of non-empty ids, before the store sees it', async () => {
    const h = harness();
    const refused: unknown[] = [
      undefined,
      ['fake-call'],
      { eventIds: 'fake-call' },
      { eventIds: ['fake-call', 7] },
      { eventIds: [''] },
      { eventIds: ['x'.repeat(MAX_CALENDAR_EVENT_ID_LENGTH + 1)] },
      { eventIds: Array.from({ length: MAX_CALENDAR_MEETINGS_LOOKUP + 1 }, (_, i) => `e${i}`) },
    ];
    for (const payload of refused) {
      await expect(h.invoke(calendarChannels.CalendarFindMeetings, payload)).rejects.toThrow(
        `calendar:find-meetings takes { eventIds: at most ${MAX_CALENDAR_MEETINGS_LOOKUP} event ids }`,
      );
    }
    expect(h.findMeetingIdsByEventIds).not.toHaveBeenCalled();

    const longest = 'x'.repeat(MAX_CALENDAR_EVENT_ID_LENGTH);
    const most = Array.from({ length: MAX_CALENDAR_MEETINGS_LOOKUP }, (_, i) => `e${i}`);
    await expect(
      h.invoke(calendarChannels.CalendarFindMeetings, { eventIds: [longest] }),
    ).resolves.toEqual([]);
    await expect(
      h.invoke(calendarChannels.CalendarFindMeetings, { eventIds: most }),
    ).resolves.toEqual([]);
  });

  it('caps an id where a start request caps it, so every linked event can be found', () => {
    expect(MAX_CALENDAR_EVENT_ID_LENGTH).toBe(MAX_CALENDAR_TEXT_LENGTH);
  });

  it('logs a failed store read by count only, and rejects', async () => {
    const h = harness();
    h.findMeetingIdsByEventIds.mockImplementationOnce(() => {
      throw new Error('database is not open');
    });
    await expect(
      h.invoke(calendarChannels.CalendarFindMeetings, { eventIds: ['fake-call'] }),
    ).rejects.toThrow('database is not open');
    expect(h.lines.join('\n')).toContain('"eventIds":1');
    expect(h.lines.join('\n')).not.toContain('fake-call');
  });
});
