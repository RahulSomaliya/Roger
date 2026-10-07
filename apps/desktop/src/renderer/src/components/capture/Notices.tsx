import type { CaptureNotice, CaptureNoticeKind } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import './captureStatus.css';

/** A notice as the list shows it: the latest of its kind and stream, and how many main lists. */
export interface ShownNotice {
  key: string;
  notice: CaptureNotice;
  /**
   * Notices of this kind and stream in the status, this one included. Not the recording's total:
   * main lists only the newest 20 device switches (MAX_NOTICES in main/capture/SignalMonitor.ts).
   */
  times: number;
  /** What the count calls them: "switches", "restarts". */
  countedAs: string;
}

/** The kinds this list shows, and what the count calls them. */
const COUNTED_AS: Record<Exclude<CaptureNoticeKind, 'resumed-after-crash'>, string> = {
  'device-switched': 'switches',
  'helper-restarted': 'restarts',
};

/**
 * What Roger recovered from on its own this recording (`CaptureStatus.notices`): the latest notice
 * of each kind and stream, newest first. Main keeps up to 20 device switches (AirPods that flap),
 * and a list of every one would push the meeting down the page; the count says how many it kept.
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
    latest.set(key, {
      key,
      notice,
      times: (latest.get(key)?.times ?? 0) + 1,
      countedAs: COUNTED_AS[notice.kind],
    });
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
      {shown.map(({ key, notice, times, countedAs }) => (
        <li key={key} className="capture-notice" data-kind={notice.kind}>
          <span className="capture-notice-message">{notice.message}</span>{' '}
          <span className="capture-notice-meta">
            at {formatClockTime(notice.at)}
            {/* "latest of 3 recent switches". Recent, never "this recording": main lists only
                the newest 20 switches (SignalMonitor's MAX_NOTICES), so a mic that flapped 27
                times read "20 times this recording". And it counts every switch on the stream,
                whatever the device, so it never follows the device's name: "Switched to AirPods
                Pro · 3 times" read as three switches to AirPods. */}
            {times > 1 ? ` · latest of ${times} recent ${countedAs}` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
