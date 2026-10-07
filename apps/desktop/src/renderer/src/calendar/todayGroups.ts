import { parseInstant, type CalendarEvent } from '../../../shared/calendar';

/**
 * What Home's "Today" lists, worked out from the events main hands over: pure, so the day's edges
 * test under any time zone.
 *
 * Trap: main never decides what "today" is. It keeps every event from 36 hours ago to 36 hours
 * ahead, so that today in any zone is inside the copy (at 23:30 IST the 10:00 standup is 13.5 h
 * back), and this page cuts the day by its own local date, which follows a macOS time zone change.
 * Cutting it anywhere else (main, or UTC) drops the morning's meetings off an evening's Home.
 */

const MINUTE_MS = 60_000;

/** Start notes shows this long before a meeting starts, and until it ends. */
export const START_NOTES_LEAD_MS = 15 * MINUTE_MS;

/** One row of Home's list. */
export interface TodayEntry {
  event: CalendarEvent;
  /** The user said no: the row is greyed and sorts after the rest. */
  declined: boolean;
  /** Start notes is on offer now (timed events only; startNotesAvailable). */
  startNotes: boolean;
  /** The newest local meeting started for this event: Open note. Null when there is none. */
  meetingId: string | null;
}

export interface TodayGroups {
  /** The strip on top: all-day events, in the order main gave them, declined ones last. */
  allDay: TodayEntry[];
  /** Timed events by start, declined ones last. */
  timed: TodayEntry[];
  /** The meeting under way, else the next to start, never a declined one; null when none is left. */
  next: TodayEntry | null;
}

export interface TodayInputs {
  /** Main's copy: every event from 36 hours ago to 36 hours ahead. */
  events: readonly CalendarEvent[];
  /** Event id to the newest meeting started for it (`findCalendarMeetings`). */
  links: ReadonlyMap<string, string>;
  /** Decides which day it is, in this Mac's zone, and which meetings are on or over. */
  nowMs: number;
}

/**
 * Whether Start notes is on offer for `event` at `nowMs`: a timed event, from 15 minutes before its
 * start until its end. A declined meeting gets it too: the plan's window names no other rule.
 */
export function startNotesAvailable(event: CalendarEvent, nowMs: number): boolean {
  if (event.allDay) return false;
  return (
    nowMs >= parseInstant(event.start) - START_NOTES_LEAD_MS && nowMs < parseInstant(event.end)
  );
}

/** The events on `nowMs`'s local day, as Home shows them. */
export function todayGroups({ events, links, nowMs }: TodayInputs): TodayGroups {
  const day = new Date(nowMs);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // Built from the date, not "+ 24 h": a day with a DST change is 23 or 25 hours long.
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const dayKey = localDateKey(day);

  const entryOf = (event: CalendarEvent): TodayEntry => ({
    event,
    declined: event.selfResponse === 'declined',
    startNotes: startNotesAvailable(event, nowMs),
    meetingId: links.get(event.id) ?? null,
  });

  const allDay: TodayEntry[] = [];
  const timed: { entry: TodayEntry; startMs: number; endMs: number }[] = [];
  for (const event of events) {
    if (event.allDay) {
      // Plain dates, end exclusive, compared as text: "2026-10-06" sorts as it reads.
      if (event.startDate <= dayKey && dayKey < event.endDate) allDay.push(entryOf(event));
      continue;
    }
    const startMs = parseInstant(event.start);
    const endMs = parseInstant(event.end);
    // Overlap, so an event over midnight is on both days; a zero-length one counts at its start.
    const onToday = startMs < dayEnd && (endMs > dayStart || startMs >= dayStart);
    if (onToday) timed.push({ entry: entryOf(event), startMs, endMs });
  }

  timed.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      a.entry.event.id.localeCompare(b.entry.event.id),
  );
  const ordered = declinedLast(timed.map(({ entry }) => entry));
  const next =
    timed
      .filter(({ entry, endMs }) => !entry.declined && endMs > nowMs)
      .map(({ entry }) => entry)[0] ?? null;
  return { allDay: declinedLast(allDay), timed: ordered, next };
}

/** A stable partition: the entries the user accepted keep their order, then the declined ones. */
function declinedLast(entries: TodayEntry[]): TodayEntry[] {
  return [
    ...entries.filter((entry) => !entry.declined),
    ...entries.filter((entry) => entry.declined),
  ];
}

/** "2026-10-06" for the local date of `date`. */
function localDateKey(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
