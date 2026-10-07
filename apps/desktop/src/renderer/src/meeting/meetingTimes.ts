import { formatClock } from '../clock';

/**
 * When a meeting ran, as Home's list and the meeting header say it. The clock is formatClock's
 * (12-hour, lowercase, never the Mac's 24-hour setting: docs/design.md, Copy); the dates follow
 * the Mac's own order. `locale` is for tests, and orders the dates only; the app passes none.
 */

interface MeetingSpan {
  /** ISO 8601 instants, UTC. */
  startedAt: string;
  endedAt: string | null;
}

const DAY_MS = 86_400_000;

/** Whole local days from `date` to `now`: 0 today, 1 yesterday. */
function daysAgo(date: Date, now: Date): number {
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day with a daylight saving change is 23 or 25 hours long.
  return Math.round((midnight(now) - midnight(date)) / DAY_MS);
}

/** "Today", "Yesterday", a weekday and date this year, or a date with its year. */
function dayName(date: Date, now: Date, locale: string | undefined, leading: boolean): string {
  const ago = daysAgo(date, now);
  if (ago === 0) return leading ? 'Today' : 'today';
  if (ago === 1) return leading ? 'Yesterday' : 'yesterday';
  if (date.getFullYear() !== now.getFullYear()) {
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** A past meeting's label in a list: its start time today, else its day. */
export function recentMeetingLabel(startedAt: string, now: Date, locale?: string): string {
  const start = new Date(startedAt);
  const ago = daysAgo(start, now);
  if (ago === 0) return formatClock(start);
  if (ago === 1) return 'Yesterday';
  if (start.getFullYear() !== now.getFullYear()) {
    return start.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return start.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/**
 * The meeting header's line: "Started 9:05 am" while it records, "Today, 9:30 am to 9:41 am" once
 * it ended. A meeting with no end that is not recording (a crash left it open, until main closes
 * it at the next start) gives only its start.
 */
export function meetingTimeLabel(
  meeting: MeetingSpan,
  recording: boolean,
  now: Date,
  locale?: string,
): string {
  const start = new Date(meeting.startedAt);
  const startDay = dayName(start, now, locale, !recording);
  if (recording) {
    const time = formatClock(start);
    return daysAgo(start, now) === 0 ? `Started ${time}` : `Started ${startDay}, ${time}`;
  }
  const from = `${startDay}, ${formatClock(start)}`;
  if (meeting.endedAt === null) return from;
  const end = new Date(meeting.endedAt);
  if (daysAgo(end, now) === daysAgo(start, now)) return `${from} to ${formatClock(end)}`;
  return `${from} to ${dayName(end, now, locale, false)}, ${formatClock(end)}`;
}
