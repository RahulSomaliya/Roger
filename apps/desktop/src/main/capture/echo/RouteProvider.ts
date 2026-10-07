import type { EchoOutputRoute } from './EchoFilter';

/**
 * Where call audio played, read by the echo sink for the moment each line was said (M2 D2): known
 * headphones turn the filter off, since nothing then leaks from the speakers into the mic.
 */
export interface RouteProvider {
  /**
   * Where call audio played from `fromMs` to `toMs` (epoch ms): `headphones` only when known
   * headphones played all of it; otherwise `speakers` when they played any of it, else `unknown`.
   */
  during(fromMs: number, toMs: number): EchoOutputRoute;
}

/**
 * Every route reported, each from the moment it was set, and `unknown` before the first report.
 * Unknown keeps the filter on: it may be the laptop speakers. The M2-T14b slot of
 * createCaptureRuntime.ts builds one (`echoRoute`), and M2-T17a's slot sets it from the helper
 * monitor's `route` events (`outputRouteOf` in detect/MeetingAppMonitor.ts: a Bluetooth output
 * counts as headphones only when named like them). It stays unknown, and every mic line is
 * filtered, while there is no monitor (no helper) or none has reported, and the slot sets it back
 * to unknown when the monitor is lost.
 *
 * Trap: a line is judged on the route of the moment it was said, never on the latest report. A
 * decision can come long after the words (a held line's twin after call audio reconnects, M2-T16's
 * re-run after Stop): judged on the route at decision time, AirPods connected in between let an
 * echo said on the speakers upload. So no report is dropped; a repeated one adds nothing, and a
 * route changes a few times a day.
 */
export class RouteHistory implements RouteProvider {
  private readonly reports: { route: EchoOutputRoute; sinceMs: number }[] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  set(route: EchoOutputRoute): void {
    if (this.reports.at(-1)?.route === route) return;
    this.reports.push({ route, sinceMs: this.clock() });
  }

  during(fromMs: number, toMs: number): EchoOutputRoute {
    let atStart: EchoOutputRoute = 'unknown';
    const played = new Set<EchoOutputRoute>();
    for (const { route, sinceMs } of this.reports) {
      if (sinceMs <= fromMs) atStart = route;
      else if (sinceMs <= toMs) played.add(route);
    }
    played.add(atStart);
    if (played.has('speakers')) return 'speakers';
    return played.has('unknown') ? 'unknown' : 'headphones';
  }
}
