// Stub from M4-S1; owned by M2-T20a.
import { createElement } from 'react';
import { StreamStatus } from '../../components/capture/StreamStatus';
import { WarningBanner } from '../../components/capture/WarningBanner';
import { captureStatusFor } from '../../meeting/liveMeeting';
import { useShell } from '../ShellContext';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

/**
 * Main's capture warnings, above every page: a cut must reach the user wherever they are, so these
 * read main's status as it is, never one meeting's. Main ends every spell at Stop.
 */
function CaptureWarnings() {
  const { capture } = useShell();
  return createElement(WarningBanner, { warnings: capture.status?.warnings ?? [] });
}

/**
 * The capture status of the meeting this page shows, which M2-T20a's StreamStatus replaced M1's
 * StatusPanel with. captureStatusFor picks it: main's status while it records this meeting, the
 * idle status after its Stop (with that recording's meter), and nothing while main describes
 * another meeting (the next one starting from this page).
 */
function MeetingCaptureStatus({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const status = captureStatusFor(meetingId, captureMeeting, capture.status);
  return status === null ? null : createElement(StreamStatus, { status });
}

/**
 * What M2-T20a mounts: the capture warnings (banner) and the meeting's capture status. A banner
 * entry makes the shell draw its banner box on every page, even with nothing in it.
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  banner: [{ id: 'm2-capture-warnings', order: 0, component: CaptureWarnings }],
  meetingCaptureStatus: [{ id: 'm2-capture-status', order: 0, component: MeetingCaptureStatus }],
};
