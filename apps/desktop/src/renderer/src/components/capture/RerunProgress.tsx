import type { RerunStatus } from '../../../../shared/capture';
import './captureDetails.css';

/**
 * Where a re-run stands (`CaptureStatus.rerun`, main's GapRetranscriber): "waiting" is the open
 * budget's per-minute window, which a re-run waits on rather than skipping ahead of a live
 * reopen; "running" streams a gap's audio to the vendor.
 */
export function describeRerun(rerun: RerunStatus): string {
  if (rerun.state === 'waiting') {
    return `Re-run waiting for a free speech-to-text slot: ${rerun.finished} of ${rerun.gaps} gaps done.`;
  }
  return `Re-running ${rerun.gaps} gap${rerun.gaps === 1 ? '' : 's'} from the audio backup: ${rerun.finished} of ${rerun.gaps} done.`;
}

/** The progress of one meeting's re-run: a line a screen reader hears, and a bar. */
export function RerunProgress({ rerun }: { rerun: RerunStatus }) {
  return (
    <div className="rerun-progress" role="status" data-state={rerun.state}>
      <p className="rerun-progress-text">{describeRerun(rerun)}</p>
      {/* max is never 0: a bar with no range draws as indeterminate, which reads as endless. */}
      <progress
        className="rerun-progress-bar"
        aria-label="Gaps re-run"
        value={rerun.finished}
        max={Math.max(1, rerun.gaps)}
      />
    </div>
  );
}
