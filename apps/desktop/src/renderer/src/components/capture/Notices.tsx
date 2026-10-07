import type { CaptureNotice } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import './captureStatus.css';

/** A notice as the list shows it: the latest of its kind and stream, and how many came. */
export interface ShownNotice {
  key: string;
  notice: CaptureNotice;
  /** Notices of this kind and stream in the status, this one included. */
  times: number;
}

/**
 * What Roger recovered from on its own this recording (`CaptureStatus.notices`): the latest notice
 * of each kind and stream, newest first. Main keeps up to 20 device switches (AirPods that flap),
 * and a list of every one would push the meeting down the page; the count says how often.
 *
 * `resumed-after-crash` is not shown here: M2-T20b's ResumedNotice shows it, with the Stop button
 * the D7 decision promises ("Roger restarted and kept taking notes"). Shown twice, the second
 * copy would have no Stop.
 */
export function noticesToShow(notices: readonly CaptureNotice[]): ShownNotice[] {
  const latest = new Map<string, ShownNotice>();
  for (const notice of notices) {
    if (notice.kind === 'resumed-after-crash') continue;
    const key = `${notice.kind}/${notice.source ?? 'none'}`;
    // Main appends notices as they happen, so a later one in the list is the newer.
    latest.set(key, { key, notice, times: (latest.get(key)?.times ?? 0) + 1 });
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.notice.at) - Date.parse(a.notice.at));
}

/**
 * Quiet by design: a recovery is never a warning ("Switched to <device>", "helper restarted"), so
 * the list is a polite live region, never an alert.
 */
export function Notices({ notices }: { notices: readonly CaptureNotice[] }) {
  const shown = noticesToShow(notices);
  if (shown.length === 0) return null;
  return (
    <ul className="capture-notices" aria-label="Recovered on its own" aria-live="polite">
      {shown.map(({ key, notice, times }) => (
        <li key={key} className="capture-notice" data-kind={notice.kind}>
          <span className="capture-notice-message">{notice.message}</span>{' '}
          <span className="capture-notice-meta">
            at {formatClockTime(notice.at)}
            {times > 1 ? ` · ${times} times this recording` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
