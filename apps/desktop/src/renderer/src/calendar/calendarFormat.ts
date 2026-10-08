import {
  parseInstant,
  type CalendarConnection,
  type CalendarSyncState,
} from '../../../shared/calendar';
import { LOGIN_ITEMS_SETTINGS_PATH, type LoginItemStatus } from '../../../shared/ipc/loginItem';
import { formatClock } from '../clock';
import type { CalendarState } from './calendarStore';

/**
 * The words Home's calendar line and Settings use for times and for the calendar's health: pure,
 * so the exact strings are tested.
 *
 * Trap: src/main/app/trayMenu.ts words the same states for the menu bar ("Calendar not updated
 * since 9:12 am", "Reconnect Google Calendar (before Wed 14 Oct)") with the same rules: stale from
 * `staleSince`, the reconnect line from 24 h before `expiresHint`. The renderer cannot import main,
 * so the rules live twice; change one and change the other, or the menu bar and the window tell
 * the user different things about one calendar. The words differ on purpose: the menu line keeps
 * "Reconnect Google Calendar" (it has no page around it), the window's button says "Reconnect".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How times and days read, in the Mac's time zone (injected in tests). */
export interface CalendarFormat {
  /** "9:12 am". */
  time(ms: number): string;
  /** "Wed 14 Oct". */
  date(ms: number): string;
  /** "Wed 9:30 am" for another day than `nowMs`'s, "9:30 am" for the same day. */
  when(ms: number, nowMs: number): string;
}

/**
 * The format in `timeZone` (an IANA name), or in this Mac's zone when omitted. English and the
 * 12 h clock of docs/design.md ("since 9:12 am", "on Wed 14 Oct"); Roger has no other language.
 *
 * Trap: call it per render, never once at import. An Intl formatter keeps the time zone it was made
 * in, so one built at import goes on writing the old zone's clock after a macOS zone change, while
 * the day's meetings (cut with the page's own Date, todayGroups.ts) follow the new one.
 */
export function createCalendarFormat(timeZone?: string): CalendarFormat {
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

/** "Calendar not updated since 9:12 am" ("since Sat 9:05 pm" for an earlier day). */
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
  if (refused) return 'Reconnect';
  if (connection.expiresHint === null) return null;
  const expiresMs = parseInstant(connection.expiresHint);
  if (nowMs < expiresMs - DAY_MS) return null;
  return nowMs < expiresMs ? `Reconnect before ${format.date(expiresMs)}` : 'Reconnect';
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
  if (label === 'Reconnect') {
    return [
      {
        kind: 'reconnect-required',
        text: 'Google Calendar needs you to sign in again. Until then Roger shows no new meetings and sends no reminders.',
        action: label,
      },
    ];
  }
  const notices: CalendarNotice[] = [];
  if (label !== null && connection.expiresHint !== null) {
    // The date is in the sentence, so Home's button can just say Reconnect.
    const on = format.date(parseInstant(connection.expiresHint));
    notices.push({
      kind: 'reconnect-soon',
      text: `Google ends Roger’s access to your calendar on ${on}. Reconnect to keep your reminders.`,
      action: label,
    });
  }
  if (sync !== null && sync.staleSince !== null) {
    notices.push({ kind: 'stale', text: staleText(sync, nowMs, format), action: null });
  }
  return notices;
}

/** Home's one quiet calendar line: what is wrong, and the one thing to press about it, if any. */
export interface CalendarProblem {
  text: string;
  /** `reconnect` signs in again; `reload` reads again (Try again); null: nothing to press. */
  action: 'reconnect' | 'reload' | null;
}

export interface CalendarProblemInputs {
  state: Pick<
    CalendarState,
    'connection' | 'connectionStatus' | 'connectionError' | 'copyError' | 'sync' | 'linksError'
  >;
  nowMs: number;
  format: CalendarFormat;
}

/**
 * The one problem Home's Today shows, most urgent first, or null. One line, not a stack
 * (docs/plans/redesign.md): a refused grant explains every other symptom (polling stops until the
 * next connect), a failed read hides meetings that may exist, a stale copy or a coming expiry is
 * a warning, and a failed notes lookup only costs an Open note button.
 */
export function calendarProblem({
  state,
  nowMs,
  format,
}: CalendarProblemInputs): CalendarProblem | null {
  const notices = calendarNotices({
    connection: state.connection,
    sync: state.sync,
    nowMs,
    format,
  });
  const refused = notices.find((notice) => notice.kind === 'reconnect-required');
  if (refused !== undefined) return { text: refused.text, action: 'reconnect' };
  if (state.connectionStatus === 'failed') {
    return {
      text: `Roger could not check your Google Calendar connection: ${state.connectionError ?? 'no reason given'}`,
      action: 'reload',
    };
  }
  if (state.copyError !== null) {
    return { text: `Roger could not read your calendar: ${state.copyError}`, action: 'reload' };
  }
  const [warning] = notices;
  if (warning !== undefined) {
    return { text: warning.text, action: warning.action === null ? null : 'reconnect' };
  }
  if (state.linksError !== null) {
    return {
      text: `Roger could not check which meetings already have notes: ${state.linksError}`,
      action: null,
    };
  }
  return null;
}

/** The login-item states that earn a hint under Settings' "Open at login". */
export type OpenAtLoginHintStatus = Extract<LoginItemStatus, 'requires-approval' | 'unavailable'>;

/**
 * The line under Settings' "Open at login", said only when there is something to do or to know:
 * a packaged build that waits for the user (`requires-approval`) says where to allow it, since
 * until then Roger is not running for the first calls of the day; `unavailable` says this copy
 * cannot register a login item. Every other state is the switch alone (OpenAtLoginField).
 */
export function openAtLoginHint(status: OpenAtLoginHintStatus): string {
  switch (status) {
    case 'unavailable':
      return 'Not available in this copy of Roger (a development build, or Roger is not in Applications).';
    case 'requires-approval':
      return `Allow Roger in ${LOGIN_ITEMS_SETTINGS_PATH} so it can open at login. Until then reminders for your first calls are missed.`;
  }
}
