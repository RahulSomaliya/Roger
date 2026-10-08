import {
  parseInstant,
  type CalendarEvent,
  type TimedCalendarEvent,
} from '../../../shared/calendar';

/**
 * What Home's "Today" lists, worked out from the events main hands over: pure, so the day's edges
 * test under any time zone.
 *
 * Trap: main never decides what "today" is. It keeps every event from 36 hours ago to 36 hours
 * ahead, so that today in any zone is inside the copy (at 23:30 IST the 10:00 standup is 13.5 h
 * back), and this page cuts the day by its own local date, which follows a macOS time zone change.
 * Cutting it anywhere else (main, or UTC) drops the morning's meetings off an evening's Home.
 *
 * Only timed meetings you have not declined are listed (docs/plans/redesign.md): an all-day event
 * is not a meeting anyone starts notes on, and a declined one is a meeting you are not going to.
 */

const MINUTE_MS = 60_000;

/** Start notes shows this long before a meeting starts, and until it ends. */
export const START_NOTES_LEAD_MS = 15 * MINUTE_MS;

/** Home's Start notes names a meeting from this long before it starts, and while it is on. */
export const HERO_LEAD_MS = 10 * MINUTE_MS;

/** One row of Home's list. */
export interface TimedEntry {
  event: TimedCalendarEvent;
  /** Start notes is on offer now (startNotesAvailable). */
  startNotes: boolean;
  /** The newest local meeting started for this event: Open note. Null when there is none. */
  meetingId: string | null;
}

export interface TodayGroups {
  /** Timed events by start. */
  timed: TimedEntry[];
  /** The meeting under way, else the next to start; null when none is left today. */
  next: TimedEntry | null;
}

export interface TodayInputs {
  /** Main's copy: every event from 36 hours ago to 36 hours ahead. */
  events: readonly CalendarEvent[];
  /** Event id to the newest meeting started for it (`findCalendarMeetings`). */
  links: ReadonlyMap<string, string>;
  /** Decides which day it is, in this Mac's zone, and which meetings are on or over. */
  nowMs: number;
}

/** Whether Start notes is on offer for `event` at `nowMs`: from 15 minutes before its start until its end. */
export function startNotesAvailable(event: TimedCalendarEvent, nowMs: number): boolean {
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

  const timed: { entry: TimedEntry; startMs: number; endMs: number }[] = [];
  for (const event of events) {
    if (event.allDay || event.selfResponse === 'declined') continue;
    const startMs = parseInstant(event.start);
    const endMs = parseInstant(event.end);
    // Overlap, so an event over midnight is on both days; a zero-length one counts at its start.
    const onToday = startMs < dayEnd && (endMs > dayStart || startMs >= dayStart);
    if (!onToday) continue;
    timed.push({
      entry: {
        event,
        startNotes: startNotesAvailable(event, nowMs),
        meetingId: links.get(event.id) ?? null,
      },
      startMs,
      endMs,
    });
  }

  timed.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      a.entry.event.id.localeCompare(b.entry.event.id),
  );
  const next = timed.find(({ endMs }) => endMs > nowMs)?.entry ?? null;
  return { timed: timed.map(({ entry }) => entry), next };
}

/**
 * The meeting Home's Start notes is for: the next one, once it starts within 10 minutes or is on
 * now, else null (a blank note). Null too when the meeting already has its notes: Open note is
 * its row's action, and a Start here would make a second meeting for the event.
 */
export function heroMeeting({ next }: TodayGroups, nowMs: number): TimedEntry | null {
  if (next?.meetingId !== null) return null;
  return parseInstant(next.event.start) - nowMs <= HERO_LEAD_MS ? next : null;
}
