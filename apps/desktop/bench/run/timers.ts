/**
 * The bench's one clock and its waits: the replay schedule, every event's arrival time, the open
 * budget's minute window and the retry backoff all read it, so the LatencyMeter compares times on a
 * single clock (EventRecord.arrivedAtMs and RunStream.replayStartedAtMs). Tests inject a manual one
 * (run/testing/manualTimers.ts).
 */
export interface BenchTimers {
  /** Epoch ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Epoch ms from the monotonic clock, not Date.now(): a wall-clock step (an NTP correction) during a
 * replay would either hand a burst of chunks to the vendor at once or stall the replay, and would
 * put a jump into every latency measured across it.
 */
export const REAL_TIMERS: BenchTimers = {
  now: () => performance.timeOrigin + performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};
