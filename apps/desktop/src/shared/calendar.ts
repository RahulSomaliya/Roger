/**
 * Calendar domain types shared by main, preload and the renderer pages (Home and the prompt panel).
 * The API speaks snake_case (docs/api-contract.md, Calendar); these are the desktop's camelCase
 * mirror, mapped in `main/api/calendarClient.ts`, and by `ApiClient.ts` for the event a meeting
 * create returns.
 * Keep this file free of runtime imports: it is bundled into every process.
 */

export type CalendarProvider = 'google' | 'fake';

export type ResponseStatus = 'accepted' | 'tentative' | 'declined' | 'needs_action';

/** The user's own answer to the invite. `organizer`: the user owns the event. */
export type SelfResponse = ResponseStatus | 'organizer' | 'unknown';

/** Where the API found `videoLink`. `conference` is the link Google adds by itself. */
export type VideoLinkSource = 'conference' | 'location' | 'description';

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: ResponseStatus;
  isSelf: boolean;
  /** Rooms and other resources are never listed. */
  isOrganizer: boolean;
}

interface CalendarEventFields {
  provider: CalendarProvider;
  /** The instance id for a recurring event: each instance has its own. */
  id: string;
  icalUid: string | null;
  recurringEventId: string | null;
  /** "" when the invite has none. */
  title: string;
  /** Cancelled events are never returned. */
  status: 'confirmed' | 'tentative';
  selfResponse: SelfResponse;
  attendees: CalendarAttendee[];
  /** Google left some attendees out (privacy, or more than 100). */
  attendeesOmitted: boolean;
  /** Allowlisted hosts only. Re-checked with `parseJoinLink` (shared/meetingLinks.ts) before opening. */
  videoLink: string | null;
  videoLinkSource: VideoLinkSource | null;
  htmlLink: string | null;
}

/** A timed event. `start` and `end` are UTC instants; prompts run on them. */
export interface TimedCalendarEvent extends CalendarEventFields {
  allDay: false;
  start: string;
  end: string;
  startDate: null;
  endDate: null;
}

/**
 * An all-day event keeps its plain dates ("2026-10-06", end exclusive). Never turn them into
 * midnight UTC: west of UTC that moves the event a day back.
 */
export interface AllDayCalendarEvent extends CalendarEventFields {
  allDay: true;
  start: null;
  end: null;
  startDate: string;
  endDate: string;
}

export type CalendarEvent = TimedCalendarEvent | AllDayCalendarEvent;

/** `GET /v1/calendar/events`. */
export interface CalendarEventsPage {
  /** Ordered by start. */
  items: CalendarEvent[];
  fetchedAt: string;
}

export interface CalendarConnection {
  provider: CalendarProvider;
  accountEmail: string;
  status: 'active' | 'reconnect_required';
  connectedAt: string;
  /** `connectedAt` + 7 days while the Google project is External in Testing; otherwise null. */
  expiresHint: string | null;
  lastError: string | null;
}

/** The health of the local copy of the calendar (`calendar.sqlite` → `fetch_state`). */
export interface CalendarSyncState {
  /** The last successful fetch, or null before the first one. */
  lastSuccessAt: string | null;
  /** The last failure, cleared by the next success. */
  lastError: string | null;
  /** When the copy turned stale (1 h without a success), or null while it is fresh. */
  staleSince: string | null;
  /** Google refused the stored grant (`424`). Polling stops until the next connect. */
  reconnectRequired: boolean;
}

// Instants -------------------------------------------------------------------------------------

/** ISO 8601 with seconds and a zone. `Date.parse` would also take a local time, in this Mac's zone. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Epoch ms of an instant with a zone (`Z` or an offset). Throws on anything else: an instant read
 * in the wrong zone moves every prompt by hours, so a bad value must fail where it enters.
 */
export function parseInstant(value: string): number {
  const fields = INSTANT.exec(value);
  const ms =
    fields !== null && dayExists(Number(fields[1]), Number(fields[2]), Number(fields[3]))
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`Not an ISO 8601 instant with a zone: "${value}"`);
  return ms;
}

/**
 * Whether the date names a real day. `Date.parse` checks only the ranges (month 1 to 12, day 1 to
 * 31) and rolls the rest over: "2026-02-30" reads as 2 March, a prompt days late with no error.
 */
function dayExists(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

/** The stored form, `YYYY-MM-DDTHH:MM:SS.sssZ`: one spelling per instant, and it sorts as text. */
export function toUtcInstant(value: string): string {
  return new Date(parseInstant(value)).toISOString();
}

// Meeting link -----------------------------------------------------------------------------------

/** The most attendees a meeting keeps, in invite order (API contract, `MeetingCalendarEvent`). */
export const MAX_MEETING_ATTENDEES = 200;

/** The event a meeting was started for. Stored with the local meeting and sent with its create. */
export interface MeetingCalendarEvent {
  provider: CalendarProvider;
  eventId: string;
  icalUid: string | null;
  recurringEventId: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  attendees: CalendarAttendee[];
}

export function toMeetingCalendarEvent(event: TimedCalendarEvent): MeetingCalendarEvent {
  return {
    provider: event.provider,
    eventId: event.id,
    icalUid: event.icalUid,
    recurringEventId: event.recurringEventId,
    scheduledStart: toUtcInstant(event.start),
    scheduledEnd: toUtcInstant(event.end),
    // The API refuses more (422); Google sends at most 100, so only a fake file reaches the cap.
    attendees: event.attendees.slice(0, MAX_MEETING_ATTENDEES),
  };
}

// Prompts ----------------------------------------------------------------------------------------

/**
 * One prompt per event instance: `<event id>@<start instant>`. A moved instance gets a new key and
 * prompts again; a deleted one never does. The start is written in its stored form, so a change in
 * how the API spells an instant cannot turn every logged prompt into a new one.
 */
export function promptKey(event: TimedCalendarEvent): string {
  return `${event.id}@${toUtcInstant(event.start)}`;
}

/** An app that M2's call detection saw using the mic. */
export interface CallApp {
  bundleId: string;
  /** Shown on the card: "Zoom is using the mic". */
  name: string;
}

/**
 * What feeds the one prompt panel (`PromptService.offer`): the reminder scheduler for calendar
 * events, M2's call detection for calls with no prompt of their own.
 */
export type PromptOffer =
  { source: 'calendar'; eventKey: string } | { source: 'call_detected'; app: CallApp };

/** What put a calendar card up: its reminder, or a detected call that matched the event. */
export type PromptShownBy = 'calendar' | 'call_detected';

/** `taking_notes`: the 5 s "Recording, Open Roger" state after a start action. */
export type PromptCardPhase = 'open' | 'taking_notes';

interface ActionablePromptCard {
  /** Unique among the cards on the panel; actions name it. */
  id: string;
  phase: PromptCardPhase;
  /** Why the last start failed (the card stays up), or null. */
  error: string | null;
}

export interface CalendarPromptCard extends ActionablePromptCard {
  kind: 'calendar';
  /**
   * Earliest first, never empty. Calls starting within a minute of each other share a card
   * (`sharesCard` in main/calendar/reminderPolicy.ts); each has its own start action.
   */
  events: [TimedCalendarEvent, ...TimedCalendarEvent[]];
  shownBy: PromptShownBy;
  /**
   * The event whose start is under way (the card is `taking_notes`), else null. A card of two
   * calls keeps both until the 5 s line ends, and the line must say which one started.
   */
  startedEventId: string | null;
}

export interface CallDetectedPromptCard extends ActionablePromptCard {
  kind: 'call_detected';
  app: CallApp;
}

export type PromptCard = CalendarPromptCard | CallDetectedPromptCard;
