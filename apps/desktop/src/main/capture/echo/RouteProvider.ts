import type { EchoOutputRoute } from './EchoFilter';

/**
 * Where call audio plays, read by the echo sink at each decision (M2 D2): known headphones turn
 * the filter off, since nothing then leaks from the speakers into the mic.
 */
export interface RouteProvider {
  current(): EchoOutputRoute;
}

/**
 * The route last reported, `unknown` until the first report. Unknown keeps the filter on: it may
 * be the laptop speakers. The M2-T14b slot of createCaptureRuntime.ts builds one (`echoRoute`),
 * and M2-T17a's slot sets it from the helper monitor's `route` events; until then it stays
 * unknown and every mic line is filtered.
 */
export class LatestRoute implements RouteProvider {
  private route: EchoOutputRoute = 'unknown';

  set(route: EchoOutputRoute): void {
    this.route = route;
  }

  current(): EchoOutputRoute {
    return this.route;
  }
}
