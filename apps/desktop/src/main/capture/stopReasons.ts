import type { CostGuards } from '../costGuards';

/**
 * Why a recording stopped. Only `user` is a Stop someone pressed; every other reason is Roger
 * stopping on its own so no vendor session outlives the person's attention (cost guards G4, G5),
 * and the status shows a notice saying why.
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
  /** G4: the renderer process crashed or was killed: no page captures audio any more. */
  | 'renderer-gone'
  /** G4: the page reloaded or navigated: the page that captured audio is gone. */
  | 'page-reloaded'
  /** G4: the Mac is going to sleep; a socket left open bills until the vendor's idle timeout. */
  | 'system-sleep';

/** What the status shows after Roger stopped a recording itself; null for a Stop someone pressed. */
export function stopNotice(
  reason: StopReason,
  at: Date,
  guards: Pick<CostGuards, 'noSpeechStopMs' | 'maxRecordingMs'>,
  detail: string | null = null,
): string | null {
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  switch (reason) {
    case 'user':
      return null;
    case 'no-speech':
      return `Stopped at ${time} after ${spell(guards.noSpeechStopMs)} with no speech.`;
    case 'max-duration':
      return `Stopped at ${time}: one recording is capped at ${spell(guards.maxRecordingMs)}.`;
    case 'quit':
      return `Stopped at ${time} because Roger quit.`;
    case 'window-closed':
      return `Stopped at ${time} because the Roger window closed.`;
    case 'renderer-gone':
      return `Stopped at ${time} because the Roger window crashed${detail === null ? '' : ` (${detail})`}.`;
    case 'page-reloaded':
      return `Stopped at ${time} because the Roger window reloaded.`;
    case 'system-sleep':
      return `Stopped at ${time} because the Mac went to sleep.`;
  }
}

/** 900000 → "15 minutes", 14400000 → "4 hours", 90000 → "90 seconds". */
function spell(ms: number): string {
  const unit = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  if (ms % 60_000 === 0) return unit(ms / 60_000, 'minute');
  return unit(Math.round(ms / 1000), 'second');
}
