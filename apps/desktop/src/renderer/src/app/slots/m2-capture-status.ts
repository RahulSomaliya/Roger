// Stub from M4-S1; owned by M2-T20a.
import { createElement } from 'react';
import { StreamStatus } from '../../components/capture/StreamStatus';
import { refusedLinesProblem } from '../../components/capture/captureProblems';
import { ProblemLine } from '../../components/capture/ProblemLine';
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
 * Lines the server refused for good (house rule 1), under the header of the meeting main describes.
 * The old capture panel said it in its "Postgres" row; nothing else on the page does.
 */
function RefusedLines({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const status = captureStatusFor(meetingId, captureMeeting, capture.status);
  const problem = status === null ? null : refusedLinesProblem(status.upload);
  return problem === null ? null : createElement(ProblemLine, { loud: true }, problem);
}

/**
 * What M2-T20a mounts: the capture warnings (banner) and the meeting's capture status. A banner
 * entry makes the shell draw its banner box on every page, even with nothing in it.
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  banner: [{ id: 'm2-capture-warnings', order: 0, component: CaptureWarnings }],
  meetingCaptureStatus: [{ id: 'm2-capture-status', order: 0, component: MeetingCaptureStatus }],
  // Equal orders go by id, and `m2-` sorts before M5's consent line: a loss comes first.
  meetingBanner: [{ id: 'm2-upload-refused', order: 0, component: RefusedLines }],
};
