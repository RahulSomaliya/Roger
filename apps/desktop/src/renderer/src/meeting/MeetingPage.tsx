import { useCallback, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { TranscriptSegment } from '../../../shared/transcript';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import { isSlotEmpty, SlotOutlet } from '../app/SlotOutlet';
import { CitationNavigatorProvider } from '../transcript/transcriptNavigator';
import './meeting.css';
import { MeetingHeader } from './MeetingHeader';
import { meetingTimeLabel } from './meetingTimes';
import { activePane, meetingPanes, type MeetingPane } from './panes';
import { MeetingRegions } from './regions';
import { type MeetingView, MeetingViewContext, useMeeting } from './useMeeting';

const NO_LINES: readonly TranscriptSegment[] = [];

/**
 * One meeting stored on this Mac (`meeting/<id>`): its header, the regions other milestones mount
 * (app/slotRegistry.ts: the calendar notice, capture status, audio note and capture report, then
 * the notes, the transcript and chat), all inside the citation navigator so a chip in the notes or
 * chat can reveal its lines in the transcript.
 *
 * It reads the meeting from main's store (useMeeting), so it shows any meeting, not only the one
 * the window recorded last. That retired M4-S1's placeholder, which showed "Roger can show only
 * the meeting it recorded last for now..." on meeting A's page for a moment after New note there:
 * main names meeting B before start() resolves and the shell opens B's page (ShellContext). This
 * page keeps showing A from the store meanwhile. Whether this meeting is recording is
 * meetingPhase's answer, never main's phase alone (app/captureMeeting.ts).
 */
export function MeetingPage({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting, stopRecording } = useShell();
  // This meeting's phase: the capture view may describe another one (the next, while it starts).
  const phase = meetingPhase(
    captureMeeting?.id === meetingId ? captureMeeting : null,
    capture.status,
  );
  // Read again whenever this meeting's recording starts or stops (useMeeting): after Stop the
  // store has every line, or no meeting at all when nobody spoke.
  const read = useMeeting(meetingId, phase);
  const meeting = read.value ?? null;

  const [showHidden, setShowHidden] = useState(false);
  const view = useMemo<MeetingView>(
    () => ({
      meetingId,
      meeting,
      storedLines: meeting?.segments ?? NO_LINES,
      showHidden,
      setShowHidden,
    }),
    [meetingId, meeting, showHidden],
  );

  const panes = meetingPanes({
    notes: !isSlotEmpty('meetingMyNotes') || !isSlotEmpty('meetingAiNotes'),
    chat: !isSlotEmpty('meetingChat'),
  });
  const [chosenPane, setChosenPane] = useState<MeetingPane | null>(null);
  // The navigator scrolls as soon as this returns, so the transcript must be shown by then.
  const showTranscript = useCallback(() => {
    flushSync(() => {
      setChosenPane('transcript');
    });
  }, []);

  // Main keeps no meeting in which nobody spoke: after such a Stop the read answers null. A live
  // meeting main has not answered for yet keeps its regions, so its lines still show.
  const missing = read.value === null && phase === 'idle';
  // Before main's first answer, or when the first read failed, the page knows none of the stored
  // lines: the transcript would say "No lines were saved for this meeting", false beside the
  // sidebar's title, so the regions wait unless this meeting records now or this window heard
  // its lines live. Main answers within a frame or two: a loading text would flash on every open.
  const unread =
    read.value === undefined &&
    phase === 'idle' &&
    !capture.segments.some((segment) => segment.meetingId === meetingId);
  // Never a made-up title after a failed read ("Untitled meeting" was one): main names every
  // meeting it keeps, and the sidebar beside this page shows that name.
  const title = missing
    ? 'This meeting is not on this Mac'
    : (meeting?.title ?? (read.error === null ? 'Loading…' : 'Could not read this meeting'));
  const startedAt =
    meeting?.startedAt ?? (captureMeeting?.id === meetingId ? captureMeeting.startedAt : null);
  const time =
    startedAt === null
      ? null
      : meetingTimeLabel(
          { startedAt, endedAt: meeting?.endedAt ?? null },
          phase !== 'idle',
          new Date(),
        );

  return (
    <CitationNavigatorProvider showTranscript={showTranscript}>
      <MeetingViewContext value={view}>
        <div className="meeting-page">
          <MeetingHeader
            title={title}
            pending={read.value === undefined && read.error === null}
            time={missing ? null : time}
            phase={phase}
            busy={capture.busy}
            onStop={stopRecording}
          />
          {read.error !== null ? (
            <div role="alert" className="error meeting-read-error">
              <span>{read.error}</span>
              <button type="button" className="shell-button" onClick={read.refresh}>
                Try again
              </button>
            </div>
          ) : null}
          <SlotOutlet name="meetingBanner" props={{ meetingId }} />
          <SlotOutlet name="meetingCaptureStatus" props={{ meetingId }} />
          <SlotOutlet name="meetingAudioNote" props={{ meetingId }} />
          <SlotOutlet name="meetingCaptureReport" props={{ meetingId }} />
          {missing ? (
            <div className="empty-state">
              <p className="empty-state-text">
                Roger keeps a meeting once someone speaks in it, and this Mac has no lines for this
                one. It may have stopped before anyone spoke.
              </p>
            </div>
          ) : unread ? (
            // Nothing while the first read runs (the header says Loading…); the alert above says
            // why a failed one failed, with Try again.
            read.error === null ? null : (
              <div className="empty-state">
                <p className="empty-state-text">
                  The transcript shows here once Roger can read this meeting.
                </p>
              </div>
            )
          ) : (
            <MeetingRegions
              meetingId={meetingId}
              panes={panes}
              pane={activePane(chosenPane, panes)}
              onPane={setChosenPane}
            />
          )}
        </div>
      </MeetingViewContext>
    </CitationNavigatorProvider>
  );
}
