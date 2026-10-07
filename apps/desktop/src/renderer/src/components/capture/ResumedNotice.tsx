import type { CaptureNotice } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import './captureDetails.css';

/** The crash resume among a status's notices (M2-T23 adds it while the resumed recording runs). */
export function findResumeNotice(
  notices: readonly CaptureNotice[] | undefined,
): CaptureNotice | null {
  return notices?.find((notice) => notice.kind === 'resumed-after-crash') ?? null;
}

/**
 * "Roger restarted and kept taking notes", with the Stop the D7 decision promises: Roger resumed
 * the meeting a crash or a quit left open without being asked, so the person must be able to end it
 * from the notice. Quiet, never an alert: Roger recovered, and the window it was down is a few
 * seconds the capture report counts (`resumed_after_crash`).
 *
 * Notices.tsx leaves this kind out of its list: shown there too, the second copy would have no Stop.
 */
export function ResumedNotice({
  notice,
  busy,
  onStop,
}: {
  notice: CaptureNotice;
  /** A start or a stop is under way. */
  busy: boolean;
  onStop: () => void;
}) {
  return (
    <div className="resumed-notice" role="status">
      <p className="resumed-notice-text">
        <span className="resumed-notice-message">{notice.message}</span>{' '}
        <span className="resumed-notice-meta">at {formatClockTime(notice.at)}</span>
      </p>
      <button
        type="button"
        className="btn"
        data-variant="secondary"
        data-size="sm"
        disabled={busy}
        onClick={onStop}
      >
        Stop recording
      </button>
    </div>
  );
}
