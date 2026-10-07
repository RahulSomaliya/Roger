import { describe, expect, it } from 'vitest';
import type {
  CalendarConnection,
  CalendarEvent,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../src/shared/calendar';
import { calendarChannels, MAX_CALENDAR_MEETINGS_LOOKUP } from '../../src/shared/ipc/calendar';
import { parseJoinLink } from '../../src/shared/meetingLinks';
import { PreviewHub } from '../control';
import { createCalendarFake, PREVIEW_CALENDAR_ACCOUNT, previewCalendarDay } from './calendar';
import { FakeHub } from './hub';

const NOW = new Date('2026-10-06T09:58:00.000Z');
const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

const NO_STATE: CalendarSyncState = {
  lastSuccessAt: null,
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

/**
 * Resolves after the fake's refresh following a Connect has landed: like main's, it answers a
 * task after Connect resolves (a timer queued first fires first).
 */
function refreshed(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** What each listener heard, in order, as `connection`, `events:<count>` and `state:<success>`. */
function listen(calendar: ReturnType<typeof createCalendarFake>): string[] {
  const heard: string[] = [];
  calendar.onCalendarConnectionChanged((connection) => {
    heard.push(`connection:${connection === null ? 'none' : connection.status}`);
  });
  calendar.onCalendarEventsChanged((events) => heard.push(`events:${events.length}`));
  calendar.onCalendarSyncStateChanged((state) => {
    heard.push(`state:${state.lastSuccessAt ?? 'never'}${state.reconnectRequired ? ':424' : ''}`);
  });
  return heard;
}

function timed(events: CalendarEvent[], id: string): TimedCalendarEvent {
  const event = events.find((each) => each.id === id);
  if (event === undefined || event.allDay) throw new Error(`no timed event ${id}`);
  return event;
}

describe('the preview calendar fake', () => {
  it('starts as a Mac with no calendar connected', async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    await expect(calendar.getCalendarConnection()).resolves.toBeNull();
    await expect(calendar.getCalendarEvents()).resolves.toEqual([]);
    await expect(calendar.getCalendarSyncState()).resolves.toEqual(NO_STATE);
  });

  it("connects the fake provider's account, then fills the day after Connect answers, in main's order", async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    const heard = listen(calendar);

    const connection = await calendar.connectCalendar();

    expect(connection).toEqual({
      provider: 'fake',
      accountEmail: PREVIEW_CALENDAR_ACCOUNT,
      status: 'active',
      connectedAt: NOW.toISOString(),
      expiresHint: null,
      lastError: null,
    });
    // CalendarSync.connected sends the copy as it stands (empty for a new account), state first;
    // only then does CalendarAccount send the connection. A page that reads the copy's events as
    // "not connected" while the connection is still null must cope with this order.
    expect(heard).toEqual(['state:never', 'events:0', 'connection:active']);
    await expect(calendar.getCalendarConnection()).resolves.toEqual(connection);
    await expect(calendar.getCalendarEvents()).resolves.toEqual([]);

    // The refresh CalendarSync starts at the connect answers after Connect has resolved.
    await refreshed();
    expect(heard).toEqual([
      'state:never',
      'events:0',
      'connection:active',
      `state:${NOW.toISOString()}`,
      `events:${previewCalendarDay(NOW).length}`,
    ]);
    await expect(calendar.getCalendarEvents()).resolves.toEqual(previewCalendarDay(NOW));
    await expect(calendar.getCalendarSyncState()).resolves.toEqual({
      ...NO_STATE,
      lastSuccessAt: NOW.toISOString(),
    });
  });

  it('keeps the copy of the account already connected at a Connect, as main does', async () => {
    const hub = new FakeHub();
    const calendar = createCalendarFake(hub, () => NOW);
    await calendar.connectCalendar();
    await refreshed();
    hub.emit(calendarChannels.CalendarSyncStateChanged, {
      ...NO_STATE,
      lastSuccessAt: NOW.toISOString(),
      reconnectRequired: true,
    });
    const heard = listen(calendar);

    await calendar.connectCalendar();

    // The same account keeps its day, and the connect clears the refused-grant mark.
    const day = `events:${previewCalendarDay(NOW).length}`;
    expect(heard).toEqual([`state:${NOW.toISOString()}`, day, 'connection:active']);
  });

  it('drops the day of a refresh still on its way when Disconnect comes first', async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    await calendar.connectCalendar();
    await calendar.disconnectCalendar();

    await refreshed();

    await expect(calendar.getCalendarEvents()).resolves.toEqual([]);
    await expect(calendar.getCalendarSyncState()).resolves.toEqual(NO_STATE);
  });

  it("holds the API fake's day: a call in 2 minutes, then the edge cases, ordered by start", () => {
    const day = previewCalendarDay(NOW);
    const call = timed(day, 'fake-call');
    expect(Date.parse(call.start) - NOW.getTime()).toBe(2 * 60_000);
    expect(call.attendees).toHaveLength(3);
    expect(call.videoLinkSource).toBe('conference');
    expect(day[0]).toMatchObject({ allDay: true, title: 'Release week' });
    expect(timed(day, 'fake-declined').selfResponse).toBe('declined');
    expect(timed(day, 'fake-standup_20261006T102800Z').recurringEventId).toBe('fake-standup');
    expect(timed(day, 'fake-solo-zoom').videoLinkSource).toBe('location');
    const starts = day.flatMap((event) => (event.allDay ? [] : [Date.parse(event.start)]));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Every link is one the app would open (shared/meetingLinks.ts).
    for (const event of day) {
      if (event.videoLink !== null) expect(parseJoinLink(event.videoLink)).not.toBeNull();
    }
  });

  it("disconnects, emptying the copy and telling the listeners in main's order", async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    await calendar.connectCalendar();
    await refreshed();
    const heard = listen(calendar);

    await calendar.disconnectCalendar();

    // CalendarAccount sends the connection first, then CalendarSync.disconnected the state and
    // the emptied copy.
    expect(heard).toEqual(['connection:none', 'state:never', 'events:0']);
    await expect(calendar.getCalendarConnection()).resolves.toBeNull();
    await expect(calendar.getCalendarEvents()).resolves.toEqual([]);
    await expect(calendar.getCalendarSyncState()).resolves.toEqual(NO_STATE);
  });

  it('answers with what a scenario sends, as main would after the change', async () => {
    const hub = new FakeHub();
    const calendar = createCalendarFake(hub, () => NOW);
    const stale: CalendarSyncState = {
      lastSuccessAt: '2026-10-06T07:12:00.000Z',
      lastError: 'GET /v1/calendar/events failed: connect ECONNREFUSED 127.0.0.1:8000',
      staleSince: '2026-10-06T08:12:00.000Z',
      reconnectRequired: false,
    };
    const reconnect: CalendarConnection = {
      provider: 'google',
      accountEmail: 'rahul@linkt.ai',
      status: 'reconnect_required',
      connectedAt: '2026-09-30T08:00:00.000Z',
      expiresHint: '2026-10-07T08:00:00.000Z',
      lastError: 'Google refused the calendar grant. Reconnect Google Calendar in Settings.',
    };
    const events = previewCalendarDay(NOW).slice(0, 2);

    hub.emit(calendarChannels.CalendarConnectionChanged, reconnect);
    hub.emit(calendarChannels.CalendarEventsChanged, events);
    hub.emit(calendarChannels.CalendarSyncStateChanged, stale);

    await expect(calendar.getCalendarConnection()).resolves.toEqual(reconnect);
    await expect(calendar.getCalendarEvents()).resolves.toEqual(events);
    await expect(calendar.getCalendarSyncState()).resolves.toEqual(stale);
  });

  it('hands out copies, so the page cannot change what the fake holds', async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    await calendar.connectCalendar();
    await refreshed();
    const events = await calendar.getCalendarEvents();
    events.pop();
    await expect(calendar.getCalendarEvents()).resolves.toEqual(previewCalendarDay(NOW));
  });

  it("finds the meetings a scenario linked, by emitting them on the lookup's channel", async () => {
    const hub = new FakeHub();
    const calendar = createCalendarFake(hub, () => NOW);
    await expect(calendar.findCalendarMeetings(['fake-call'])).resolves.toEqual([]);

    hub.emit(calendarChannels.CalendarFindMeetings, [{ eventId: 'fake-call', meetingId: MEETING }]);

    await expect(calendar.findCalendarMeetings(['fake-solo-zoom', 'fake-call'])).resolves.toEqual([
      { eventId: 'fake-call', meetingId: MEETING },
    ]);
  });

  it("refuses a lookup main refuses, with main's words", async () => {
    const calendar = createCalendarFake(new FakeHub(), () => NOW);
    await expect(calendar.findCalendarMeetings([''])).rejects.toThrow(
      `Error invoking remote method 'calendar:find-meetings': Error: calendar:find-meetings takes { eventIds: at most ${MAX_CALENDAR_MEETINGS_LOOKUP} event ids }`,
    );
  });

  it("fails the API's routes while the API is offline, and keeps answering from the copy", async () => {
    const hub = new PreviewHub();
    const calendar = createCalendarFake(hub, () => NOW);
    await calendar.connectCalendar();
    await refreshed();
    hub.setApiOffline(true);

    await expect(calendar.getCalendarConnection()).rejects.toThrow(
      "Error invoking remote method 'calendar:get-connection': ApiError: GET /v1/calendar/connection failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    await expect(calendar.connectCalendar()).rejects.toThrow(
      "Error invoking remote method 'calendar:connect': ApiError: POST /v1/calendar/google/authorization failed",
    );
    await expect(calendar.disconnectCalendar()).rejects.toThrow(
      "Error invoking remote method 'calendar:disconnect': ApiError: DELETE /v1/calendar/connection failed",
    );
    await expect(calendar.getCalendarEvents()).resolves.toEqual(previewCalendarDay(NOW));
    await expect(calendar.getCalendarSyncState()).resolves.toMatchObject({
      lastSuccessAt: NOW.toISOString(),
    });
    await expect(calendar.findCalendarMeetings(['fake-call'])).resolves.toEqual([]);
  });
});
