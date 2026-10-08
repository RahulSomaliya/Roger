import type { RerunStatus } from '../../../../shared/capture';
import { ProblemLine } from './ProblemLine';
import { describeRerun, RerunProgress } from './RerunProgress';
import type { AudioNoteView } from './reportText';
import './captureDetails.css';

/**
 * Main's own refusal (GapRetranscriber.rerunMeeting) while any recording runs: transcribing again
 * must never wait behind, or compete with, a live meeting's speech-to-text sessions (house rule 9).
 */
export const RERUN_BLOCKED_WHILE_RECORDING = 'Transcribe again once the recording stops.';

/** What a button is doing while main answers: transcribing again lasts until every part is done. */
export type AudioBusy = 'rerun' | 'delete' | null;

/** The one secondary button of both places that transcribe again. Busy is `aria-disabled`, not `disabled`. */
function RerunButton({ busy, onRerun }: { busy: boolean; onRerun: () => void }) {
  return (
    <button
      type="button"
      className="btn"
      data-variant="secondary"
      data-size="sm"
      aria-disabled={busy ? 'true' : undefined}
      onClick={() => {
        // CSS stops the pointer only: Enter and Space still click a busy button.
        if (!busy) onRerun();
      }}
    >
      {busy ? 'Transcribing again…' : 'Transcribe again'}
    </button>
  );
}

export interface GapLineProps {
  /** Parts of the meeting no vendor session heard and nothing has transcribed again yet. */
  parts: number;
  /** This meeting's transcribing again in progress, or null. */
  rerun: RerunStatus | null;
  /** The audio is kept for it (AudioNoteView.canRerun). */
  canRerun: boolean;
  /** Why it is refused right now (RERUN_BLOCKED_WHILE_RECORDING), or null. */
  rerunBlockedBy: string | null;
  /** A click is waiting for main. */
  busy: boolean;
  /** Why the last attempt failed (main's words), or null. */
  error: string | null;
  onRerun: () => void;
}

/**
 * The gap line under the meeting header (the `meetingAudioNote` region): "2 parts were not
 * transcribed" with Transcribe again beside it, or its progress in place of both. Nothing when
 * every part is transcribed. It is a quiet status, not an alert: Roger starts transcribing again
 * by itself after Stop, and the button is for when that did not finish. A part that can no longer
 * be transcribed (its audio deleted) is still said: the transcript has a hole.
 */
export function GapLine({
  parts: missing,
  rerun,
  canRerun,
  rerunBlockedBy,
  busy,
  error,
  onRerun,
}: GapLineProps) {
  const failure = error === null ? null : <ProblemLine loud>{error}</ProblemLine>;
  if (rerun !== null) {
    return (
      <>
        <ProblemLine loud={false}>{describeRerun(rerun)}</ProblemLine>
        {failure}
      </>
    );
  }
  if (missing === 0) return failure;
  const blocked = canRerun && rerunBlockedBy !== null;
  return (
    <>
      <ProblemLine
        loud={false}
        action={canRerun && !blocked ? <RerunButton busy={busy} onRerun={onRerun} /> : undefined}
      >
        {missing === 1 ? '1 part was not transcribed' : `${missing} parts were not transcribed`}
        {blocked ? <span className="problem-since"> · {rerunBlockedBy}</span> : null}
      </ProblemLine>
      {failure}
    </>
  );
}

export interface KeptAudioProps {
  view: AudioNoteView;
  rerunBlockedBy: string | null;
  busy: AudioBusy;
  /** The delete asked for its confirmation. */
  confirming: boolean;
  /** Why the last Transcribe again or Delete failed (main's words), or null. */
  error: string | null;
  /** This meeting's transcribing again in progress, or null. */
  rerun: RerunStatus | null;
  onRerun: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * The kept audio, in Details (the `meetingCaptureReport` region): until when it stays, how many
 * parts are not transcribed yet, Transcribe again (secondary) and Delete audio (ghost). The
 * delete asks in place: the audio is the only copy, and a deleted meeting's parts can never be
 * transcribed again, so the same button reads "Delete" and its question stands beside it. It is
 * not offered for a meeting still recording: main refuses that too (AudioBackup.deleteMeetingAudio).
 * The words are reportText's `audioNote`.
 */
export function KeptAudio({
  view,
  rerun,
  rerunBlockedBy,
  busy,
  confirming,
  error,
  onRerun,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: KeptAudioProps) {
  const rerunBusy = busy === 'rerun' || rerun !== null;
  const blocked = view.canRerun && rerunBlockedBy !== null;
  return (
    <section className="details-section audio-kept" aria-label="Audio kept">
      <h3 className="details-heading">Audio</h3>
      <p className="audio-kept-text">{view.text}</p>
      {rerun === null ? null : <RerunProgress rerun={rerun} />}
      {view.canRerun || view.canDelete ? (
        <div className="audio-actions">
          {view.canRerun && !blocked ? <RerunButton busy={rerunBusy} onRerun={onRerun} /> : null}
          {view.canDelete && !confirming ? (
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-disabled={busy === 'delete' ? 'true' : undefined}
              onClick={() => {
                if (busy !== 'delete') onAskDelete();
              }}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete audio'}
            </button>
          ) : null}
          {view.canDelete && confirming ? (
            <div className="audio-confirm" role="group" aria-label="Confirm delete">
              <span className="audio-confirm-text">Delete audio? Its lines stay.</span>
              <button
                type="button"
                className="btn"
                data-variant="secondary"
                data-size="sm"
                aria-disabled={busy === 'delete' ? 'true' : undefined}
                onClick={() => {
                  // Busy is aria-disabled, which CSS cannot enforce against the keyboard.
                  if (busy !== 'delete') onConfirmDelete();
                }}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                data-size="sm"
                onClick={onCancelDelete}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {blocked ? <p className="audio-actions-hint">{rerunBlockedBy}</p> : null}
      {error === null ? null : <ProblemLine loud>{error}</ProblemLine>}
    </section>
  );
}
