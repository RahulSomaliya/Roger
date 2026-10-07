import { parseInstant, type TimedCalendarEvent } from '../../../shared/calendar';
import { attendeeSummary, eventTitle, startLabel, timeRange } from '../prompt/promptFormat';
import type { TodayEntry } from './todayGroups';

/** A timed event's row on Home. */
export type TimedEntry = TodayEntry<TimedCalendarEvent>;

/** What a meeting's button does: the events it starts a note for, and the notes it opens. */
export interface MeetingActions {
  /** A note is being taken or starting: a second Start waits for it. */
  startBlocked: boolean;
  onStart: (event: TimedCalendarEvent) => void;
  onOpen: (meetingId: string) => void;
}

/** The longest wait the card counts down in minutes; further out it only says "Next". */
const COUNTDOWN_WITHIN_MS = 60 * 60_000;

/**
 * The one button of a meeting: Open note when a local meeting already has the event (the newest
 * one), else Start notes from 15 minutes before the start to the end (todayGroups), else none.
 * Open note wins over Start notes: a second Start for an event that has its note would make a
 * second meeting for it.
 */
export function MeetingAction({
  entry,
  startBlocked,
  onStart,
  onOpen,
}: { entry: TimedEntry } & MeetingActions) {
  const { event, meetingId, startNotes } = entry;
  if (meetingId !== null) {
    return (
      <button
        type="button"
        className="btn calendar-action"
        data-variant="secondary"
        data-size="sm"
        aria-label={`Open note for ${eventTitle(event)}`}
        onClick={() => {
          onOpen(meetingId);
        }}
      >
        Open note
      </button>
    );
  }
  if (!startNotes) return null;
  return (
    <button
      type="button"
      className="btn calendar-action"
      data-variant="primary"
      data-size="sm"
      aria-label={`Start notes for ${eventTitle(event)}`}
      disabled={startBlocked}
      title={startBlocked ? 'Stop the note you are taking first.' : undefined}
      onClick={() => {
        onStart(event);
      }}
    >
      Start notes
    </button>
  );
}

export interface NextMeetingCardProps extends MeetingActions {
  entry: TimedEntry;
  nowMs: number;
}

/**
 * The meeting under way, or else the next to start (todayGroups `next`), larger than the rows
 * around it. An `<li>`: it sits in Home's list at its place in the day.
 */
export function NextMeetingCard({ entry, nowMs, ...actions }: NextMeetingCardProps) {
  const { event } = entry;
  const startMs = parseInstant(event.start);
  const underWay = startMs <= nowMs;
  const kicker = underWay ? 'Now' : 'Next';
  const countdown =
    underWay || startMs - nowMs <= COUNTDOWN_WITHIN_MS ? startLabel(event.start, nowMs) : null;
  const who = attendeeSummary(event);
  return (
    <li className="calendar-next" aria-label={`${kicker} meeting`}>
      <div className="calendar-next-text">
        <p className="calendar-kicker">
          {countdown === null ? kicker : `${kicker} · ${countdown}`}
        </p>
        <p className="calendar-title">{eventTitle(event)}</p>
        <p className="calendar-meta">
          {timeRange(event.start, event.end)}
          {who === null ? '' : ` · ${who}`}
        </p>
      </div>
      <MeetingAction entry={entry} {...actions} />
    </li>
  );
}
