import type { EchoStatus } from '../../../../shared/capture';
import { SPEAKER_FOR_SOURCE } from '../../../../shared/transcript';
import type { EchoLine } from './echoChanges';
import { ProblemLine } from './ProblemLine';
import './captureDetails.css';

const SPEAKER_NAME = { me: 'Me', them: 'Them' } as const;

const lineCount = (count: number): string => `${count} mic line${count === 1 ? '' : 's'}`;

/**
 * What the echo filter did (M2 D2), or null when it did nothing. The filter works on the mic only:
 * a mic line that repeats the call audio (speakers leaking into the mic) is hidden, and one that
 * repeats part of it has those words cut out.
 */
export function describeEcho(counts: EchoStatus): string | null {
  if (counts.hidden > 0 && counts.trimmed > 0) {
    return `Roger hid ${lineCount(counts.hidden)} that repeated the call audio, and cut repeated words out of ${counts.trimmed} more.`;
  }
  if (counts.hidden > 0)
    return `Roger hid ${lineCount(counts.hidden)} that repeated the call audio.`;
  if (counts.trimmed > 0) return `Roger cut repeated words out of ${lineCount(counts.trimmed)}.`;
  return null;
}

export interface EchoLinesProps {
  /** Main's counts for the meeting: the live status while it records, the report after Stop. */
  counts: EchoStatus;
  /** The lines this window saw the filter change, in order (echoChanges.ts). */
  lines: readonly EchoLine[];
  /** The meeting page's toggle (MeetingView.showHidden): the transcript reads it too. */
  showHidden: boolean;
  onShowHidden: (show: boolean) => void;
  onUnhide: (segmentId: string) => void;
  /** Lines whose Unhide is waiting for main. */
  pending: ReadonlySet<string>;
  /** Why the last Unhide failed, or null. */
  error: string | null;
}

/**
 * The echo filter's lines, and the toggle that shows them (Details, the `meetingCaptureReport`
 * region). Off, the transcript hides the hidden lines and the list is closed; on, the transcript
 * shows them marked as echo and this list gives each changed line's text.
 *
 * Unhide appears on a hidden line only. A trimmed line already uploads what is left of it, and
 * main's store refuses to unhide it (TranscriptStore.unhideSegment): a button on it would only
 * ever fail. The preview's fake refuses the same lines, so a shot cannot pass on one.
 */
export function EchoLines({
  counts,
  lines,
  showHidden,
  onShowHidden,
  onUnhide,
  pending,
  error,
}: EchoLinesProps) {
  const summary = describeEcho(counts);
  if (summary === null && lines.length === 0) return null;
  const listedHidden = lines.filter((line) => line.kind === 'hidden').length;
  const unlisted =
    Math.max(0, counts.hidden - listedHidden) +
    Math.max(0, counts.trimmed - (lines.length - listedHidden));
  return (
    <section className="details-section echo-lines" aria-label="Echo filter">
      <h3 className="details-heading">Echo lines</h3>
      <div className="echo-lines-head">
        <p className="echo-lines-summary">{summary}</p>
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          aria-pressed={showHidden}
          onClick={() => {
            onShowHidden(!showHidden);
          }}
        >
          {showHidden ? 'Hide echo text' : 'Show hidden and trimmed text'}
        </button>
      </div>
      {showHidden ? (
        <>
          <ul className="echo-lines-list">
            {lines.map((line) => (
              <li
                key={line.segmentId}
                className="echo-line"
                data-echo-line={line.kind}
                data-speaker={SPEAKER_FOR_SOURCE[line.source]}
              >
                <span className="echo-line-tag">{line.kind}</span>
                <span className="echo-line-speaker">
                  {SPEAKER_NAME[SPEAKER_FOR_SOURCE[line.source]]}
                </span>
                <span className="echo-line-text">{line.text}</span>
                {line.kind === 'hidden' ? (
                  <button
                    type="button"
                    className="btn"
                    data-variant="secondary"
                    data-size="sm"
                    aria-label={`Unhide: ${line.text}`}
                    disabled={pending.has(line.segmentId)}
                    onClick={() => {
                      onUnhide(line.segmentId);
                    }}
                  >
                    Unhide
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {unlisted > 0 ? (
            <p className="echo-lines-note">
              {unlisted} more changed before this page opened and are not listed: Roger lists the
              lines it saw change here.
            </p>
          ) : null}
        </>
      ) : null}
      {error !== null ? <ProblemLine loud>{error}</ProblemLine> : null}
    </section>
  );
}
