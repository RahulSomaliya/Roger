import type { CapturePhase } from '../../../shared/capture';

/** The recording state, as the meeting header and the sidebar say it. */
export const PHASE_LABEL: Readonly<Record<CapturePhase, string>> = {
  idle: 'Not recording',
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Stopping…',
};

/** Every meeting's title until M5 brings invite titles; Phase 2 has no rename. */
export const UNTITLED_MEETING = 'Untitled meeting';

/** A start time as the clock on the wall reads it, in the Mac's own 12 or 24 hour style. */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
