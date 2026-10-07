/**
 * The one clock Roger writes, in the renderer and in main: 12-hour, lowercase, no leading zero
 * ("9:14 am"), whatever the Mac's own 12 or 24 hour setting says (docs/design.md, Copy). The
 * renderer re-exports it from `renderer/src/clock.ts`; main's stop notices, tray and default
 * meeting title call it here, so there is one rule and no second formatter to drift.
 *
 * Two traps. The formatter is built per call, never at module level: an `Intl.DateTimeFormat`
 * keeps the zone it was made in, so a long-lived one writes the old zone's clock after a macOS
 * zone change. And the pieces are joined by hand: newer ICU puts a narrow no-break space before
 * "AM" in en-US, which a test, a copied line or a screen reader's pause would carry along.
 *
 * `timeZone` (an IANA name) is for a test or a caller that formats in a fixed zone; leave it out
 * to read the Mac's.
 *
 * Pure, with no imports: the page bundles it too.
 */
export function formatClock(at: Date | number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`;
}
