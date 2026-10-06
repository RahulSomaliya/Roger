import type { CapturePhase, CaptureStatus } from '../../../shared/capture';

/** The meeting the shell's capture view (useCapture) describes. */
export interface CaptureMeeting {
  readonly id: string;
  /** ISO 8601 instant, UTC; null until main reports it. */
  readonly startedAt: string | null;
}

/**
 * The meeting the capture view describes after `status`: the one a status names, else the last
 * one. Main's status names no meeting after Stop, while useCapture keeps that meeting's lines on
 * screen (as M1's window did), so the shell keeps pointing at it until main names the next one,
 * which it does only once that one records. Whether this meeting is recording is meetingPhase's
 * answer, never main's phase alone. Returns `previous` itself when nothing changed: the shell
 * updates its state during render with this, and a new object every render would never settle.
 */
export function captureMeetingAfter(
  previous: CaptureMeeting | null,
  status: CaptureStatus | null,
): CaptureMeeting | null {
  const id = status?.meetingId ?? null;
  if (status === null || id === null) return previous;
  if (previous?.id === id && previous.startedAt === status.startedAt) return previous;
  return { id, startedAt: status.startedAt };
}

/**
 * The phase of `meeting`: main's phase when its status names that meeting, else idle. Ask this,
 * never `status.phase !== 'idle'` alone: while the next recording starts (the microphone check,
 * the STT token and the vendor connect) main names no meeting, so the meeting stopped last still
 * fills `captureMeeting` and would read as starting, "Recording since" its old start time.
 */
export function meetingPhase(
  meeting: CaptureMeeting | null,
  status: CaptureStatus | null,
): CapturePhase {
  if (meeting === null || status?.meetingId !== meeting.id) return 'idle';
  return status.phase;
}
