import { useCallback, useEffect, useId, useState } from 'react';
import { parseInstant, type TimedCalendarEvent } from '../../../shared/calendar';
import { LOGIN_ITEMS_SETTINGS_PATH } from '../../../shared/ipc/loginItem';
import { describeError } from '../app/describeError';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import { eventTitle, attendeeSummary, timeRange } from '../prompt/promptFormat';
import { createCalendarFormat } from './calendarFormat';
import type { CalendarState } from './calendarStore';
import { ConnectCalendarCard } from './ConnectCalendarCard';
import {
  MeetingAction,
  NextMeetingCard,
  type MeetingActions,
  type TimedEntry,
} from './NextMeetingCard';
import { startRequestForEvent } from './startRequest';
import { todayGroups } from './todayGroups';
import { useCalendar, useCalendarSettings, useNow } from './useCalendar';
import './calendar.css';

/** The line after the first connect, by what it says (OpenAtLoginLine). */
export type OpenAtLoginPhase = 'on' | 'approval' | 'undone';

export interface TodaySectionViewProps extends MeetingActions {
  state: CalendarState;
  nowMs: number;
  /** Why the last Start notes failed before main could answer, or null. */
  startError: string | null;
  /** The line after the first connect, or null when there is none to show. */
  openAtLogin: { phase: OpenAtLoginPhase; error: string | null } | null;
  onConnect: () => void;
  onReload: () => void;
  onUndoOpenAtLogin: () => void;
  onDismissOpenAtLogin: () => void;
}

/**
 * Home's "Today" (M5-T12; M5-T13 mounts it in the shell's `home` slot): the connect card while no
 * calendar is connected, otherwise today's meetings with the next one first among them, a button
 * per meeting (Start notes, or Open note once a local meeting has the event) and the day's
 * all-day events in a strip. The status banner (stale, reconnect) is its own component in the
 * banner slot, above every page.
 */
export function TodaySection() {
  const { state, store } = useCalendar();
  const settings = useCalendarSettings();
  const { capture, captureMeeting, navigate } = useShell();
  const nowMs = useNow();
  const [startError, setStartError] = useState<string | null>(null);
  const [openAtLoginUndone, setOpenAtLoginUndone] = useState(false);

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

  const startBlocked = meetingPhase(captureMeeting, capture.status) !== 'idle' || capture.busy;
  const { start } = capture;
  const onStart = useCallback(
    (event: TimedCalendarEvent) => {
      setStartError(null);
      const run = async (): Promise<void> => {
        await start(startRequestForEvent(event));
        // start() resolves after the microphone started, or after main refused or the microphone
        // failed (the banner shows both); only a recording opens the meeting. As the shell's New
        // note does (ShellContext.startNewNote), which cannot take a request.
        const now = await window.roger.getCaptureStatus();
        if (now.phase === 'recording' && now.meetingId !== null) {
          navigate({ name: 'meeting', meetingId: now.meetingId });
        }
      };
      run().catch((error: unknown) => {
        setStartError(`Roger could not start notes for this meeting: ${describeError(error)}`);
      });
    },
    [start, navigate],
  );

  const loginItem = settings.state.loginItem;
  let phase: OpenAtLoginPhase | null = null;
  if (state.justConnected) {
    if (openAtLoginUndone) phase = 'undone';
    else if (loginItem === 'enabled') phase = 'on';
    else if (loginItem === 'requires-approval') phase = 'approval';
  }

  return (
    <TodaySectionView
      state={state}
      nowMs={nowMs}
      startError={startError}
      startBlocked={startBlocked}
      openAtLogin={phase === null ? null : { phase, error: settings.state.saveError }}
      onStart={onStart}
      onOpen={(meetingId) => {
        navigate({ name: 'meeting', meetingId });
      }}
      onConnect={() => {
        void store.connect();
      }}
      onReload={() => {
        store.reload();
      }}
      onUndoOpenAtLogin={() => {
        void settings.store.choose('app.openAtLogin', 'off').then(() => {
          // choose() never rejects: a refused save leaves the preference, and the line, as they were.
          if (settings.store.getState().saveError === null) setOpenAtLoginUndone(true);
        });
      }}
      onDismissOpenAtLogin={() => {
        setOpenAtLoginUndone(false);
        store.dismissConnectedLine();
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
        <section className="card calendar-connect" aria-label="Google Calendar">
          <div className="error" role="alert">
            Roger could not reach your Google Calendar connection: {state.connectionError}
          </div>
          <div className="calendar-connect-actions">
            <button type="button" className="shell-button" onClick={props.onReload}>
              Try again
            </button>
          </div>
        </section>
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
  startError,
  startBlocked,
  openAtLogin,
  onStart,
  onOpen,
  onReload,
  onUndoOpenAtLogin,
  onDismissOpenAtLogin,
}: TodaySectionViewProps) {
  const headingId = useId();
  // Per render, not at import: createCalendarFormat says why.
  const format = createCalendarFormat();
  const groups = todayGroups({ events: state.events, links: state.links, nowMs });
  const actions = { startBlocked, onStart, onOpen };
  const nothing = groups.allDay.length === 0 && groups.timed.length === 0;
  return (
    <section className="calendar-today" aria-labelledby={headingId}>
      <div className="calendar-today-head">
        <h2 id={headingId} className="calendar-today-title">
          Today
        </h2>
        <p className="calendar-today-date">{format.date(nowMs)}</p>
      </div>
      {openAtLogin === null ? null : (
        <OpenAtLoginLine
          phase={openAtLogin.phase}
          error={openAtLogin.error}
          onUndo={onUndoOpenAtLogin}
          onDismiss={onDismissOpenAtLogin}
        />
      )}
      {state.connectionStatus === 'failed' ? (
        <div className="error calendar-problem" role="alert">
          <span>
            Roger could not check your Google Calendar connection: {state.connectionError}. The
            meetings below are the last it saved.
          </span>
          <button type="button" className="shell-button" onClick={onReload}>
            Try again
          </button>
        </div>
      ) : null}
      {state.copyError === null ? null : (
        <div className="error calendar-problem" role="alert">
          <span>Roger could not read your calendar: {state.copyError}</span>
          <button type="button" className="shell-button" onClick={onReload}>
            Try again
          </button>
        </div>
      )}
      {startError === null ? null : (
        <div className="error calendar-problem" role="alert">
          {startError}
        </div>
      )}
      {state.linksError === null ? null : (
        <p className="calendar-status" role="status">
          Roger could not check which meetings already have notes: {state.linksError}
        </p>
      )}
      {groups.allDay.length === 0 ? null : (
        <ul className="calendar-allday" aria-label="All-day events">
          {groups.allDay.map((entry) => (
            <li
              key={entry.event.id}
              className={entry.declined ? 'calendar-chip calendar-declined' : 'calendar-chip'}
            >
              {eventTitle(entry.event)}
              {entry.declined ? ' (declined)' : ''}
            </li>
          ))}
        </ul>
      )}
      {nothing && state.loaded ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing on your calendar today</p>
          <p className="empty-state-text">Press New note when a call starts.</p>
        </div>
      ) : null}
      {groups.timed.length === 0 ? null : (
        <ul className="calendar-list" aria-label="Today’s meetings">
          {groups.timed.map((entry) =>
            entry === groups.next ? (
              <NextMeetingCard key={entry.event.id} entry={entry} nowMs={nowMs} {...actions} />
            ) : (
              <TodayRow key={entry.event.id} entry={entry} nowMs={nowMs} {...actions} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function TodayRow({
  entry,
  nowMs,
  ...actions
}: { entry: TimedEntry; nowMs: number } & MeetingActions) {
  const { event } = entry;
  const over = parseInstant(event.end) <= nowMs;
  const who = attendeeSummary(event);
  const meta = [entry.declined ? 'Declined' : null, who]
    .filter((part) => part !== null)
    .join(' · ');
  const classes = ['calendar-row'];
  if (entry.declined) classes.push('calendar-declined');
  else if (over) classes.push('calendar-over');
  return (
    <li className={classes.join(' ')}>
      <span className="calendar-when">{timeRange(event.start, event.end)}</span>
      <div className="calendar-what">
        <p className="calendar-title">{eventTitle(event)}</p>
        {meta === '' ? null : <p className="calendar-meta">{meta}</p>}
      </div>
      <MeetingAction entry={entry} {...actions} />
    </li>
  );
}

export interface OpenAtLoginLineProps {
  phase: OpenAtLoginPhase;
  /** Why Undo could not be saved, or null. */
  error: string | null;
  onUndo: () => void;
  onDismiss: () => void;
}

/**
 * The line after the first connect: Roger turned open at login on (main does, for a packaged
 * build) and says so, with Undo, because a menu bar app that starts itself should not surprise
 * anyone. When macOS waits for the user's approval it says where to give it instead, since a login
 * item nobody allowed misses the first call of every day.
 */
export function OpenAtLoginLine({ phase, error, onUndo, onDismiss }: OpenAtLoginLineProps) {
  return (
    <div className="notice calendar-login" role="status">
      <span className="calendar-login-text">
        {phase === 'on' ? 'Roger will open at login so it can remind you.' : null}
        {phase === 'approval'
          ? `Roger needs your OK to open at login. Allow it in ${LOGIN_ITEMS_SETTINGS_PATH}.`
          : null}
        {phase === 'undone'
          ? 'Roger will not open at login. You can change this in Settings.'
          : null}
        {error === null ? null : ` Roger could not undo it: ${error}`}
      </span>
      {phase === 'on' ? (
        <button type="button" className="shell-button" onClick={onUndo}>
          Undo
        </button>
      ) : null}
      <button type="button" className="shell-button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
