import { describe, expect, it } from 'vitest';
import { RouteHistory } from './RouteProvider';

describe('RouteHistory', () => {
  /** Speakers from 1000, headphones from 2000, speakers again from 3000. */
  function history(): RouteHistory {
    let now = 1_000;
    const routes = new RouteHistory(() => now);
    routes.set('speakers');
    now = 2_000;
    routes.set('headphones');
    routes.set('headphones'); // reported again: still headphones since 2000
    now = 3_000;
    routes.set('speakers');
    return routes;
  }

  it('reads unknown before the first report, which keeps the echo filter on', () => {
    expect(new RouteHistory(() => 0).during(0, 10)).toBe('unknown');
    expect(history().during(0, 500)).toBe('unknown');
    expect(history().during(500, 1_500)).toBe('speakers');
  });

  it('reads headphones only when headphones played the whole span', () => {
    expect(history().during(2_000, 2_999)).toBe('headphones');
    expect(history().during(2_500, 3_000)).toBe('speakers');
    expect(history().during(1_999, 2_500)).toBe('speakers');
  });

  it('answers by the time asked about, not by the latest report', () => {
    const routes = history();
    expect(routes.during(2_100, 2_200)).toBe('headphones');
    expect(routes.during(3_100, 3_200)).toBe('speakers');
  });

  it('reads a span that began before the first report as unknown, even when headphones followed', () => {
    let now = 5_000;
    const routes = new RouteHistory(() => now);
    routes.set('headphones');
    now = 6_000;
    expect(routes.during(4_000, 5_500)).toBe('unknown');
    expect(routes.during(5_000, 5_500)).toBe('headphones');
  });
});
