import type { RerunStatus } from '../../../../shared/capture';
import type { MeetingKeptForRerun } from '../../../../shared/ipc/capture';
import { RerunProgress } from './RerunProgress';
import { type AudioNoteView, formatKeepDate } from './reportText';
import './captureDetails.css';

/**
 * Main's own refusal (GapRetranscriber.rerunMeeting) while any recording runs: a re-run must never
 * wait behind, or compete with, a live meeting's speech-to-text sessions (house rule 9).
 */
export const RERUN_BLOCKED_WHILE_RECORDING =
  'Roger is recording: gaps are re-run once the recording stops.';

/** What a button is doing while main answers: a re-run lasts until every gap is done. */
export type AudioBusy = 'rerun' | 'delete' | null;

interface AudioActionsProps {
  canRerun: boolean;
  canDelete: boolean;
  /** Why a re-run is refused right now (RERUN_BLOCKED_WHILE_RECORDING), or null. */
  rerunBlockedBy: string | null;
  busy: AudioBusy;
  /** The delete asked for its confirmation. */
  confirming: boolean;
  /** The meeting's name, for what a screen reader says on each button. */
  about: string;
  onRerun: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * Re-run and Delete audio, shared by the meeting's note and Home's card. The delete asks first: the
 * audio is the only copy, and a deleted meeting's gaps can never be re-run. It is not offered for a
 * meeting still recording: main refuses that too (AudioBackup.deleteMeetingAudio).
 */
function AudioActions({
  canRerun,
  canDelete,
  rerunBlockedBy,
  busy,
  confirming,
  about,
  onRerun,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: AudioActionsProps) {
  if (!canRerun && !canDelete) return null;
  return (
    <div className="audio-actions">
      {canRerun ? (
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          aria-label={`Re-run gaps of ${about}`}
          disabled={rerunBlockedBy !== null || busy !== null}
          onClick={onRerun}
        >
          Re-run gaps
        </button>
      ) : null}
      {canDelete && !confirming ? (
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          aria-label={`Delete the audio of ${about}`}
          disabled={busy !== null}
          onClick={onAskDelete}
        >
          Delete audio
        </button>
      ) : null}
      {canDelete && confirming ? (
        <div className="audio-confirm" role="group" aria-label="Confirm delete">
          <span className="audio-confirm-text">Delete this meeting’s audio? Its lines stay.</span>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            data-size="sm"
            aria-label={`Delete the audio of ${about} for good`}
            disabled={busy !== null}
            onClick={onConfirmDelete}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            disabled={busy !== null}
            onClick={onCancelDelete}
          >
            Keep it
          </button>
        </div>
      ) : null}
    </div>
  );
}

export interface AudioNoteProps {
  view: AudioNoteView;
  rerunBlockedBy: string | null;
  busy: AudioBusy;
  confirming: boolean;
  /** Why the last Re-run or Delete failed (main's words), or null. */
  error: string | null;
  /** This meeting's re-run in progress, or null. */
  rerun: RerunStatus | null;
  onRerun: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * The meeting page's audio note (the `meetingAudioNote` region): "Audio kept until 4 Nov", "kept
 * for a re-run", the delete, and the re-run's progress. The words are reportText's `audioNote`.
 */
export function AudioNote({ view, rerun, error, ...actions }: AudioNoteProps) {
  return (
    <section className="panel audio-note" aria-label="Audio kept" data-tone={view.tone}>
      <p className="audio-note-text">{view.text}</p>
      {rerun === null ? null : <RerunProgress rerun={rerun} />}
      <AudioActions
        canRerun={view.canRerun}
        canDelete={view.canDelete}
        about="this meeting"
        {...actions}
      />
      {view.canRerun && actions.rerunBlockedBy !== null ? (
        <p className="audio-actions-hint">{actions.rerunBlockedBy}</p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="error audio-error">
          {error}
        </p>
      )}
    </section>
  );
}

export interface KeptForRerunProps {
  meetings: readonly MeetingKeptForRerun[];
  now: Date;
  /** The re-run in progress, of any meeting (CaptureStatus.rerun). */
  rerun: RerunStatus | null;
  rerunBlockedBy: string | null;
  /** The action in flight, and for which meeting. */
  busy: { meetingId: string; action: Exclude<AudioBusy, null> } | null;
  /** The meeting whose delete asked for its confirmation. */
  confirming: string | null;
  error: string | null;
  /** Why the list could not be read, or null. */
  listError: string | null;
  onOpen: (meetingId: string) => void;
  onRerun: (meetingId: string) => void;
  onAskDelete: (meetingId: string) => void;
  onConfirmDelete: (meetingId: string) => void;
  onCancelDelete: () => void;
}

/**
 * Home's card (the `home` slot): the meetings whose audio is kept for a re-run, newest first
 * (`listMeetingsKeptForRerun`, M2-T16). Nothing when none waits, unless the list could not be read,
 * which says so: an empty Home must not read as "nothing to re-run".
 */
export function KeptForRerun({
  meetings,
  now,
  rerun,
  rerunBlockedBy,
  busy,
  confirming,
  error,
  listError,
  onOpen,
  onRerun,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: KeptForRerunProps) {
  if (meetings.length === 0 && listError === null) return null;
  return (
    <section className="card kept-card" aria-label="Audio kept for a re-run">
      <h2 className="kept-card-title">Audio kept for a re-run</h2>
      {meetings.length > 0 ? (
        <p className="kept-card-intro">
          Part of these calls did not reach the transcript. Roger kept their audio so it can fill
          the gaps.
        </p>
      ) : null}
      {rerunBlockedBy === null || meetings.length === 0 ? null : (
        <p className="audio-actions-hint">{rerunBlockedBy}</p>
      )}
      {listError === null ? null : (
        <p role="alert" className="error audio-error">
          {listError}
        </p>
      )}
      <ul className="kept-list">
        {meetings.map((meeting) => (
          <li key={meeting.meetingId} className="kept-meeting">
            <div className="kept-meeting-head">
              <div className="card-text">
                <p className="card-title kept-meeting-title">{meeting.title}</p>
                <p className="card-meta">
                  {meeting.keepUntil === null
                    ? 'recording now'
                    : `kept until ${formatKeepDate(meeting.keepUntil, now)}`}
                </p>
              </div>
              <button
                type="button"
                className="btn"
                data-variant="secondary"
                data-size="sm"
                aria-label={`Open ${meeting.title}`}
                onClick={() => {
                  onOpen(meeting.meetingId);
                }}
              >
                Open
              </button>
            </div>
            {rerun?.meetingId === meeting.meetingId ? <RerunProgress rerun={rerun} /> : null}
            <AudioActions
              canRerun
              canDelete={meeting.keepUntil !== null}
              rerunBlockedBy={rerunBlockedBy}
              busy={busy?.meetingId === meeting.meetingId ? busy.action : null}
              confirming={confirming === meeting.meetingId}
              about={meeting.title}
              onRerun={() => {
                onRerun(meeting.meetingId);
              }}
              onAskDelete={() => {
                onAskDelete(meeting.meetingId);
              }}
              onConfirmDelete={() => {
                onConfirmDelete(meeting.meetingId);
              }}
              onCancelDelete={onCancelDelete}
            />
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="error audio-error">
          {error}
        </p>
      )}
    </section>
  );
}
