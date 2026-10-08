import { daysAgo, meetingDayLabel } from '../app/labels';
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
 * The meeting header's line: "Started 9:05 am" while it records, "Today, 9:30 am to 9:41 am" once
 * it ended. A meeting with no end that is not recording (a crash left it open, until main closes
 * it at the next start) gives only its start.
 */
export function meetingTimeLabel(meeting: MeetingSpan, recording: boolean, now: Date): string {
  const start = new Date(meeting.startedAt);
  const startDay = dayName(start, now, !recording);
  if (recording) {
    const time = formatClock(start);
    return daysAgo(start, now) === 0 ? `Started ${time}` : `Started ${startDay}, ${time}`;
  }
  const from = `${startDay}, ${formatClock(start)}`;
  if (meeting.endedAt === null) return from;
  const end = new Date(meeting.endedAt);
  if (daysAgo(end, now) === daysAgo(start, now)) return `${from} to ${formatClock(end)}`;
  return `${from} to ${dayName(end, now, false)}, ${formatClock(end)}`;
}
