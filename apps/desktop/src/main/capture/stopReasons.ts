import { formatClock } from '../../shared/clock';
import type { CostGuards } from '../costGuards';

/**
 * Why a recording stopped. Only `user` is a Stop someone pressed; every other reason is Roger
 * stopping on its own so no vendor session outlives the person's attention (cost guards G4, G5).
 * Each is logged and kept as the meeting's `stt_usage.stop_reason`; stopNotice says which also
 * leave a notice on screen.
 */
export type StopReason =
  | 'user'
  /** G5: no final line from either source for costGuards.noSpeechStopMs. */
  | 'no-speech'
  /** G5: the recording reached costGuards.maxRecordingMs. */
  | 'max-duration'
  /** G4: the app is quitting (Cmd+Q, the menu, logout). */
  | 'quit'
  /** G4: the main window closed. */
  | 'window-closed'
  /**
   * G4: the page could not be brought back, so no page captures the mic: it did not load (a crash's
   * reload or one someone asked for), the page a crash's reload brought up crashed before it
   * loaded, or the page kept crashing (lifecycle.ts, RENDERER_CRASH_LIMIT). A crash alone or a
   * reload no longer stops (M2 D7): the reloaded page reopens the mic. There was a `page-reloaded`
   * reason until M2-T12; old rows keep it.
   */
  | 'renderer-gone'
  /**
   * G4: the Mac slept for costGuards.noSpeechStopMs or more; the stop comes at wake
   * (power/PowerCoordinator.ts, M2-T18). A shorter sleep only pauses both sessions, and the
   * recording goes on.
   */
  | 'system-sleep'
  /**
   * No call app has held the mic since the one that was in use at Start let go, for its release
   * debounce (detect/CallDetector.ts, M2-T17b). Roger's own stop, through the normal one: the
   * no-speech and 4-hour stops stay as the backstop for a recording that never saw a call app.
   * `stt_usage.stop_reason` is bounded free text, so the API takes it with no change.
   */
  | 'call-ended';

/**
 * What the status shows after Roger stopped a recording itself. Null for a Stop someone pressed,
 * and for a stop that leaves no window to show it (quit, window-closed). It is on the page, so it
 * is plain words: `detail` is read only for `call-ended` (the call app's name), and a crash's
 * reason ("it kept crashing: crashed") never reaches it (lifecycle.ts logs it; sweep W3).
 */
export function stopNotice(
  reason: StopReason,
  at: Date,
  guards: Pick<CostGuards, 'noSpeechStopMs' | 'maxRecordingMs'>,
  detail: string | null = null,
): string | null {
  const time = formatClock(at);
  switch (reason) {
    case 'user':
      return null;
    case 'no-speech':
      return `Stopped at ${time} after ${spell(guards.noSpeechStopMs)} with no speech.`;
    case 'max-duration':
      return `Stopped at ${time}: one meeting is capped at ${spell(guards.maxRecordingMs)}.`;
    case 'quit':
    case 'window-closed':
      // The notice lives in memory and Roger is exiting: only a quit exits (closing the window
      // hides it, M5-T11), and `window-closed` is the window's `closed`, which with close-hides
      // comes only while quitting (lifecycle.ts). Cmd+Q showed it for one frame at most. Keeping
      // one across launches would need it saved and read back at startup; the log and
      // stt_usage.stop_reason have it.
      return null;
    case 'renderer-gone':
      return `Stopped at ${time} because the Roger window stopped working.`;
    case 'system-sleep':
      return `Stopped at ${time} because the Mac went to sleep.`;
    case 'call-ended':
      // `detail` is the call app's name, as the offer card showed it.
      return `Stopped at ${time}: the call${detail === null ? '' : ` in ${detail}`} ended.`;
  }
}

/** 900000 → "15 minutes", 14400000 → "4 hours", 90000 → "90 seconds". */
function spell(ms: number): string {
  const unit = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  if (ms % 60_000 === 0) return unit(ms / 60_000, 'minute');
  return unit(Math.round(ms / 1000), 'second');
}
