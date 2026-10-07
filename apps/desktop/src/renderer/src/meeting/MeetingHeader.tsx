import type { CapturePhase } from '../../../shared/capture';
import { PHASE_LABEL } from '../app/labels';

interface MeetingHeaderProps {
  title: string;
  /** True while main has not answered the first read: the title is a placeholder. */
  pending: boolean;
  /** When it ran (meetingTimes.ts), or null when unknown. */
  time: string | null;
  /** This meeting's phase (meetingPhase), never main's alone. */
  phase: CapturePhase;
  /** A start or stop is running: Stop waits for it. */
  busy: boolean;
  onStop: () => void;
}

/**
 * The meeting's title, when it ran and, while Roger records it, the recording state and Stop. Stop
 * stays here, on the meeting, as in M1's window: the sidebar's live item only opens this page.
 */
export function MeetingHeader({ title, pending, time, phase, busy, onStop }: MeetingHeaderProps) {
  return (
    <header className="page-header meeting-header">
      <div className="page-header-text">
        <h1 className={pending ? 'page-title meeting-title-pending' : 'page-title'}>{title}</h1>
        {/*
          Always a line, blank until the time is known: a header that grows when main answers
          shrinks the transcript under it after it scrolled to its newest line, cutting that off.
        */}
        <p className="page-meta" aria-hidden={time === null ? true : undefined}>
          {time ?? '\u00a0'}
        </p>
      </div>
      {phase !== 'idle' ? (
        <span className={`meeting-phase meeting-phase-${phase}`}>
          {phase === 'recording' ? <span className="recording-dot" aria-hidden="true" /> : null}
          {PHASE_LABEL[phase]}
        </span>
      ) : null}
      {phase === 'recording' ? (
        <button type="button" className="button stop" disabled={busy} onClick={onStop}>
          Stop
        </button>
      ) : null}
    </header>
  );
}
