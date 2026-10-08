import { daysAgo, meetingDayLabel } from '../app/labels';
import { meetingHours } from '../../../shared/clock';
import { formatClock } from '../clock';

/**
 * When a meeting ran, as Home's list and the meeting header say it. The clock is formatClock's
 * (12-hour, lowercase, never the Mac's 24-hour setting) and the date is Home's `meetingDayLabel`
 * ("Mon 5 Oct"), both pinned to English (docs/design.md, Copy). Never `toLocaleDateString` here:
 * the system locale wrote "Mon, Oct 5" on an English-US Mac, a second form for the same day.
 */

interface MeetingSpan {
  /** ISO 8601 instants, UTC. */
  startedAt: string;
  endedAt: string | null;
}

/** "Today", "Yesterday" (lowercase mid-sentence), else Home's "Mon 5 Oct". */
function dayName(date: Date, now: Date, leading: boolean): string {
  const ago = daysAgo(date, now);
  if (ago === 0) return leading ? 'Today' : 'today';
  if (ago === 1) return leading ? 'Yesterday' : 'yesterday';
  return meetingDayLabel(date.toISOString(), now);
}

/**
 * The meeting header's line once a meeting ended: "Today, 9:30 am to 9:41 am". The hours are
 * shared/clock.ts `meetingHours`, the one form Home and the prompt panel write too. A meeting with
 * no end (a crash left it open, until main closes it at the next start) gives only its start.
 *
 * Not asked while the meeting records: the header has no time line then, because the status line
 * already says "Recording · 39m" and a "Started 2:56 pm" beside it told the time twice (R9).
 */
export function meetingTimeLabel(meeting: MeetingSpan, now: Date): string {
  const start = new Date(meeting.startedAt);
  const from = `${dayName(start, now, true)}, `;
  if (meeting.endedAt === null) return `${from}${formatClock(start)}`;
  const end = new Date(meeting.endedAt);
  if (daysAgo(end, now) === daysAgo(start, now)) return `${from}${meetingHours(start, end)}`;
  return `${from}${formatClock(start)} to ${dayName(end, now, false)}, ${formatClock(end)}`;
}
