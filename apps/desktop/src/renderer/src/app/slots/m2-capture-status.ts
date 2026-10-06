// Stub from M4-S1; owned by M2-T20a. M4-S4 seeded M1's StatusPanel here.
import { createElement } from 'react';
import { StatusPanel } from '../../components/StatusPanel';
import { captureStatusFor } from '../../meeting/liveMeeting';
import { useShell } from '../ShellContext';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

/**
 * M1's capture status on the meeting it describes, until M2-T20a's replaces it: per source, the
 * stream, the connected time and the stream messages, then the lines saved, the upload, and the
 * meter line the owner asked to see (the vendor's billed time and cost; "Last recording" after
 * Stop). captureStatusFor picks the status for this meeting; M2-T20a's panel needs the same pick.
 */
function M1CaptureStatus({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const status = captureStatusFor(meetingId, captureMeeting, capture.status);
  return status === null ? null : createElement(StatusPanel, { status });
}

/**
 * What M2-T20a mounts: the capture warnings (banner) and the meeting's capture status.
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  meetingCaptureStatus: [{ id: 'm1-status-panel', order: 0, component: M1CaptureStatus }],
};
