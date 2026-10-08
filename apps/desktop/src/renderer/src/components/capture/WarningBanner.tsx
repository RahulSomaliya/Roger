import type { CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { groupWarnings } from './captureProblems';
import { ProblemLine } from './ProblemLine';
import './captureStatus.css';

/**
 * What is wrong with capture now, above every page (the shell's banner slot): one problem line per
 * stream, read out at once. The line is main's message (what is wrong and what to do) with when
 * the trouble began after it in `ink-subtle`, folded in rather than a heading row of its own.
 *
 * Loud warnings only. The quiet ones ("Call audio is silent. That is normal in a pause") are in
 * Details (CaptureFacts). On the page of the meeting that records, the header's status line says
 * the loud ones instead, so the editor never moves (m2-capture-status.ts, CaptureWarnings).
 */
export function WarningBanner({ warnings }: { warnings: readonly CaptureWarning[] }) {
  const groups = groupWarnings(warnings, true);
  if (groups.length === 0) return null;
  return (
    <div className="capture-warnings">
      {groups.map((group) => (
        <ProblemLine key={group.source ?? 'none'} loud>
          {group.messages.join(' ')}{' '}
          <span className="problem-since">since {formatClockTime(group.since)}</span>
        </ProblemLine>
      ))}
    </div>
  );
}
