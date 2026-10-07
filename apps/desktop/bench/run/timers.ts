/**
 * The bench's one clock and its waits: the replay schedule, every event's arrival time, the open
 * budget's minute window and the retry backoff all read it, so the LatencyMeter compares times on a
 * single clock (EventRecord.arrivedAtMs and RunStream.replayStartedAtMs). Tests inject a manual one
 * (run/testing/manualTimers.ts).
 */
export interface BenchTimers {
  /** Epoch ms. */
  now(): number;
  /**
   * Resolves after `ms`, or at once when `signal` aborts (the run stopped): the caller checks the
   * signal after the wait. A stop must never sit out a minute's open-budget wait or a backoff.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Epoch ms from the monotonic clock, not Date.now(): a wall-clock step (an NTP correction) during a
 * replay would either hand a burst of chunks to the vendor at once or stall the replay, and would
 * put a jump into every latency measured across it.
 */
export const REAL_TIMERS: BenchTimers = {
  now: () => performance.timeOrigin + performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      // One signal serves every wait of a run, so each wait removes its listener when it ends;
      // left behind, they would pile up on the signal.
      const wake = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, ms));
      signal?.addEventListener('abort', wake, { once: true });
    }),
};
