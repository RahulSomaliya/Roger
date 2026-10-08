import type { CapturePhase, CaptureWarning } from '../../../../shared/capture';
import { formatClockTime, formatElapsed } from '../../app/labels';
import { Icon } from '../ui/icons';
import { groupWarnings } from './captureProblems';
import './captureStatus.css';

export interface StatusLineProps {
  phase: CapturePhase;
  /** ISO 8601 instant; null until main reports it, when the line shows no time. */
  startedAt: string | null;
  /** The clock the elapsed time reads (the caller ticks it every 15 s). */
  nowMs: number;
  /** `CaptureStatus.warnings`: only the loud ones are said here. */
  warnings: readonly CaptureWarning[];
}

/**
 * The meeting header's status line (the `meetingCaptureStatus` slot): "Recording · 12m" while a call
 * records, or a loud problem in its place, in words ("Roger can't hear the call · since 4:59 pm").
 * The page says "Recording" nowhere else. Everything the old capture panel showed (sources,
 * counts, the cost) is Details'.
 *
 * It holds ONE line and is replaced, never added to: the header reserves that line while recording
 * (meeting.css), so a problem that arrives mid-call never moves the editor under the person's
 * cursor. A long headline is cut with an ellipsis for the same reason; main's full message, with
 * what to do, is its tooltip and Details' text. With two streams in trouble it names the first and
 * counts the rest. The quiet warnings are Details' too.
 *
 * Nothing while Roger starts or stops (the header's busy button says so) or when nothing records.
 */
export function StatusLine({ phase, startedAt, nowMs, warnings }: StatusLineProps) {
  const [first, ...more] = groupWarnings(warnings, true);
  if (first !== undefined) {
    return (
      <section className="capture-status" aria-label="Capture status">
        <div
          className="problem meeting-status-problem"
          role="alert"
          title={first.messages.join(' ')}
        >
          <Icon name="circle-alert" />
          <span className="problem-text meeting-status-headline">{first.headline}</span>{' '}
          <span className="problem-since">· since {formatClockTime(first.since)}</span>
          {more.length === 0 ? null : (
            <>
              {' '}
              <span className="problem-since">· +{more.length} more</span>
            </>
          )}
        </div>
      </section>
    );
  }
  if (phase !== 'recording') return null;
  const elapsed = startedAt === null ? null : formatElapsed(Date.parse(startedAt), nowMs);
  return (
    <section className="capture-status" aria-label="Capture status">
      <p className="meeting-status-text">Recording{elapsed === null ? '' : ` · ${elapsed}`}</p>
    </section>
  );
}
