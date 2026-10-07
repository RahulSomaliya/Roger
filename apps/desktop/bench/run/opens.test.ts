import { describe, expect, it } from 'vitest';
import { BenchOpener } from './opens';
import { ManualTimers } from './testing/manualTimers';

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);

/** The most opens that fell inside any one rolling minute. */
function busiestMinute(openTimes: readonly number[]): number {
  return Math.max(
    0,
    ...openTimes.map(
      (start) => openTimes.filter((at) => at >= start && at < start + 60_000).length,
    ),
  );
}

describe('BenchOpener', () => {
  it('makes opens wait for the minute window, so 5 a minute is never exceeded', async () => {
    const timers = new ManualTimers(T0);
    const opener = new BenchOpener({ opensPerMinute: 5 }, timers);
    const openTimes: number[] = [];

    const items = Array.from({ length: 6 }, () =>
      opener
        .reserve(2, () => Promise.resolve('token'))
        .then(() => {
          openTimes.push(timers.now(), timers.now());
        }),
    );
    await timers.settle(Promise.all(items));

    expect(openTimes).toHaveLength(12);
    expect(busiestMinute(openTimes)).toBeLessThanOrEqual(5);
    // Two items fit the first minute; the third waits for its slots instead of failing.
    expect(openTimes[4]).toBe(T0 + 60_000);
  });

  it('runs the token fetch inside the turn, before the slots are taken', async () => {
    const timers = new ManualTimers(T0);
    const opener = new BenchOpener({ opensPerMinute: 4 }, timers);
    const order: string[] = [];

    const first = opener.reserve(2, async () => {
      order.push('fetch 1');
      await timers.sleep(500);
      order.push('fetched 1');
      return 1;
    });
    const second = opener.reserve(2, () => {
      order.push('fetch 2');
      return Promise.resolve(2);
    });

    expect(await timers.settle(Promise.all([first, second]))).toEqual([1, 2]);
    expect(order).toEqual(['fetch 1', 'fetched 1', 'fetch 2']);
  });

  it('takes no slot when the fetch fails, and the next turn still runs', async () => {
    const timers = new ManualTimers(T0);
    const opener = new BenchOpener({ opensPerMinute: 2 }, timers);

    const failed = opener.reserve(2, () => Promise.reject(new Error('API down')));
    const next = opener.reserve(2, () => Promise.resolve('ok'));

    await expect(timers.settle(failed)).rejects.toThrow('API down');
    expect(await timers.settle(next)).toBe('ok');
    // The failed turn took nothing, so the second went at once.
    expect(timers.now()).toBe(T0);
  });

  it('ends the minute wait when the run stops, fetching no token for it or any turn behind it', async () => {
    const timers = new ManualTimers(T0);
    const opener = new BenchOpener({ opensPerMinute: 2 }, timers);
    const abort = new AbortController();
    const fetched: string[] = [];
    const turn = (name: string, count: number): Promise<string> =>
      opener.reserve(
        count,
        () => {
          fetched.push(name);
          return Promise.resolve(name);
        },
        abort.signal,
      );

    expect(await timers.settle(turn('first', 2))).toBe('first');
    // Its two slots fill the minute: `waiting` sleeps until T0 + 60 s, `queued` waits behind it.
    const waiting = turn('waiting', 2);
    const queued = turn('queued', 1);
    void timers.sleep(10_000).then(() => {
      abort.abort('disk full');
    });

    await expect(timers.settle(waiting)).rejects.toThrow(/run stopped/);
    await expect(timers.settle(queued)).rejects.toThrow(/run stopped/);
    expect(fetched).toEqual(['first']);
    expect(timers.now()).toBe(T0 + 10_000);
  });

  it('refuses an item needing more opens than a minute allows, instead of waiting forever', async () => {
    const opener = new BenchOpener({ opensPerMinute: 1 }, new ManualTimers(T0));

    await expect(opener.reserve(2, () => Promise.resolve(null))).rejects.toThrow(
      /needs 2 sessions at once but ROGER_STT_OPENS_PER_MINUTE allows 1/,
    );
  });
});
