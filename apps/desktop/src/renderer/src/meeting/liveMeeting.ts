import type { CaptureStatus } from '../../../shared/capture';
import type { CaptureMeeting } from '../app/captureMeeting';

/**
 * The capture status that describes meeting `meetingId`, for its page's capture status region, or
 * null when main's status is about no recording of it. It is main's status while that names the
 * meeting, and after its Stop the idle status main keeps (with the meter of that recording, the cost
 * the owner asked to see) for as long as the shell still points at it (`captureMeeting`).
 *
 * Never main's status alone: while the next recording starts, main says `starting` and names no
 * meeting, and the shell still points at the meeting stopped last (meetingPhase in
 * app/captureMeeting.ts). Shown on that page, the panel would call the stopped meeting's sources
 * "connected".
 */
export function captureStatusFor(
  meetingId: string,
  captureMeeting: CaptureMeeting | null,
  status: CaptureStatus | null,
): CaptureStatus | null {
  if (status === null || captureMeeting?.id !== meetingId) return null;
  if (status.meetingId === meetingId) return status;
  return status.meetingId === null && status.phase === 'idle' ? status : null;
}
