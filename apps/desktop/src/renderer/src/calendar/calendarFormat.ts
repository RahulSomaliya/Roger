import {
  parseInstant,
  type CalendarConnection,
  type CalendarSyncState,
} from '../../../shared/calendar';

/**
 * The words the calendar's banners and Settings use for times and for the calendar's health: pure,
 * so the exact strings are tested.
 *
 * Trap: src/main/app/trayMenu.ts words the same states for the menu bar ("Calendar not updated
 * since 09:12", "Reconnect Google Calendar (before Tue 14 Oct)") with the same rules: stale from
 * `staleSince`, the reconnect line from 24 h before `expiresHint`. The renderer cannot import main,
 * so the rules live twice; change one and change the other, or the menu bar and the window tell
 * the user different things about one calendar.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How times and days read, in the Mac's time zone (injected in tests). */
export interface CalendarFormat {
  /** "09:12". */
  time(ms: number): string;
  /** "Tue 14 Oct". */
  date(ms: number): string;
  /** "Wed 09:30" for another day than `nowMs`'s, "09:30" for the same day. */
  when(ms: number, nowMs: number): string;
}

/**
 * The format in `timeZone` (an IANA name), or in this Mac's zone when omitted. English and 24 h
 * clock, as the plan words them ("since 09:12", "before Tue 14 Oct"); Roger has no other language.
 */
export function createCalendarFormat(timeZone?: string): CalendarFormat {
  const zone = timeZone === undefined ? {} : { timeZone };
  const parts = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...zone, ...options });
  const clock = parts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const weekday = parts({ weekday: 'short' });
  const day = parts({ day: 'numeric' });
  const month = parts({ month: 'short' });
  const dayKey = parts({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = (ms: number): string => clock.format(ms);
  return {
    time,
    date: (ms) => `${weekday.format(ms)} ${day.format(ms)} ${month.format(ms)}`,
    when: (ms, nowMs) =>
      dayKey.format(ms) === dayKey.format(nowMs) ? time(ms) : `${weekday.format(ms)} ${time(ms)}`,
  };
}

/** "Calendar not updated since 09:12" ("since Sat 21:05" for an earlier day). */
export function staleText(sync: CalendarSyncState, nowMs: number, format: CalendarFormat): string {
  return sync.lastSuccessAt === null
    ? 'Calendar not updated'
    : `Calendar not updated since ${format.when(parseInstant(sync.lastSuccessAt), nowMs)}`;
}

/**
 * The reconnect button's label, or null when nothing needs one. Google expires the grant after 7
 * days while the project is External in Testing (`expiresHint`), so the label carries the date from
 * a day before; once Google refused the grant (`reconnect_required`) or the date has passed there
 * is no date to give.
 */
export function reconnectLabel(
  connection: CalendarConnection | null,
  sync: CalendarSyncState | null,
  nowMs: number,
  format: CalendarFormat,
): string | null {
  if (connection === null) return null;
  const refused = connection.status === 'reconnect_required' || sync?.reconnectRequired === true;
  if (refused) return 'Reconnect Google Calendar';
  if (connection.expiresHint === null) return null;
  const expiresMs = parseInstant(connection.expiresHint);
  if (nowMs < expiresMs - DAY_MS) return null;
  return nowMs < expiresMs
    ? `Reconnect before ${format.date(expiresMs)}`
    : 'Reconnect Google Calendar';
}

export type CalendarNoticeKind = 'reconnect-required' | 'reconnect-soon' | 'stale';

/** One line of the calendar's status banner. */
export interface CalendarNotice {
  kind: CalendarNoticeKind;
  text: string;
  /** The button's label (it reconnects), or null when the user can do nothing about it. */
  action: string | null;
}

export interface CalendarNoticeInputs {
  connection: CalendarConnection | null;
  sync: CalendarSyncState | null;
  nowMs: number;
  format: CalendarFormat;
}

/**
 * What the calendar's banner says, most urgent first. Nothing without a connection: a disconnect
 * clears the copy, but a health still on its way can arrive after it, and with no account there is
 * nothing to be stale or to reconnect. A refused grant explains the stale copy that follows it
 * (polling stops until the next connect), so it hides that line.
 */
export function calendarNotices({
  connection,
  sync,
  nowMs,
  format,
}: CalendarNoticeInputs): CalendarNotice[] {
  if (connection === null) return [];
  const label = reconnectLabel(connection, sync, nowMs, format);
  if (label === 'Reconnect Google Calendar') {
    return [
      {
        kind: 'reconnect-required',
        text: 'Google Calendar needs you to sign in again. Until then Roger shows no new meetings and sends no reminders.',
        action: label,
      },
    ];
  }
  const notices: CalendarNotice[] = [];
  if (label !== null) {
    notices.push({
      kind: 'reconnect-soon',
      text: 'Google will end Roger’s access to your calendar soon. Sign in again to keep your reminders.',
      action: label,
    });
  }
  if (sync !== null && sync.staleSince !== null) {
    notices.push({ kind: 'stale', text: staleText(sync, nowMs, format), action: null });
  }
  return notices;
}
