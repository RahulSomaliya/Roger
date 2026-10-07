import { useCallback, useEffect, useState } from 'react';
import type { CaptureStatus } from '../../../../shared/capture';
import { describeError } from '../../app/describeError';
import { meetingPhase } from '../../app/captureMeeting';
import { useShell } from '../../app/ShellContext';
import { useMeetingView } from '../../meeting/useMeeting';
import {
  AudioNote,
  type AudioBusy,
  KeptForRerun,
  RERUN_BLOCKED_WHILE_RECORDING,
} from './AudioKept';
import { CaptureReport } from './CaptureReport';
import { applyEchoChange, echoLinesIn, type EchoLineMap, NO_ECHO_LINES } from './echoChanges';
import { EchoLines } from './EchoLines';
import { reportsChanged, useCaptureReport, useKeptForRerun, useReportsEpoch } from './captureReads';
import { findResumeNotice, ResumedNotice } from './ResumedNotice';
import { audioNote } from './reportText';

/*
 * The containers M2-T20b mounts in the shell's slots (app/slots/m2-capture-details.ts): each reads
 * main, holds the state of its buttons and hands plain props to the presentational components in
 * this folder, which the unit tests render.
 */

/**
 * Main refuses a re-run while ANY recording runs (GapRetranscriber.rerunMeeting), not only this
 * meeting's, so the block reads main's phase, never `meetingPhase`.
 */
function rerunBlockedBy(status: CaptureStatus | null): string | null {
  return status !== null && status.phase !== 'idle' ? RERUN_BLOCKED_WHILE_RECORDING : null;
}

/**
 * What changes the answer of a report or of the kept list without an event of its own: this
 * window's actions (the epoch), a recording starting or stopping, a re-run starting or ending
 * (a startup or after-Stop re-run nobody clicked ends with no other sign), and the backup's state,
 * which main re-reads into the status when a re-run recovers a gap (AudioBackup.refresh). A string
 * on purpose: the status is a new object every 2 s (useMeeting says why).
 */
function readKey(epoch: number, status: CaptureStatus | null, phase: string): string {
  return [
    epoch,
    phase,
    status?.rerun === null || status?.rerun === undefined ? 'no-rerun' : 'rerun',
    status?.backup?.state ?? 'no-backup',
    String(status?.backup?.keptForRerun ?? false),
  ].join('/');
}

/** The Re-run and Delete state of one audio control: what runs, what asks to be confirmed, why it failed. */
interface AudioActionState {
  busy: { meetingId: string; action: Exclude<AudioBusy, null> } | null;
  confirming: string | null;
  error: string | null;
}

const IDLE_ACTIONS: AudioActionState = { busy: null, confirming: null, error: null };

function useAudioActions() {
  const [state, setState] = useState<AudioActionState>(IDLE_ACTIONS);
  const run = useCallback((meetingId: string, action: 'rerun' | 'delete'): void => {
    setState({ busy: { meetingId, action }, confirming: null, error: null });
    const done =
      action === 'rerun'
        ? window.roger.rerunGaps({ meetingId })
        : window.roger.deleteMeetingAudio({ meetingId });
    // Both answer the report after the change, but the list on Home and the other regions read for
    // themselves: tell them to ask again (neither action sends an event).
    void done
      .then(() => {
        setState(IDLE_ACTIONS);
      })
      .catch((error: unknown) => {
        setState({ busy: null, confirming: null, error: describeError(error) });
      })
      .finally(reportsChanged);
  }, []);
  const askDelete = useCallback((meetingId: string): void => {
    setState((now) => ({ ...now, confirming: meetingId, error: null }));
  }, []);
  const cancelDelete = useCallback((): void => {
    setState((now) => ({ ...now, confirming: null }));
  }, []);
  return { state, run, askDelete, cancelDelete };
}

/** The meeting page's audio note and its re-run's progress (the `meetingAudioNote` slot). */
export function MeetingAudioNote({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting } = useShell();
  const { status } = capture;
  const phase = meetingPhase(captureMeeting?.id === meetingId ? captureMeeting : null, status);
  const epoch = useReportsEpoch();
  const report = useCaptureReport(meetingId, readKey(epoch, status, phase)).value;
  const actions = useAudioActions();

  // While it records, the live status says how the backup goes; after Stop, the report does (the
  // status then holds the last meeting's backup, which may be another meeting's).
  const live = phase !== 'idle' && status?.meetingId === meetingId;
  const backup = live ? status.backup : report?.backup;
  if (backup === undefined || backup === null) return null;
  const unfilled = report?.gaps.filter((gap) => gap.recoveredAt === null).length ?? 0;
  const view = audioNote(backup, unfilled, new Date());
  if (view === null) return null;

  const mine = actions.state.busy?.meetingId === meetingId ? actions.state.busy.action : null;
  return (
    <AudioNote
      view={view}
      rerun={status?.rerun?.meetingId === meetingId ? status.rerun : null}
      rerunBlockedBy={rerunBlockedBy(status)}
      busy={mine}
      confirming={actions.state.confirming === meetingId}
      error={actions.state.error}
      onRerun={() => {
        actions.run(meetingId, 'rerun');
      }}
      onAskDelete={() => {
        actions.askDelete(meetingId);
      }}
      onConfirmDelete={() => {
        actions.run(meetingId, 'delete');
      }}
      onCancelDelete={actions.cancelDelete}
    />
  );
}

/**
 * The meeting page's echo lines and capture report (the `meetingCaptureReport` slot). The echo
 * lines are mounted while it records too: they listen for the lines the filter changes, which are
 * the only way to learn their text, and main's live counts say how many there are.
 */
export function MeetingCaptureDetails({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting } = useShell();
  const { status } = capture;
  const { showHidden, setShowHidden } = useMeetingView();
  const phase = meetingPhase(captureMeeting?.id === meetingId ? captureMeeting : null, status);
  const epoch = useReportsEpoch();
  const read = useCaptureReport(meetingId, readKey(epoch, status, phase));
  const report = read.value;

  const [lines, setLines] = useState<EchoLineMap>(NO_ECHO_LINES);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [unhideError, setUnhideError] = useState<string | null>(null);

  // Another meeting's page starts with none of this one's lines.
  const [linesFor, setLinesFor] = useState(meetingId);
  if (linesFor !== meetingId) {
    setLinesFor(meetingId);
    setLines(NO_ECHO_LINES);
    setPending(new Set());
    setUnhideError(null);
  }

  useEffect(
    () =>
      window.roger.onTranscriptSegmentChanged((change) => {
        setLines((now) => applyEchoChange(now, meetingId, change));
        // An unhide changes the counts main reports; ask again.
        if (change.meetingId === meetingId && change.change === 'unhidden') reportsChanged();
      }),
    [meetingId],
  );

  const unhide = useCallback(
    (segmentId: string): void => {
      setUnhideError(null);
      setPending((now) => new Set(now).add(segmentId));
      void window.roger
        .unhideSegment({ meetingId, segmentId })
        .catch((error: unknown) => {
          setUnhideError(`Roger could not show that line again: ${describeError(error)}`);
        })
        .finally(() => {
          setPending((now) => {
            const next = new Set(now);
            next.delete(segmentId);
            return next;
          });
        });
    },
    [meetingId],
  );

  const recording = phase !== 'idle' && status?.meetingId === meetingId;
  const counts = (recording ? status.echo : report?.echo) ?? report?.echo ?? null;
  // Nothing for a meeting from before the capture report existed: no reason, no gaps, no events.
  const hasReport =
    report !== undefined &&
    (report.stopReason !== null || report.gaps.length > 0 || report.events.length > 0);

  return (
    <>
      {read.error === null ? null : (
        <div role="alert" className="error capture-report-error">
          <span>{read.error}</span>
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={read.refresh}
          >
            Try again
          </button>
        </div>
      )}
      {counts === null && lines.size === 0 ? null : (
        <EchoLines
          counts={counts ?? { hidden: 0, trimmed: 0, held: 0 }}
          lines={echoLinesIn(lines)}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          onUnhide={unhide}
          pending={pending}
          error={unhideError}
        />
      )}
      {phase === 'idle' && hasReport ? <CaptureReport report={report} /> : null}
    </>
  );
}

/** Home's card of meetings whose audio is kept for a re-run (the `home` slot). */
export function HomeKeptAudio() {
  const { capture, navigate } = useShell();
  const { status } = capture;
  const epoch = useReportsEpoch();
  const read = useKeptForRerun(readKey(epoch, status, status?.phase ?? 'idle'));
  const actions = useAudioActions();
  return (
    <KeptForRerun
      meetings={read.value ?? []}
      now={new Date()}
      rerun={status?.rerun ?? null}
      rerunBlockedBy={rerunBlockedBy(status)}
      busy={actions.state.busy}
      confirming={actions.state.confirming}
      error={actions.state.error}
      listError={read.error}
      onOpen={(meetingId) => {
        navigate({ name: 'meeting', meetingId });
      }}
      onRerun={(meetingId) => {
        actions.run(meetingId, 'rerun');
      }}
      onAskDelete={actions.askDelete}
      onConfirmDelete={(meetingId) => {
        actions.run(meetingId, 'delete');
      }}
      onCancelDelete={actions.cancelDelete}
    />
  );
}

/** "Roger restarted and kept taking notes", with Stop, in the meeting's capture status region. */
export function MeetingResumedNotice({ meetingId }: { meetingId: string }) {
  const { capture, stopRecording } = useShell();
  const { status } = capture;
  if (status?.meetingId !== meetingId || status.phase !== 'recording') return null;
  const notice = findResumeNotice(status.notices);
  if (notice === null) return null;
  return <ResumedNotice notice={notice} busy={capture.busy} onStop={stopRecording} />;
}
