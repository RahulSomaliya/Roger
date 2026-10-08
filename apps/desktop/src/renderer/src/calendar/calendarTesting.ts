import type {
  AllDayCalendarEvent,
  CalendarAttendee,
  CalendarConnection,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { CalendarSettingsState } from './calendarSettingsStore';
import type { CalendarState } from './calendarStore';

/**
 * Builders for the calendar components' tests. Dates are built from local fields, so a test reads
 * the same in any time zone Vitest runs in. Not a test file: importing a constant from one would
 * register its tests again (apps/desktop/CLAUDE.md).
 */

/** 11:00 on 6 Oct 2026 in the Mac's zone. */
export const NOW_MS = new Date(2026, 9, 6, 11, 0, 0).getTime();

/** The instant at `hour`:`minute` on 6 Oct 2026, local. */
export function at(hour: number, minute = 0): string {
  return new Date(2026, 9, 6, hour, minute, 0).toISOString();
}

export function attendee(name: string, fields: Partial<CalendarAttendee> = {}): CalendarAttendee {
  return {
    email: `${name.toLowerCase()}@example.com`,
    displayName: name,
    responseStatus: 'accepted',
    isSelf: false,
    isOrganizer: false,
    ...fields,
  };
}

export function timedEvent(
  id: string,
  start: string,
  end: string,
  fields: Partial<TimedCalendarEvent> = {},
): TimedCalendarEvent {
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
    start,
    end,
    startDate: null,
    endDate: null,
    ...fields,
  };
}

export function allDayEvent(
  id: string,
  fields: Partial<AllDayCalendarEvent> = {},
): AllDayCalendarEvent {
  return {
    ...timedEvent(id, at(0), at(0)),
    allDay: true,
    start: null,
    end: null,
    startDate: '2026-10-06',
    endDate: '2026-10-07',
    ...fields,
  };
}

export const CONNECTION: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-01T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};

export const FRESH_SYNC: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T05:00:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

/** A connected calendar, read, with no events; override what a test is about. */
export function calendarState(fields: Partial<CalendarState> = {}): CalendarState {
  return {
    connection: CONNECTION,
    connectionStatus: 'ready',
    connectionError: null,
    events: [],
    sync: FRESH_SYNC,
    loaded: true,
    copyError: null,
    links: new Map(),
    linksError: null,
    connecting: false,
    connectError: null,
    disconnecting: false,
    disconnectError: null,
    ...fields,
  };
}

/** The settings as the defaults give them, read. */
export function settingsState(fields: Partial<CalendarSettingsState> = {}): CalendarSettingsState {
  return {
    status: 'ready',
    error: null,
    reminderLeadMinutes: 1,
    noticeEnabled: true,
    noticeText: 'Hi all, I am taking notes with Roger.',
    openAtLogin: 'off',
    loginItem: 'disabled',
    loginItemError: null,
    saveError: null,
    noticeDone: [],
    ...fields,
  };
}

/** Markup as the page shows its text: no comment React's server output puts between text pieces. */
export function plain(markup: string): string {
  return markup.replaceAll('<!-- -->', '');
}
