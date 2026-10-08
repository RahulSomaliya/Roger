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
 * "Roger restarted and kept taking notes", one quiet line under the meeting header. Roger resumed
 * the meeting a crash or a quit left open without being asked, so the person is told; the Stop for
 * it is the header's own (D7 promised a Stop on the notice, and the header's is one click away on
 * the same page). Never an alert: Roger recovered, and the window it was down is a few seconds the
 * capture report counts (`resumed_after_crash`).
 *
 * Notices.tsx leaves this kind out of Details' recovery list: shown there too, it would be said
 * twice.
 */
export function ResumedNotice({ notice }: { notice: CaptureNotice }) {
  return (
    <p className="capture-note" role="status">
      {notice.message} <span className="problem-since">at {formatClockTime(notice.at)}</span>
    </p>
  );
}
