import type { CapturePhase } from '../../../shared/capture';
import { NextMeetingCard } from '../calendar/NextMeetingCard';
import { startRequestForEvent } from '../calendar/startRequest';
import { heroMeeting, todayGroups, type TimedEntry } from '../calendar/todayGroups';
import { TodaySection } from '../calendar/TodaySection';
import { useCalendar, useNow } from '../calendar/useCalendar';
import { recentMeetingsKey } from '../meeting/recentMeetingsKey';
import { useRecentMeetings } from '../meeting/useMeeting';
import { meetingPhase } from './captureMeeting';
import { Earlier } from './Earlier';
import { fallbackMeetingTitle, formatClockTime, PHASE_LABEL } from './labels';
import { useShell } from './ShellContext';

/**
 * Home, three groups: the hero (the one primary: Start notes, or Stop while a call records),
 * Today's meetings, and Earlier's past ones. Nothing else: no "Home" heading, no empty-state
 * cards, no recording card (the hero is it), no kept-audio card (a meeting with a gap says so on
 * its own page).
 */
export function HomePage() {
  const { capture, captureMeeting, navigate, startNewNote, stopRecording } = useShell();
  const { state } = useCalendar();
  const nowMs = useNow();
  // Read again when a recording starts or stops, never on main's idle heartbeat: the key is a
  // string built from what changes the list (recentMeetingsKey), never the status object.
  const recent = useRecentMeetings(recentMeetingsKey(capture.status, capture.lastMeetingId));

  const livePhase = meetingPhase(captureMeeting, capture.status);
  const liveMeeting = livePhase !== 'idle' ? captureMeeting : null;
  const liveSummary = recent.value?.find((meeting) => meeting.id === liveMeeting?.id);
  // Until the list answers the title is unknown, and a guessed one would flip to the real one.
  const liveTitle =
    recent.value === undefined
      ? null
      : (liveSummary?.title ??
        (liveMeeting?.startedAt == null ? null : fallbackMeetingTitle(liveMeeting.startedAt)));

  const subject =
    liveMeeting === null
      ? heroMeeting(todayGroups({ events: state.events, links: state.links, nowMs }), nowMs)
      : null;

  return (
    <div className="home">
      <HomeHero
        phase={capture.status?.phase ?? 'idle'}
        startBusy={capture.busy}
        live={
          liveMeeting === null
            ? null
            : { id: liveMeeting.id, title: liveTitle, startedAt: liveMeeting.startedAt }
        }
        subject={subject}
        nowMs={nowMs}
        onStart={() => {
          // Never `onClick={startNewNote}`: the click event would arrive as the start request.
          startNewNote(subject === null ? undefined : startRequestForEvent(subject.event));
        }}
        onStop={stopRecording}
        onOpenLive={() => {
          if (liveMeeting !== null) navigate({ name: 'meeting', meetingId: liveMeeting.id });
        }}
      />
      <TodaySection />
      <Earlier
        meetings={recent.value}
        liveId={liveMeeting?.id ?? null}
        error={recent.error}
        now={new Date(nowMs)}
        onOpen={(meetingId) => {
          navigate({ name: 'meeting', meetingId });
        }}
        onRetry={recent.refresh}
      />
    </div>
  );
}

export interface HomeHeroProps {
  /** Main's phase: `starting` shows before any meeting is named (meetingPhase). */
  phase: CapturePhase;
  /** A start from this window is waiting on main (useCapture `busy`). */
  startBusy: boolean;
  /** The meeting Roger records or stops, or null; `title` is null until the list has answered. */
  live: { id: string; title: string | null; startedAt: string | null } | null;
  /** The meeting Start notes is for (todayGroups `heroMeeting`), or null for a blank note. */
  subject: TimedEntry | null;
  nowMs: number;
  onStart: () => void;
  onStop: () => void;
  onOpenLive: () => void;
}

/**
 * The one primary of Home. Idle: Start notes (`lg`), under the meeting it is for when one starts
 * within 10 minutes or is on now. Recording: the live meeting, its title opening it, and Stop. A
 * busy button keeps its colour, says what it is doing and takes no clicks (`aria-disabled`, with
 * the handler returning early: Enter and Space still click it); `disabled` would read as "can't".
 */
export function HomeHero({
  phase,
  startBusy,
  live,
  subject,
  nowMs,
  onStart,
  onStop,
  onOpenLive,
}: HomeHeroProps) {
  if (live !== null) {
    const stopping = phase === 'stopping';
    return (
      <div className="home-hero">
        <p className="overline home-hero-kicker">
          <span className="recording-dot" aria-hidden="true" />
          {stopping ? PHASE_LABEL.stopping : PHASE_LABEL.recording}
          {live.startedAt === null ? '' : ` · started ${formatClockTime(live.startedAt)}`}
        </p>
        {live.title === null ? null : (
          <h1 className="home-hero-title">
            <button type="button" className="home-hero-link" onClick={onOpenLive}>
              {live.title}
            </button>
          </h1>
        )}
        <button
          type="button"
          className="btn"
          data-variant="primary"
          aria-disabled={stopping ? 'true' : undefined}
          onClick={() => {
            if (!stopping) onStop();
          }}
        >
          {stopping ? PHASE_LABEL.stopping : 'Stop'}
        </button>
      </div>
    );
  }
  const busy = phase !== 'idle' || startBusy;
  return (
    <div className="home-hero">
      {subject === null ? null : <NextMeetingCard entry={subject} nowMs={nowMs} />}
      <button
        type="button"
        className="btn"
        data-variant="primary"
        data-size="lg"
        aria-disabled={busy ? 'true' : undefined}
        onClick={() => {
          if (!busy) onStart();
        }}
      >
        {busy ? (phase === 'idle' ? PHASE_LABEL.starting : PHASE_LABEL[phase]) : 'Start notes'}
      </button>
    </div>
  );
}
