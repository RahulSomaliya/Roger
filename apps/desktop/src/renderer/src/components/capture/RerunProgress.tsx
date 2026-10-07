import type { RerunStatus } from '../../../../shared/capture';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Where transcribing a meeting again stands (`CaptureStatus.rerun`, main's GapRetranscriber):
 * "waiting" is the open budget's per-minute window, which it waits on rather than skipping ahead
 * of a live reopen; "running" streams a gap's audio to the vendor. A gap is a "part" to the person
 * (docs/design.md, Naming list: Transcribe again).
 */
export function describeRerun(rerun: RerunStatus): string {
  const done = `${rerun.finished} of ${plural(rerun.gaps, 'part')} done.`;
  return rerun.state === 'waiting'
    ? `Waiting for a free speech-to-text slot to transcribe again: ${done}`
    : `Transcribing again: ${done}`;
}

/** The progress of one meeting's transcribing again: a line a screen reader hears, no bar. */
export function RerunProgress({ rerun }: { rerun: RerunStatus }) {
  return (
    <p className="rerun-progress" role="status" data-state={rerun.state}>
      {describeRerun(rerun)}
    </p>
  );
}
