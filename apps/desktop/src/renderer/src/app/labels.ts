import type { CapturePhase } from '../../../shared/capture';
import { formatClock } from '../clock';

/** The recording state, as the meeting header and the recording chip say it. */
export const PHASE_LABEL: Readonly<Record<CapturePhase, string>> = {
  idle: 'Not recording',
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Stopping…',
};

/**
 * A meeting's name when the page has no title for it yet: "Meeting at 5:01 pm". The default title
 * main gives a new meeting is written in main (CaptureService); this is the renderer's copy of the
 * same words for a window that has not read the title (docs/design.md, Naming list).
 */
export function fallbackMeetingTitle(startedAtIso: string): string {
  return `Meeting at ${formatClock(new Date(startedAtIso))}`;
}

/** A start time as the clock on the wall reads it: 12-hour, lowercase, whatever the Mac is set to. */
export function formatClockTime(iso: string): string {
  return formatClock(new Date(iso));
}

const MINUTE_MS = 60_000;

/** Whole minutes from `sinceMs` to `nowMs`, rounded down, never negative. */
function wholeMinutes(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / MINUTE_MS));
}

/** The recording chip's time: "12m", "1h 23m". Whole minutes: a seconds counter never stops moving. */
export function formatElapsed(sinceMs: number, nowMs: number): string {
  const minutes = wholeMinutes(sinceMs, nowMs);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** The same time for a screen reader: "12 minutes", "1 hour 23 minutes". */
export function elapsedInWords(sinceMs: number, nowMs: number): string {
  const minutes = wholeMinutes(sinceMs, nowMs);
  if (minutes === 0) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return plural(minutes, 'minute');
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

const DAY_MS = 86_400_000;

/** Whole local days from `date` to `now`: 0 today, 1 yesterday. */
function daysAgo(date: Date, now: Date): number {
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day with a daylight saving change is 23 or 25 hours long.
  return Math.round((midnight(now) - midnight(date)) / DAY_MS);
}

/**
 * The day of a past meeting, Home's "Earlier" list: "Today", "Yesterday", else "Mon 5 Oct" (with
 * the year for another year). English, as the rest of Roger; the weekday and month come from a
 * fixed locale so a Mac set to another language does not mix its words into ours.
 */
export function meetingDayLabel(startedAtIso: string, now: Date): string {
  const start = new Date(startedAtIso);
  const ago = daysAgo(start, now);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(start.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).formatToParts(start);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const day = `${part('weekday')} ${part('day')} ${part('month')}`;
  return start.getFullYear() === now.getFullYear() ? day : `${day} ${part('year')}`;
}
