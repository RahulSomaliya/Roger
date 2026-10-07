import { isSlotEmpty, SlotOutlet } from './SlotOutlet';
import { useShell } from './ShellContext';

/**
 * Above every page, the setup route included: what must reach the user wherever they are. The
 * capture error, the stop notice (`CaptureStatus.notice`, "Stopped at 14:32 because the Mac went to
 * sleep."; M1's window showed it and M2-T20a keeps it), why the theme preference could not be read
 * (`themeError`, from AppLayout's useTheme; the page follows macOS meanwhile), then whatever is
 * mounted in the `banner` slot (M2's capture warnings).
 */
export function BannerSlot({ themeError }: { themeError: string | null }) {
  const { capture, actionError } = useShell();
  const captureError = capture.localError ?? capture.status?.error ?? null;
  const notice = capture.status?.notice ?? null;
  if (
    captureError === null &&
    actionError === null &&
    notice === null &&
    themeError === null &&
    isSlotEmpty('banner')
  ) {
    return null;
  }
  return (
    <div className="banner-slot">
      {captureError !== null ? (
        <div role="alert" className="error">
          {captureError}
        </div>
      ) : null}
      {actionError !== null && actionError !== captureError ? (
        <div role="alert" className="error">
          {actionError}
        </div>
      ) : null}
      {notice !== null ? (
        <div role="status" className="notice">
          {notice}
        </div>
      ) : null}
      {themeError !== null ? (
        <div role="alert" className="error">
          {themeError}
        </div>
      ) : null}
      <SlotOutlet name="banner" props={{}} />
    </div>
  );
}
