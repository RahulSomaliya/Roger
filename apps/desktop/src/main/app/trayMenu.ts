import {
  type CalendarConnection,
  type CalendarEvent,
  type CalendarSyncState,
  parseInstant,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import { formatClock } from '../../shared/clock';

/**
 * The menu bar item's menu and icon as plain data, with no Electron import, so every rule tests
 * under Node. tray.ts turns the model into Electron's menu and image and routes each action.
 *
 * The menu names only what a glance needs: the next meeting's title and start, never its
 * attendees or link (a menu bar can be screen-shared).
 */

export type TrayIconState = 'idle' | 'recording' | 'warning';

/** What a click does; tray.ts maps each to a call. */
export type TrayAction = 'start' | 'stop' | 'reconnect' | 'open' | 'quit';

export type TrayMenuEntry =
  | { kind: 'label'; text: string }
  | { kind: 'action'; action: TrayAction; text: string }
  | { kind: 'separator' };

export interface TrayModel {
  icon: TrayIconState;
  tooltip: string;
  entries: TrayMenuEntry[];
}

/** How times and days read in the menu, in the Mac's time zone (injected in tests). */
export interface TrayFormat {
  /** "9:12 am". */
  time(ms: number): string;
  /** "Tue 14 Oct". */
  date(ms: number): string;
  /** "Wed 9:30 am" for another day than `nowMs`'s, "9:30 am" for the same day. */
  when(ms: number, nowMs: number): string;
}

/**
 * The format in `timeZone` (an IANA name), or in this Mac's zone when omitted. English and the
 * 12-hour lowercase clock of docs/design.md, Copy ("9:12 am", "before Tue 14 Oct"), whatever the
 * Mac's own clock setting says; Roger has no other language.
 */
export function createTrayFormat(timeZone?: string): TrayFormat {
  const zone = timeZone === undefined ? {} : { timeZone };
  const parts = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...zone, ...options });
  const weekday = parts({ weekday: 'short' });
  const day = parts({ day: 'numeric' });
  const month = parts({ month: 'short' });
  const dayKey = parts({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = (ms: number): string => formatClock(ms, timeZone);
  return {
    time,
    date: (ms) => `${weekday.format(ms)} ${day.format(ms)} ${month.format(ms)}`,
    when: (ms, nowMs) =>
      dayKey.format(ms) === dayKey.format(nowMs) ? time(ms) : `${weekday.format(ms)} ${time(ms)}`,
  };
}

export interface TrayInputs {
  /** A note is being taken (the capture phase is `recording`). */
  recording: boolean;
  nowMs: number;
  /** This Mac's copy of the calendar; [] when none is connected. */
  events: readonly CalendarEvent[];
  /** Null when no calendar is connected: the menu then says nothing of one. */
  connection: CalendarConnection | null;
  sync: CalendarSyncState | null;
  format: TrayFormat;
}

/** The longest title the menu shows, the ellipsis included. */
const MAX_TITLE_CHARS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trap: `recording` outranks `warning`. The icon is the user's cue that notes are being taken,
 * and a reconnect nag must never hide it; the warning still shows as a menu line.
 *
 * A stale calendar says nothing here: Home says it (docs/plans/redesign.md), and a warning icon
 * for it would point at a menu with no line to explain it. Only a refused or expiring grant, which
 * has a Reconnect to press, turns the icon to warning.
 */
export function buildTrayModel(inputs: TrayInputs): TrayModel {
  const { recording, connection, nowMs, format } = inputs;
  // A disconnect clears the copy, but a health still on its way can arrive after the connection
  // went: with no account there is nothing to be stale or to reconnect.
  const sync = connection === null ? null : inputs.sync;
  const entries: TrayMenuEntry[] = [];

  if (connection !== null) entries.push({ kind: 'label', text: nextMeetingText(inputs) });
  const reconnect = reconnectText(connection, sync, nowMs, format);
  if (reconnect !== null) entries.push({ kind: 'action', action: 'reconnect', text: reconnect });
  if (entries.length > 0) entries.push({ kind: 'separator' });

  entries.push(
    recording
      ? { kind: 'action', action: 'stop', text: 'Stop' }
      : { kind: 'action', action: 'start', text: 'Start notes' },
    { kind: 'action', action: 'open', text: 'Open Roger' },
    { kind: 'separator' },
    { kind: 'action', action: 'quit', text: 'Quit Roger' },
  );

  if (recording) return { icon: 'recording', tooltip: 'Roger: recording', entries };
  if (reconnect !== null) {
    return { icon: 'warning', tooltip: 'Roger: calendar needs attention', entries };
  }
  return { icon: 'idle', tooltip: 'Roger', entries };
}

function isTimed(event: CalendarEvent): event is TimedCalendarEvent {
  return !event.allDay;
}

/** The meeting that has started and not ended, else the next to start. */
function nextMeetingText({ events, nowMs, format }: TrayInputs): string {
  let next: { event: TimedCalendarEvent; startMs: number } | null = null;
  for (const event of events) {
    if (!isTimed(event) || event.selfResponse === 'declined') continue;
    if (parseInstant(event.end) <= nowMs) continue;
    const startMs = parseInstant(event.start);
    if (next === null || startMs < next.startMs) next = { event, startMs };
  }
  if (next === null) return 'No upcoming meetings';
  const title = shortTitle(next.event.title);
  return next.startMs <= nowMs
    ? `Now: ${title}`
    : `Next: ${title}, ${format.when(next.startMs, nowMs)}`;
}

function shortTitle(title: string): string {
  const chars = Array.from(title.trim());
  if (chars.length === 0) return 'Untitled meeting';
  if (chars.length <= MAX_TITLE_CHARS) return chars.join('');
  return `${chars.slice(0, MAX_TITLE_CHARS - 1).join('')}…`;
}

/**
 * The reconnect line, or null. Google expires the grant after 7 days while the project is
 * External in Testing (`expiresHint`), so the line shows from a day before with its date; once
 * refused (`reconnect_required`) or past its date there is no date to give.
 */
function reconnectText(
  connection: CalendarConnection | null,
  sync: CalendarSyncState | null,
  nowMs: number,
  format: TrayFormat,
): string | null {
  if (connection === null) return null;
  const refused = connection.status === 'reconnect_required' || sync?.reconnectRequired === true;
  if (refused) return 'Reconnect Google Calendar';
  if (connection.expiresHint === null) return null;
  const expiresMs = parseInstant(connection.expiresHint);
  if (nowMs < expiresMs - DAY_MS) return null;
  return nowMs < expiresMs
    ? `Reconnect Google Calendar (before ${format.date(expiresMs)})`
    : 'Reconnect Google Calendar';
}
