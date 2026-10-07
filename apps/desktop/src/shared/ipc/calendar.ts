import type { CalendarConnection, CalendarEvent, CalendarSyncState } from '../calendar';
import { storedMeetingText } from '../capture';
import type { Unsubscribe } from './unsubscribe';

/**
 * The calendar's channels (M5-T6), for the main window's page only: Home's "Today", the Calendar
 * section of Settings and their banners. Main registers them in src/main/calendar/calendarIpc.ts.
 * Add a member here together with its bridge (src/preload/bridges/calendar.ts) and its preview
 * fake (preview/fakes/calendar.ts): the type check fails until all three agree.
 *
 * Two sources answer. The connection, Connect and Disconnect go to the Roger API, which keeps the
 * Google grant (main/calendar/CalendarAccount.ts). The events, their sync state and the meetings
 * started for them come from this Mac (calendar.sqlite and roger.sqlite), so they answer with the
 * API down: prompts and "Today" run on that copy.
 */
export const calendarChannels = {
  /** renderer → main, invoke */
  CalendarGetConnection: 'calendar:get-connection',
  CalendarConnect: 'calendar:connect',
  CalendarDisconnect: 'calendar:disconnect',
  CalendarGetEvents: 'calendar:get-events',
  CalendarGetSyncState: 'calendar:get-sync-state',
  CalendarFindMeetings: 'calendar:find-meetings',
  /** main → renderer events */
  CalendarConnectionChanged: 'calendar:connection-changed',
  CalendarEventsChanged: 'calendar:events-changed',
  CalendarSyncStateChanged: 'calendar:sync-state-changed',
} as const;

/**
 * The most event ids one `findCalendarMeetings` may name. Home asks for the events it lists,
 * a day's worth; the cap bounds the JSON main hands SQLite for one request.
 */
export const MAX_CALENDAR_MEETINGS_LOOKUP = 500;

/**
 * The longest event id a meeting can be linked to, measured as a start request measures it
 * (`MAX_CALENDAR_TEXT_LENGTH` in src/main/ipc-validation.ts; see parseFindCalendarMeetingsRequest).
 */
export const MAX_CALENDAR_EVENT_ID_LENGTH = 2048;

/** What `calendar:find-meetings` carries. */
export interface FindCalendarMeetingsRequest {
  eventIds: readonly string[];
}

/** An event and the newest meeting this Mac started for it: Home's "Open note". */
export interface CalendarMeetingLink {
  eventId: string;
  meetingId: string;
}

/**
 * The request as main takes it, a fresh copy, or null: a list of at most
 * MAX_CALENDAR_MEETINGS_LOOKUP ids, each one a start request would link a meeting to. Main and the
 * preview fake both refuse with it, so they refuse the same payloads.
 *
 * Trap: an id is measured exactly as the start's `text()` in src/main/ipc-validation.ts measures
 * it (code points of storedMeetingText: U+0000 dropped, the ends trimmed, not blank, at most
 * MAX_CALENDAR_EVENT_ID_LENGTH), never by `.length`. The start stores the id as sent, so an id
 * the start took and this refused is a meeting nobody can find, and since one bad id refuses the
 * whole list, Home loses Open note for every event of the day. calendarIpc.test.ts runs the same
 * ids through both.
 */
export function parseFindCalendarMeetingsRequest(
  payload: unknown,
): FindCalendarMeetingsRequest | null {
  const eventIds: unknown =
    typeof payload === 'object' && payload !== null && 'eventIds' in payload
      ? payload.eventIds
      : null;
  if (!Array.isArray(eventIds) || eventIds.length > MAX_CALENDAR_MEETINGS_LOOKUP) return null;
  const checked: string[] = [];
  for (const id of eventIds as unknown[]) {
    if (typeof id !== 'string') return null;
    const length = Array.from(storedMeetingText(id)).length;
    if (length === 0 || length > MAX_CALENDAR_EVENT_ID_LENGTH) return null;
    checked.push(id);
  }
  return { eventIds: checked };
}

/** The calendar's part of `window.roger` (types: src/shared/calendar.ts). */
export interface CalendarApi {
  /**
   * The Google Calendar connection as the Roger API holds it: the account, `reconnect_required`,
   * and `expiresHint` (Google expires the grant then; warn from a day before). Null when nothing
   * is connected. When this Mac's copy disagrees (another Roger build sharing the API connected or
   * disconnected), main brings it in line first, and the events and their sync state follow as
   * their own events. Rejects with a message to show when the API cannot be reached, or when this
   * Mac cannot record the change; the events and their sync state still answer then.
   */
  getCalendarConnection(): Promise<CalendarConnection | null>;
  /**
   * Runs the Google sign-in in the default browser and resolves with the stored connection once
   * the user is back (up to 3 minutes). The events follow as onCalendarEventsChanged. Rejects with
   * a message to show: cancelled at Google, timed out, replaced by a newer call, or the API's
   * refusal ("tick the calendar box"). A second call cancels the first, which then rejects.
   */
  connectCalendar(): Promise<CalendarConnection>;
  /**
   * Revokes the grant and clears this Mac's copy of the calendar (the prompt log stays). Cancels a
   * sign-in still waiting on the browser. Rejects, keeping the copy, when the API cannot revoke.
   */
  disconnectCalendar(): Promise<void>;
  /**
   * This Mac's copy: every event from 36 hours ago to 36 hours ahead, ordered by start, all-day
   * ones included; [] when nothing is connected. Main never decides what "today" is: the page
   * groups by its own local date.
   */
  getCalendarEvents(): Promise<CalendarEvent[]>;
  /** The copy's health: last success, last error, stale since, reconnect required. */
  getCalendarSyncState(): Promise<CalendarSyncState>;
  /**
   * For each of the events this Mac started a meeting for, the newest such meeting; events with
   * none are left out. Ask again when the recording's meeting changes, so a note just started
   * shows. Rejects a list main refuses (parseFindCalendarMeetingsRequest).
   */
  findCalendarMeetings(eventIds: readonly string[]): Promise<CalendarMeetingLink[]>;
  /** The connection changed: a connect, a disconnect, or a read that found it changed. */
  onCalendarConnectionChanged(
    listener: (connection: CalendarConnection | null) => void,
  ): Unsubscribe;
  /** The copy changed: a refresh, or a connect or disconnect that replaced it. The whole list. */
  onCalendarEventsChanged(listener: (events: CalendarEvent[]) => void): Unsubscribe;
  onCalendarSyncStateChanged(listener: (state: CalendarSyncState) => void): Unsubscribe;
}
