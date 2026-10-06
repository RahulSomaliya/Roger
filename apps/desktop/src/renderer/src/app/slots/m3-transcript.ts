// Stub from M4-S1; owned by M3-T9. M4-S4 seeded M1's TranscriptView here.
import { createElement } from 'react';
import { mergeTranscriptLines } from '../../../../shared/meetings';
import type { AudioSource, InterimTranscript } from '../../../../shared/transcript';
import { TranscriptView } from '../../components/TranscriptView';
import { useMeetingView } from '../../meeting/useMeeting';
import { meetingPhase } from '../captureMeeting';
import { useShell } from '../ShellContext';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

const NO_INTERIM: Record<AudioSource, InterimTranscript | null> = { mic: null, system: null };

/**
 * M1's transcript on any meeting, until M3-T9 mounts LiveTranscript: the lines main's store holds
 * (the page's storedLines), plus this meeting's lines that arrived live since (useCapture keeps
 * the recording's lines; after a reload mid-call only the store has the earlier ones), each once.
 */
function M1Transcript({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const { storedLines } = useMeetingView();
  const phase = meetingPhase(
    captureMeeting?.id === meetingId ? captureMeeting : null,
    capture.status,
  );
  const live = capture.segments.filter((segment) => segment.meetingId === meetingId);
  return createElement(TranscriptView, {
    segments: mergeTranscriptLines(storedLines, live),
    interim: phase === 'recording' ? capture.interim : NO_INTERIM,
    recording: phase === 'recording',
  });
}

/**
 * What M3-T9 mounts: the live transcript (meetingTranscript) and the jargon list (settings).
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  meetingTranscript: [{ id: 'm1-transcript', order: 0, component: M1Transcript }],
};
