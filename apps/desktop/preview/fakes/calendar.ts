import type {
  CalendarAttendee,
  CalendarConnection,
  CalendarEvent,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../src/shared/calendar';
import {
  type CalendarApi,
  calendarChannels,
  type CalendarMeetingLink,
  MAX_CALENDAR_MEETINGS_LOOKUP,
  parseFindCalendarMeetingsRequest,
} from '../../src/shared/ipc/calendar';
import { fromApi } from '../control';
import type { FakeHub } from './hub';

/** The fake provider's account (apps/api `FAKE_ACCOUNT_EMAIL`). */
export const PREVIEW_CALENDAR_ACCOUNT = 'you@example.com';

const NO_SYNC_STATE: CalendarSyncState = {
  lastSuccessAt: null,
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

/**
 * The calendar's part of the preview's `window.roger`: a Mac with no calendar connected, whose
 * Connect works as with the API's fake provider (`CALENDAR_PROVIDER=fake`): it connects
 * `you@example.com` and fills the copy with the fake day (previewCalendarDay), anchored to when the
 * page loaded, as the API's is to when it started.
 *
 * The connection, Connect and Disconnect are marked fromApi with the route main calls first, so in
 * the api-offline scenario they fail as main's ApiError for it; the events, the sync state and the
 * lookup answer from main's own copy and keep working.
 *
 * A change a scenario sends on CalendarConnectionChanged, CalendarEventsChanged or
 * CalendarSyncStateChanged becomes what the fake answers, as it would be in main (a stale copy, a
 * reconnect, a busy day). The lookup has no event of its own, so a scenario links events to
 * meetings by emitting `CalendarMeetingLink[]` on the CalendarFindMeetings channel, as the capture
 * fake takes reports on CaptureGetReport.
 */
export function createCalendarFake(hub: FakeHub, now: () => Date = () => new Date()): CalendarApi {
  const day = previewCalendarDay(now());
  let connection: CalendarConnection | null = null;
  let events: CalendarEvent[] = [];
  let state: CalendarSyncState = NO_SYNC_STATE;
  const links = new Map<string, string>();

  hub.on(calendarChannels.CalendarConnectionChanged, (next: CalendarConnection | null) => {
    connection = next;
  });
  hub.on(calendarChannels.CalendarEventsChanged, (next: CalendarEvent[]) => {
    events = next;
  });
  hub.on(calendarChannels.CalendarSyncStateChanged, (next: CalendarSyncState) => {
    state = next;
  });
  hub.on(calendarChannels.CalendarFindMeetings, (described: CalendarMeetingLink[]) => {
    for (const { eventId, meetingId } of described) links.set(eventId, meetingId);
  });

  /** The copy and its health, state first, as CalendarSync sends them (notifyState, notifyEvents). */
  const publishCopy = (copy: CalendarEvent[], health: CalendarSyncState): void => {
    hub.emit(calendarChannels.CalendarSyncStateChanged, health);
    hub.emit(calendarChannels.CalendarEventsChanged, copy);
  };

  return {
    getCalendarConnection: () =>
      hub.request(
        calendarChannels.CalendarGetConnection,
        fromApi('GET /v1/calendar/connection', () => connection),
      ),
    connectCalendar: () =>
      hub.request(
        calendarChannels.CalendarConnect,
        fromApi('POST /v1/calendar/google/authorization', () => {
          const connected: CalendarConnection = {
            provider: 'fake',
            accountEmail: PREVIEW_CALENDAR_ACCOUNT,
            status: 'active',
            connectedAt: now().toISOString(),
            expiresHint: null,
            lastError: null,
          };
          // Main's order (CalendarAccount.recordConnected): CalendarSync.connected first sends the
          // copy as it stands, the same account's kept with its refused-grant mark cleared, any
          // other's emptied; then the connection; then Connect resolves; the day comes later with
          // the refresh, dropped if the connection changed first. Keep it: Home is built and its QA
          // run on this preview, and a fake that sent the connection first would hide a page that
          // reads a copy arriving while the connection is still null as "not connected".
          const kept = connection?.accountEmail === PREVIEW_CALENDAR_ACCOUNT;
          publishCopy(
            kept ? structuredClone(events) : [],
            kept ? { ...state, reconnectRequired: false } : NO_SYNC_STATE,
          );
          hub.emit(calendarChannels.CalendarConnectionChanged, connected);
          setTimeout(() => {
            if (connection !== connected) return;
            publishCopy(structuredClone(day), {
              ...NO_SYNC_STATE,
              lastSuccessAt: now().toISOString(),
            });
          }, 0);
          return connected;
        }),
      ),
    disconnectCalendar: () =>
      hub.request(
        calendarChannels.CalendarDisconnect,
        fromApi('DELETE /v1/calendar/connection', () => {
          // Main's order: CalendarAccount sends the connection, then CalendarSync.disconnected the
          // state and the emptied copy.
          hub.emit(calendarChannels.CalendarConnectionChanged, null);
          publishCopy([], NO_SYNC_STATE);
        }),
      ),
    getCalendarEvents: () =>
      hub.request(calendarChannels.CalendarGetEvents, () => structuredClone(events)),
    getCalendarSyncState: () =>
      hub.request(calendarChannels.CalendarGetSyncState, () => ({ ...state })),
    findCalendarMeetings: (eventIds) =>
      hub.request(calendarChannels.CalendarFindMeetings, () => {
        const request = parseFindCalendarMeetingsRequest({ eventIds });
        if (request === null) {
          // The words a failed ipcRenderer.invoke rejects with when main refuses the list.
          const channel = calendarChannels.CalendarFindMeetings;
          throw new Error(
            `Error invoking remote method '${channel}': Error: ${channel} takes { eventIds: at most ${MAX_CALENDAR_MEETINGS_LOOKUP} event ids }`,
          );
        }
        return [...new Set(request.eventIds)].flatMap((eventId) => {
          const meetingId = links.get(eventId);
          return meetingId === undefined ? [] : [{ eventId, meetingId }];
        });
      }),
    onCalendarConnectionChanged: (listener) =>
      hub.on(calendarChannels.CalendarConnectionChanged, listener),
    onCalendarEventsChanged: (listener) => hub.on(calendarChannels.CalendarEventsChanged, listener),
    onCalendarSyncStateChanged: (listener) =>
      hub.on(calendarChannels.CalendarSyncStateChanged, listener),
  };
}

const MINUTE_MS = 60_000;

/**
 * The API fake provider's built-in day (apps/api/src/roger_api/services/calendar/fake.py, `_script`)
 * as main gets it from `GET /v1/calendar/events`, anchored to `anchor`: an all-day item, a call
 * 2 minutes after it with three attendees and a Meet link, a moved recurring instance, a declined
 * call, a solo block with only an auto-added Meet link, a solo block with a Zoom link typed into
 * the location, and a call tomorrow. Ordered by start, all-day first, as the API orders them.
 */
export function previewCalendarDay(anchor: Date): CalendarEvent[] {
  const start = Math.floor(anchor.getTime() / 1000) * 1000;
  const at = (minutes: number): string => new Date(start + minutes * MINUTE_MS).toISOString();
  const me: CalendarAttendee = {
    email: PREVIEW_CALENDAR_ACCOUNT,
    displayName: null,
    responseStatus: 'accepted',
    isSelf: true,
    isOrganizer: false,
  };
  const jane: CalendarAttendee = {
    email: 'jane@example.com',
    displayName: 'Jane Cooper',
    responseStatus: 'accepted',
    isSelf: false,
    isOrganizer: true,
  };
  const ali: CalendarAttendee = {
    email: 'ali@example.com',
    displayName: 'Ali Khan',
    responseStatus: 'tentative',
    isSelf: false,
    isOrganizer: false,
  };
  const timed = (
    id: string,
    title: string,
    fromMinutes: number,
    toMinutes: number,
    fields: Partial<TimedCalendarEvent> = {},
  ): TimedCalendarEvent => ({
    provider: 'fake',
    id,
    icalUid: null,
    recurringEventId: null,
    title,
    status: 'confirmed',
    allDay: false,
    start: at(fromMinutes),
    end: at(toMinutes),
    startDate: null,
    endDate: null,
    selfResponse: 'organizer',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    ...fields,
  });
  const meet = (code: string): Partial<TimedCalendarEvent> => ({
    videoLink: `https://meet.google.com/${code}`,
    videoLinkSource: 'conference',
  });
  // A moved instance keeps the id of its original time, 30 minutes after the anchor.
  const originalStandup = at(30)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const local = new Date(start);
  const today = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  const tomorrow = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1);

  return [
    {
      provider: 'fake',
      id: 'fake-all-day',
      icalUid: null,
      recurringEventId: null,
      title: 'Release week',
      status: 'confirmed',
      allDay: true,
      start: null,
      end: null,
      startDate: localDate(today),
      endDate: localDate(tomorrow),
      selfResponse: 'organizer',
      attendees: [],
      attendeesOmitted: false,
      videoLink: null,
      videoLinkSource: null,
      htmlLink: null,
    },
    timed('fake-call', 'Weekly sync', 2, 32, {
      selfResponse: 'accepted',
      attendees: [jane, me, ali],
      ...meet('abc-defg-hij'),
    }),
    timed(`fake-standup_${originalStandup}`, 'Daily standup', 45, 60, {
      recurringEventId: 'fake-standup',
      icalUid: 'fake-standup@example.com',
      selfResponse: 'accepted',
      attendees: [jane, me],
      ...meet('rog-erst-and'),
    }),
    timed('fake-declined', 'Vendor demo', 90, 120, {
      selfResponse: 'declined',
      attendees: [
        {
          email: 'sales@vendor.example',
          displayName: null,
          responseStatus: 'accepted',
          isSelf: false,
          isOrganizer: true,
        },
        { ...me, responseStatus: 'declined' },
      ],
      videoLink: 'https://zoom.us/j/1234567890',
      videoLinkSource: 'location',
    }),
    timed('fake-focus', 'Focus time', 150, 210, meet('foc-usti-mes')),
    timed('fake-solo-zoom', 'Client call (Zoom link in the location)', 240, 270, {
      videoLink: 'https://us02web.zoom.us/j/81234567890?pwd=fake',
      videoLinkSource: 'location',
    }),
    timed('fake-tomorrow', 'Planning with Ali', 24 * 60, 24 * 60 + 30, {
      selfResponse: 'accepted',
      attendees: [{ ...ali, responseStatus: 'accepted', isOrganizer: true }, me],
      videoLink:
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_fake%40thread.v2/0?context=%7b%7d',
      videoLinkSource: 'description',
    }),
  ];
}

/** "2026-10-06" in the page's own zone: an all-day event keeps its plain dates. */
function localDate(day: Date): string {
  const month = String(day.getMonth() + 1).padStart(2, '0');
  const date = String(day.getDate()).padStart(2, '0');
  return `${day.getFullYear()}-${month}-${date}`;
}
