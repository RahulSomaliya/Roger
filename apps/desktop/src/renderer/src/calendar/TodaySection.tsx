import { useEffect, useId } from 'react';
import { parseInstant, type TimedCalendarEvent } from '../../../shared/calendar';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import { Icon } from '../components/ui/icons';
import { eventTitle } from '../prompt/promptFormat';
import { calendarProblem, createCalendarFormat } from './calendarFormat';
import type { CalendarState } from './calendarStore';
import { ConnectCalendarCard } from './ConnectCalendarCard';
import { startRequestForEvent } from './startRequest';
import { heroMeeting, todayGroups, type TimedEntry } from './todayGroups';
import { useCalendar, useNow } from './useCalendar';
import './today.css';

/** What a row's button does: the events it starts notes for, and the notes it opens. */
export interface MeetingActions {
  /** A note is being taken or starting: no row offers Start notes until it ends. */
  startBlocked: boolean;
  onStart: (event: TimedCalendarEvent) => void;
  onOpen: (meetingId: string) => void;
}

export interface TodaySectionViewProps extends MeetingActions {
  state: CalendarState;
  nowMs: number;
  /**
   * The event Home's hero has Start notes for (HomePage): its row shows no button of its own, so
   * one meeting never has two Starts on screen.
   */
  heroEventId: string | null;
  onConnect: () => void;
  onReload: () => void;
}

/**
 * Home's "Today" (M5-T12; the hero above it has the one Start notes): the connect line while no
 * calendar is connected, otherwise today's timed meetings, a time and a title each, and a ghost
 * Start notes (or Open note, once a local meeting has the event) on hover. One quiet line says
 * what is wrong with the calendar, Reconnect or Try again beside it. The day is absent when it
 * has nothing to say: no heading, no "Nothing on your calendar today".
 */
export function TodaySection() {
  const { state, store } = useCalendar();
  const { capture, captureMeeting, navigate, startNewNote } = useShell();
  const nowMs = useNow();

  // Open note reads main's lookup, which only knows a meeting once it exists: ask again when the
  // recording's meeting changes, or a note started from this very list shows Start notes again.
  const recordingMeetingId = capture.status?.meetingId ?? null;
  const { events } = state;
  useEffect(() => {
    // The whole copy (three days), not today's: the lookup is one indexed query, and Home need
    // not cut the day here a second time (todayGroups does it).
    const ids = events.flatMap((event) => (event.allDay ? [] : [event.id]));
    void store.refreshLinks(ids);
  }, [store, events, recordingMeetingId]);

  const hero = heroMeeting(todayGroups({ events: state.events, links: state.links, nowMs }), nowMs);
  return (
    <TodaySectionView
      state={state}
      nowMs={nowMs}
      startBlocked={meetingPhase(captureMeeting, capture.status) !== 'idle' || capture.busy}
      heroEventId={hero?.event.id ?? null}
      onStart={(event) => {
        startNewNote(startRequestForEvent(event));
      }}
      onOpen={(meetingId) => {
        navigate({ name: 'meeting', meetingId });
      }}
      onConnect={() => {
        void store.connect();
      }}
      onReload={() => {
        store.reload();
      }}
    />
  );
}

/** The section for one calendar state. */
export function TodaySectionView(props: TodaySectionViewProps) {
  const { state } = props;
  if (state.connectionStatus === 'loading' && !state.loaded && state.copyError === null) {
    return (
      <p className="calendar-status" role="status">
        Loading your calendar…
      </p>
    );
  }
  // A disconnect clears the copy: with no account and no events there is no day to show.
  if (state.connection === null && state.events.length === 0) {
    if (state.connectionStatus === 'failed') {
      return (
        <ProblemLine
          text={`Roger could not reach your Google Calendar connection: ${state.connectionError ?? 'no reason given'}`}
          action={{ label: 'Try again', onPress: props.onReload }}
          role="alert"
        />
      );
    }
    return (
      <ConnectCalendarCard
        connecting={state.connecting}
        error={state.connectError}
        onConnect={props.onConnect}
      />
    );
  }
  return <TodayDay {...props} />;
}

function TodayDay({
  state,
  nowMs,
  heroEventId: heroId,
  startBlocked,
  onStart,
  onOpen,
  onReload,
  onConnect,
}: TodaySectionViewProps) {
  const headingId = useId();
  // Per render, not at import: createCalendarFormat says why.
  const format = createCalendarFormat();
  const { timed } = todayGroups({ events: state.events, links: state.links, nowMs });
  const problem = calendarProblem({ state, nowMs, format });
  // The day is absent when it has nothing to show or say.
  if (timed.length === 0 && problem === null) return null;
  return (
    <section className="today" aria-labelledby={headingId}>
      <h2 id={headingId} className="overline">
        Today
      </h2>
      {problem === null ? null : (
        <ProblemLine
          text={problem.text}
          action={
            problem.action === null
              ? null
              : {
                  label: problem.action === 'reconnect' ? 'Reconnect' : 'Try again',
                  onPress: problem.action === 'reconnect' ? onConnect : onReload,
                }
          }
          role="status"
        />
      )}
      {state.connecting ? (
        <p className="calendar-status" role="status">
          Finish signing in in your browser. Roger waits up to 3 minutes.
        </p>
      ) : null}
      {state.connectError === null ? null : (
        <ProblemLine
          text={`Roger could not connect Google Calendar: ${state.connectError}`}
          action={null}
          role="alert"
        />
      )}
      {timed.length === 0 ? null : (
        <ul className="today-list" aria-label="Today’s meetings">
          {timed.map((entry) => (
            <TodayRow
              key={entry.event.id}
              entry={entry}
              nowMs={nowMs}
              showAction={entry.event.id !== heroId}
              startBlocked={startBlocked}
              onStart={onStart}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ProblemLineProps {
  text: string;
  action: { label: string; onPress: () => void } | null;
  /** `alert` for what the user just did and it failed; `status` for the calendar's own state. */
  role: 'alert' | 'status';
}

/** The problem line (styles.css .problem) with at most one secondary button. */
function ProblemLine({ text, action, role }: ProblemLineProps) {
  return (
    <div className="problem today-problem" role={role}>
      <Icon name="circle-alert" />
      <span className="problem-text">{text}</span>
      {action === null ? null : (
        <button type="button" className="btn" data-size="sm" onClick={action.onPress}>
          {action.label}
        </button>
      )}
    </div>
  );
}

interface TodayRowProps extends MeetingActions {
  entry: TimedEntry;
  nowMs: number;
  /** False for the hero's meeting. */
  showAction: boolean;
}

/** A time and a title; the button is in a fixed right column, so showing it moves nothing. */
function TodayRow({ entry, nowMs, showAction, ...actions }: TodayRowProps) {
  const { event } = entry;
  const format = createCalendarFormat();
  const title = eventTitle(event);
  return (
    <li className="today-row" data-over={parseInstant(event.end) <= nowMs ? 'true' : undefined}>
      <span className="today-time">{format.time(parseInstant(event.start))}</span>
      <span className="today-title" title={title}>
        {title}
      </span>
      {showAction ? <MeetingAction entry={entry} {...actions} /> : null}
    </li>
  );
}

/**
 * A row's one button: Open note when a local meeting already has the event (the newest one), else
 * Start notes from 15 minutes before the start to the end (todayGroups), else none. Open note
 * wins over Start notes: a second Start for an event that has its note would make a second
 * meeting for it. While a note is being taken there is no Start at all (one recording at a time:
 * the hero shows Stop), not a disabled one with a reason beside every row.
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
        className="btn today-action"
        data-variant="ghost"
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
  if (!startNotes || startBlocked) return null;
  return (
    <button
      type="button"
      className="btn today-action"
      data-variant="ghost"
      data-size="sm"
      aria-label={`Start notes for ${eventTitle(event)}`}
      onClick={() => {
        onStart(event);
      }}
    >
      Start notes
    </button>
  );
}
