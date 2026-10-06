import type { BenchTimers } from '../timers';

interface Sleeper {
  atMs: number;
  order: number;
  wake: () => void;
}

/**
 * Test-only BenchTimers on a manual clock. `settle(work)` drives `work` to its end: whenever nothing
 * else moves, time jumps to the earliest sleeper and wakes it, so a 10-minute replay with retries and
 * open-budget waits runs in milliseconds, in the order real time would run it. Real I/O (the run
 * files) still happens: each step first yields to the event loop a few times so it can land.
 */
export class ManualTimers implements BenchTimers {
  private current: number;
  private sleepers: Sleeper[] = [];
  private nextOrder = 0;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** As REAL_TIMERS: an aborted signal ends the wait at once, with the clock where it is. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const sleeper: Sleeper = {
        atMs: this.current + Math.max(0, ms),
        order: this.nextOrder,
        wake: () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        },
      };
      const stop = (): void => {
        this.sleepers = this.sleepers.filter((other) => other !== sleeper);
        sleeper.wake();
      };
      this.sleepers.push(sleeper);
      this.nextOrder += 1;
      signal?.addEventListener('abort', stop, { once: true });
    });
  }

  async settle<T>(work: Promise<T>): Promise<T> {
    // Only says that `work` ended; its result or its rejection reaches the caller as `work`.
    const ended = work.then(
      () => true,
      () => true,
    );
    for (;;) {
      for (let round = 0; round < 5; round += 1) {
        if (await Promise.race([ended, nextTurnOfTheEventLoop()])) return work;
      }
      const next = this.takeEarliest();
      if (next === null) continue;
      this.current = Math.max(this.current, next.atMs);
      next.wake();
    }
  }

  private takeEarliest(): Sleeper | null {
    let earliest: Sleeper | null = null;
    for (const sleeper of this.sleepers) {
      if (
        earliest === null ||
        sleeper.atMs < earliest.atMs ||
        (sleeper.atMs === earliest.atMs && sleeper.order < earliest.order)
      ) {
        earliest = sleeper;
      }
    }
    if (earliest !== null) this.sleepers = this.sleepers.filter((sleeper) => sleeper !== earliest);
    return earliest;
  }
}

/** Resolves false after pending I/O callbacks had their turn. */
function nextTurnOfTheEventLoop(): Promise<boolean> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve(false);
    });
  });
}
