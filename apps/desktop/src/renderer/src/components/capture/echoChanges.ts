import type { TranscriptSegmentChange } from '../../../../shared/capture';
import type { AudioSource } from '../../../../shared/transcript';

/**
 * The lines the echo filter changed that this window saw (`transcript:segment-changed`), for
 * EchoLines' list: a hidden line (kept locally, never uploaded) and a trimmed one (its repeated
 * words cut out). The event is the only way the renderer learns a line's text: the stored meeting
 * carries no hidden flag (shared/meetings.ts), so a line hidden before this page opened is counted
 * (CaptureReport.echo) but cannot be listed.
 */
export interface EchoLine {
  segmentId: string;
  source: AudioSource;
  kind: 'hidden' | 'trimmed';
  /** The text as the line now reads: a trimmed line's is what is left of it. */
  text: string;
}

/** By segment id, in the order the lines were first changed. Replaced, never mutated. */
export type EchoLineMap = ReadonlyMap<string, EchoLine>;

export const NO_ECHO_LINES: EchoLineMap = new Map();

/**
 * The lines after one event. Events of another meeting are ignored, and `lines` itself comes back
 * when nothing changed (React skips the render). A `trimmed` event for a line already hidden only
 * updates its text: main's store unhides a line only while it is suppressed and a trim never sets
 * that, so the hidden line keeps its Unhide and a merely trimmed one never gets one
 * (TranscriptStore.unhideSegment; main refuses the call). `unhidden` takes the line off: it uploads
 * now, and reads as any other line.
 */
export function applyEchoChange(
  lines: EchoLineMap,
  meetingId: string,
  change: TranscriptSegmentChange,
): EchoLineMap {
  if (change.meetingId !== meetingId) return lines;
  const known = lines.get(change.segmentId);
  const next = new Map(lines);
  switch (change.change) {
    case 'unhidden':
      if (known === undefined) return lines;
      next.delete(change.segmentId);
      return next;
    case 'hidden':
      next.set(change.segmentId, {
        segmentId: change.segmentId,
        source: change.source,
        kind: 'hidden',
        text: change.text,
      });
      return next;
    case 'trimmed':
      next.set(change.segmentId, {
        segmentId: change.segmentId,
        source: change.source,
        kind: known?.kind ?? 'trimmed',
        text: change.text,
      });
      return next;
  }
}

export function echoLinesIn(lines: EchoLineMap): EchoLine[] {
  return [...lines.values()];
}
