import { useCallback, useEffect, useState } from 'react';
import type { CaptureReport as Report, CaptureStatus } from '../../../../shared/capture';
import { describeError } from '../../app/describeError';
import { meetingPhase } from '../../app/captureMeeting';
import { useShell } from '../../app/ShellContext';
import { meetingHours } from '../../../../shared/clock';
import type { StoredMeeting } from '../../../../shared/meetings';
import { captureStatusFor } from '../../meeting/liveMeeting';
import { useMeetingView } from '../../meeting/useMeeting';
import { type AudioBusy, GapLine, KeptAudio, RERUN_BLOCKED_WHILE_RECORDING } from './AudioKept';
import { CaptureFacts } from './CaptureFacts';
import { CaptureReport } from './CaptureReport';
import { applyEchoChange, echoLinesIn, type EchoLineMap, NO_ECHO_LINES } from './echoChanges';
import { EchoLines, echoLinesShow } from './EchoLines';
import { reportsChanged, useCaptureReport, useReportsEpoch } from './captureReads';
import { Notices } from './Notices';
import { ProblemLine } from './ProblemLine';
import { findResumeNotice, ResumedNotice } from './ResumedNotice';
import { type AudioNoteView, audioNote } from './reportText';
import { WarningNotes } from './WarningNotes';

/*
 * The containers M2-T20b mounts in the shell's slots (app/slots/m2-capture-details.ts): each reads
 * main, holds the state of its buttons and hands plain props to the presentational components in
 * this folder, which the unit tests render.
 */

/**
 * Main refuses transcribing again while ANY recording runs (GapRetranscriber.rerunMeeting), not
 * only this meeting's, so the block reads main's phase, never `meetingPhase`.
 */
function rerunBlockedBy(status: CaptureStatus | null): string | null {
  return status !== null && status.phase !== 'idle' ? RERUN_BLOCKED_WHILE_RECORDING : null;
}

/**
 * What changes the answer of a report without an event of its own: this window's actions (the
 * epoch), a recording starting or stopping, transcribing again starting or ending (a startup or
 * after-Stop run nobody clicked ends with no other sign), and the backup's state, which main
 * re-reads into the status when it recovers a gap (AudioBackup.refresh). A string on purpose: the
 * status is a new object every 2 s (useMeeting says why).
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

/** The Transcribe again and Delete state of one audio control: what runs, what asks to be confirmed, why it failed. */
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
    // Both answer the report after the change, but the other regions read for themselves: tell
    // them to ask again (neither action sends an event).
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

/**
 * The parts of a meeting nothing has transcribed yet: the report's gaps with no `recoveredAt`.
 * Counted whether or not the audio is kept: the transcript has the hole either way.
 */
function untranscribedParts(report: Report | undefined): number {
  return report?.gaps.filter((gap) => gap.recoveredAt === null).length ?? 0;
}

/**
 * The words about this meeting's kept audio. While it records, the live status says how the
 * backup goes; after Stop, the report does (the status then holds the last meeting's backup, which
 * may be another meeting's). Null when no audio is kept at all.
 */
function audioViewFor(
  meetingId: string,
  status: CaptureStatus | null,
  phase: string,
  report: Report | undefined,
): AudioNoteView | null {
  const live = phase !== 'idle' && status?.meetingId === meetingId;
  const backup = live ? status.backup : report?.backup;
  if (backup === undefined || backup === null) return null;
  return audioNote(backup, untranscribedParts(report), new Date());
}

/**
 * The gap line under the meeting header (the `meetingAudioNote` slot): "2 parts were not
 * transcribed · Transcribe again", or the progress of transcribing them again. Nothing otherwise.
 * The kept audio itself and Delete audio are in Details.
 */
export function MeetingGapLine({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting } = useShell();
  const { status } = capture;
  const phase = meetingPhase(captureMeeting?.id === meetingId ? captureMeeting : null, status);
  const epoch = useReportsEpoch();
  const report = useCaptureReport(meetingId, readKey(epoch, status, phase)).value;
  const actions = useAudioActions();
  const view = audioViewFor(meetingId, status, phase, report);
  const mine = actions.state.busy?.meetingId === meetingId ? actions.state.busy.action : null;
  return (
    <GapLine
      parts={untranscribedParts(report)}
      rerun={status?.rerun?.meetingId === meetingId ? status.rerun : null}
      canRerun={view?.canRerun ?? false}
      rerunBlockedBy={rerunBlockedBy(status)}
      busy={mine === 'rerun'}
      error={actions.state.error}
      onRerun={() => {
        actions.run(meetingId, 'rerun');
      }}
    />
  );
}

/**
 * The content of the Details dialog (the `meetingCaptureReport` slot; the dialog mounts it only
 * while open, so nothing here reads main until someone asks): what is wrong now, the sources and
 * counts and the cost, what Roger recovered from, the echo lines, the capture report and the kept
 * audio. The echo lines are mounted while it records too: they listen for the lines the filter
 * changes, which are the only way to learn their text, and main's live counts say how many there
 * are.
 */
export function MeetingCaptureDetails({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting } = useShell();
  const { status } = capture;
  const { showHidden, setShowHidden, meeting } = useMeetingView();
  const phase = meetingPhase(captureMeeting?.id === meetingId ? captureMeeting : null, status);
  const epoch = useReportsEpoch();
  const read = useCaptureReport(meetingId, readKey(epoch, status, phase));
  const report = read.value;
  const actions = useAudioActions();

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
  // The status that describes this meeting: its own while it records, the idle one after its Stop
  // (with that recording's meter), and nothing while main describes another meeting.
  const facts = captureStatusFor(meetingId, captureMeeting, status);
  const counts = (recording ? status.echo : report?.echo) ?? report?.echo ?? null;
  // Nothing for a meeting from before the capture report existed: no reason, no gaps, no events.
  const hasReport =
    report !== undefined &&
    (report.stopReason !== null || report.gaps.length > 0 || report.events.length > 0);
  const audio = audioViewFor(meetingId, status, phase, report);
  const mine = actions.state.busy?.meetingId === meetingId ? actions.state.busy.action : null;
  // WHY not `counts !== null`: every report carries echo counts (all zero when the filter did
  // nothing) while EchoLines draws nothing for zeros, so `nothing` below was never true and a past
  // meeting with no gaps, events, kept audio or echo opened an EMPTY dialog (D3). Ask what is
  // drawn, not what exists; a fallback triggered by "nothing to show" must test the drawing.
  const showEcho = echoLinesShow(counts, lines.size);
  const showReport = phase === 'idle' && hasReport;
  // A meeting from before any of this existed has no capture report. Details still holds what the
  // store knows (StoredFacts), never an empty dialog that reads as broken (redesign D3).
  const nothing =
    read.error === null &&
    !recording &&
    facts === null &&
    !showEcho &&
    !showReport &&
    audio === null;

  return (
    <div className="details">
      {read.error === null ? null : (
        <ProblemLine
          loud
          action={
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={read.refresh}
            >
              Try again
            </button>
          }
        >
          {read.error}
        </ProblemLine>
      )}
      {recording ? <WarningNotes warnings={status.warnings ?? []} /> : null}
      {facts === null ? null : <CaptureFacts status={facts} />}
      {recording ? <Notices notices={status.notices ?? []} /> : null}
      {showEcho ? (
        <EchoLines
          counts={counts ?? { hidden: 0, trimmed: 0, held: 0 }}
          lines={echoLinesIn(lines)}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          onUnhide={unhide}
          pending={pending}
          error={unhideError}
        />
      ) : null}
      {showReport ? <CaptureReport report={report} /> : null}
      {nothing ? <StoredFacts meeting={meeting} /> : null}
      {audio === null ? null : (
        <KeptAudio
          view={audio}
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
      )}
    </div>
  );
}

/**
 * What Roger's store holds about a meeting that has no capture report: the lines saved on this
 * Mac and when it ran. The dialog always opens onto something (redesign D3); the page offers
 * Details only for a meeting on this Mac, so `meeting` is null only in a read that just failed.
 */
function StoredFacts({ meeting }: { meeting: StoredMeeting | null }) {
  if (meeting === null) {
    return <p className="details-empty">Roger has nothing stored for this meeting.</p>;
  }
  const lines = meeting.segments.length;
  return (
    <section className="dialog-panel capture-facts" aria-label="Stored on this Mac">
      <dl className="facts">
        <div className="fact">
          <dt>Saved on this Mac</dt>
          <dd>{lines === 1 ? '1 line' : `${lines} lines`}</dd>
        </div>
        {meeting.endedAt === null ? null : (
          <div className="fact">
            <dt>Ran</dt>
            <dd>{meetingHours(Date.parse(meeting.startedAt), Date.parse(meeting.endedAt))}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/**
 * "Roger restarted and kept taking notes", one quiet line under the header (the `meetingBanner`
 * slot) while the resumed meeting records.
 */
export function MeetingResumedNotice({ meetingId }: { meetingId: string }) {
  const { capture } = useShell();
  const { status } = capture;
  if (status?.meetingId !== meetingId || status.phase !== 'recording') return null;
  const notice = findResumeNotice(status.notices);
  return notice === null ? null : <ResumedNotice notice={notice} />;
}
