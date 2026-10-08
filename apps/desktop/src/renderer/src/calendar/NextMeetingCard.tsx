import { parseInstant } from '../../../shared/calendar';
import { eventTitle, startLabel } from '../prompt/promptFormat';
import { createCalendarFormat } from './calendarFormat';
import type { TimedEntry } from './todayGroups';

export interface NextMeetingCardProps {
  entry: TimedEntry;
  nowMs: number;
}

/**
 * The meeting Home's Start notes is for (todayGroups `heroMeeting`): "Next · Starting in 2 min"
 * or "Now · Started 3 min ago", its title large, its hours. It has no button of its own: the one
 * Start notes is the hero's, under it (HomePage). A fragment, so the hero keeps the spacing.
 */
export function NextMeetingCard({ entry, nowMs }: NextMeetingCardProps) {
  const { event } = entry;
  const underWay = parseInstant(event.start) <= nowMs;
  // Per render, not at import: createCalendarFormat says why.
  const format = createCalendarFormat();
  return (
    <>
      <p className="overline home-hero-kicker">
        {underWay ? 'Now' : 'Next'} · {startLabel(event.start, nowMs)}
      </p>
      <h1 className="home-hero-title">{eventTitle(event)}</h1>
      <p className="home-hero-meta">
        {format.time(parseInstant(event.start))} to {format.time(parseInstant(event.end))}
      </p>
    </>
  );
}
