import { ProblemLine } from '../components/capture/ProblemLine';
import { isSlotEmpty, SlotOutlet } from './SlotOutlet';
import { useShell } from './ShellContext';

/**
 * Above every page, the setup route included: what must reach the user wherever they are, as
 * problem lines (docs/design.md: an icon and words, no red box). The capture error (lines not
 * saved on this Mac included, house rule 1), a Start or Stop that failed before main answered, the
 * stop notice (`CaptureStatus.notice`, "Stopped at 2:32 pm because the Mac went to sleep."; M1's
 * window showed it and M2-T20a keeps it), then whatever is mounted in the `banner` slot (M2's
 * loud capture warnings).
 *
 * Not here: why the theme preference could not be read. The page follows macOS meanwhile, so it is
 * reported to the log (AppLayout) and not shown.
 */
export function BannerSlot() {
  const { capture, actionError } = useShell();
  const captureError = capture.localError ?? capture.status?.error ?? null;
  const notice = capture.status?.notice ?? null;
  if (captureError === null && actionError === null && notice === null && isSlotEmpty('banner')) {
    return null;
  }
  return (
    <div className="banner-slot">
      {captureError !== null ? <ProblemLine loud>{captureError}</ProblemLine> : null}
      {actionError !== null && actionError !== captureError ? (
        <ProblemLine loud>{actionError}</ProblemLine>
      ) : null}
      {notice !== null ? <ProblemLine loud={false}>{notice}</ProblemLine> : null}
      <SlotOutlet name="banner" props={{}} />
    </div>
  );
}
