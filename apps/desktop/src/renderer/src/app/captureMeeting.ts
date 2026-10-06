import type { CaptureStatus } from '../../../shared/capture';

/** The meeting the shell's capture view (useCapture) describes. */
export interface CaptureMeeting {
  readonly id: string;
  /** ISO 8601 instant, UTC; null until main reports it. */
  readonly startedAt: string | null;
}

/**
 * The meeting the capture view describes after `status`: the one a status names, else the last
 * one. Main's status names no meeting after Stop, while useCapture keeps that meeting's lines on
 * screen (as M1's window did), so the shell keeps pointing at it until the next Start. Returns
 * `previous` itself when nothing changed: the shell updates its state during render with this,
 * and a new object every render would never settle.
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
