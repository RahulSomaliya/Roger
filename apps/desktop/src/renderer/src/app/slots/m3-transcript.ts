// Stub from M4-S1; owned by M3-T9, which replaced M1's TranscriptView (M4-S4's seed) here.
import { createElement } from 'react';
import { useMeetingView } from '../../meeting/useMeeting';
import { VocabularySettings } from '../../settings/VocabularySettings';
import { LiveTranscript } from '../../transcript/LiveTranscript';
import { meetingPhase } from '../captureMeeting';
import { useShell } from '../ShellContext';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

/**
 * The meeting page's transcript: M3-T7's live transcript panel, for the meeting recording now and
 * for a past one. Slot props carry only the meeting id, so the stored lines and whether to show
 * the lines the echo filter hid come from the page (useMeetingView). The panel subscribes to
 * main's transcript events itself and adds them to the stored lines; it renders inside the page's
 * CitationNavigatorProvider, which it registers with. The page mounts this region only once main
 * has answered the first read or the meeting records, and then keeps it for that meeting through
 * Stop, as the panel holds the lines it heard live (`unread` and `regionsShownFor` in
 * meeting/MeetingPage.tsx). So an empty past transcript here means the store holds no line, but
 * for one case: a page opened mid-recording whose every read failed through Stop knows only the
 * lines spoken while it was open, and says nothing was transcribed if nobody spoke meanwhile.
 *
 * `live` is this meeting's phase, never main's alone (meetingPhase): while the next meeting
 * starts, the last one's page must stop following and offering "Jump to live".
 */
function MeetingTranscript({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const { storedLines, showHidden } = useMeetingView();
  const phase = meetingPhase(
    captureMeeting?.id === meetingId ? captureMeeting : null,
    capture.status,
  );
  return createElement(LiveTranscript, {
    meetingId,
    storedLines,
    showHidden,
    live: phase === 'recording',
  });
}

/**
 * What M3-T9 mounts: the live transcript (meetingTranscript) and the jargon list (settings).
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  meetingTranscript: [{ id: 'm3-live-transcript', order: 0, component: MeetingTranscript }],
  settings: [{ id: 'm3-vocabulary', order: 10, component: VocabularySettings }],
};
