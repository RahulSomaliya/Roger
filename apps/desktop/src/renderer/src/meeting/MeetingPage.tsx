import { useCallback, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { TranscriptSegment } from '../../../shared/transcript';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import { isSlotEmpty, SlotOutlet } from '../app/SlotOutlet';
import { CitationNavigatorProvider } from '../transcript/transcriptNavigator';
import {
  aiNotesTabExists,
  headerAction,
  notesMenuEntries,
  templateForWriting,
} from './headerAction';
import './meeting.css';
import { MeetingHeader } from './MeetingHeader';
import { MeetingProblem, ReplaceNotesDialog } from './MeetingProblems';
import { meetingTimeLabel } from './meetingTimes';
import { activeTab, meetingTabs, type MeetingTab } from './panes';
import { MeetingRegions } from './regions';
import { type MeetingView, MeetingViewContext, useMeeting, useMeetingNotes } from './useMeeting';

const NO_LINES: readonly TranscriptSegment[] = [];

/**
 * One meeting stored on this Mac (`meeting/<id>`): its header (title, time, the one primary, the
 * capture status line and the Details dialog), the notices under it (app/slotRegistry.ts: the
 * calendar notice and the audio note), then one tab row over the notes, the AI notes, the
 * transcript and chat, all inside the citation navigator so a chip in the notes or chat can reveal
 * its lines in the transcript.
 *
 * It reads the meeting from main's store (useMeeting), so it shows any meeting, not only the one
 * the window recorded last. That retired M4-S1's placeholder, which showed "Roger can show only
 * the meeting it recorded last for now..." on meeting A's page for a moment after Start notes there:
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

  // The AI notes tab exists once notes exist or are being written, never as an empty "No AI notes
  // yet" (docs/design.md: empty states are absent). A generate that failed or waits, and a run that
  // failed (its banner and partial lines), keep the tab (aiNotesTabExists), so a problem line is
  // never hidden with the tab.
  const { session: notes, state: notesState } = useMeetingNotes(meetingId);
  const aiNotesExist = aiNotesTabExists(notesState);
  const tabs = meetingTabs({
    mine: !isSlotEmpty('meetingMyNotes'),
    ai: !isSlotEmpty('meetingAiNotes') && aiNotesExist,
    chat: !isSlotEmpty('meetingChat'),
  });
  const [chosenTab, setChosenTab] = useState<MeetingTab | null>(null);
  // The navigator scrolls as soon as this returns, so the transcript must be shown by then.
  const showTranscript = useCallback(() => {
    flushSync(() => {
      setChosenTab('transcript');
    });
  }, []);

  // Main keeps no meeting in which nobody spoke: after such a Stop the read answers null. A live
  // meeting main has not answered for yet keeps its regions, so its lines still show.
  const missing = read.value === null && phase === 'idle';
  // Before main's first answer, or when the first read failed, the page knows none of the stored
  // lines: the transcript would say "Nothing was transcribed in this meeting", false beside the
  // title Home's list shows, so the regions wait unless this meeting records now. Main answers within a
  // frame or two: a loading text would flash on every open. Once shown, the regions stay for this
  // meeting: the transcript panel holds the lines it heard live (it subscribes only while
  // mounted), so taking it away after Stop until a read answers would drop them, for good if reads
  // fail. State set while rendering, so no frame shows the page without them. Kept as the meeting
  // it was set for, never a bare flag: a flag set for meeting A would show B's regions before B's
  // read answers, and B's transcript would say "Nothing was transcribed". AppLayout gives each
  // route a new page (its <main> key) today, but this page must not rely on that key staying.
  const [regionsShownFor, setRegionsShownFor] = useState<string | null>(null);
  const regionsShown = regionsShownFor === meetingId;
  const unread = read.value === undefined && phase === 'idle' && !regionsShown;
  if (!missing && !unread && !regionsShown) setRegionsShownFor(meetingId);
  // Never a made-up title after a failed read ("Untitled meeting" was one): main names every
  // meeting it keeps, and Home's list shows that name.
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

  const action = headerAction({
    phase,
    captureBusy: capture.busy,
    // This page is idle while main's status describes another meeting: a past meeting beside a
    // live one offers no primary (docs/design.md, the one primary per moment).
    elsewhere: capture.status !== null && capture.status.phase !== 'idle',
    stored: meeting !== null,
    notes: notesState,
  });
  const write = (): void => {
    void notes.generate(templateForWriting(meeting?.title ?? '')).then((took) => {
      // Show the notes arrive: the AI notes tab exists once main reports the pending generate.
      if (took) setChosenTab('ai');
    });
  };

  return (
    <CitationNavigatorProvider showTranscript={showTranscript}>
      <MeetingViewContext value={view}>
        <div className="meeting">
          <MeetingHeader
            meetingId={meetingId}
            title={title}
            pending={read.value === undefined && read.error === null}
            time={missing ? null : time}
            action={action}
            onStop={stopRecording}
            onWrite={write}
            onCancelWrite={() => {
              notes.cancel();
            }}
            menu={notesMenuEntries(notesState, notes)}
            details={!missing && (meeting !== null || phase !== 'idle')}
          />
          {/*
            Problems first, then the notices: a read that failed, notes that did not start or could
            not be opened. House rule 1 holds here too: none of them waits behind a closed tab.
          */}
          {read.error === null ? null : (
            <MeetingProblem action="Try again" onAction={read.refresh}>
              {read.error}
            </MeetingProblem>
          )}
          {notesState.actionError === null ? null : (
            <MeetingProblem
              action="Dismiss"
              onAction={() => {
                notes.dismissError();
              }}
            >
              {notesState.actionError}
            </MeetingProblem>
          )}
          {notesState.status === 'failed' ? (
            <MeetingProblem
              action="Try again"
              onAction={() => {
                notes.reload();
              }}
            >
              Roger could not open the AI notes: {notesState.loadError}
            </MeetingProblem>
          ) : null}
          <SlotOutlet name="meetingBanner" props={{ meetingId }} />
          <SlotOutlet name="meetingAudioNote" props={{ meetingId }} />
          {missing ? (
            <p className="meeting-aside">
              Roger keeps a meeting once someone speaks in it, and this Mac has no lines for this
              one. It may have stopped before anyone spoke.
            </p>
          ) : unread ? (
            // Nothing while the first read runs (the header says Loading…); the problem above says
            // why a failed one failed, with Try again.
            read.error === null ? null : (
              <p className="meeting-aside">
                The transcript shows here once Roger can read this meeting.
              </p>
            )
          ) : (
            <MeetingRegions
              meetingId={meetingId}
              tabs={tabs}
              tab={activeTab(chosenTab, tabs)}
              onTab={setChosenTab}
            />
          )}
          <ReplaceNotesDialog
            confirm={notesState.confirm}
            onConfirm={() => {
              void notes.confirmAction();
            }}
            onKeep={() => {
              notes.dismissConfirm();
            }}
          />
        </div>
      </MeetingViewContext>
    </CitationNavigatorProvider>
  );
}
