import { describe, expect, it } from 'vitest';
import { frameCapturedAtMs } from './captureClock';

const RATE = 16_000;
const WALL = 1_765_000_000_000;

describe('frameCapturedAtMs', () => {
  it("is the wall clock now minus the frame's age on the monotonic clock", () => {
    // The context played context time 10 s at performance.now() 5000 ms, so the frame at 9.9 s
    // was at 4900 ms. Read at 5200 ms, it is 300 ms old.
    const at = frameCapturedAtMs(
      9.9 * RATE,
      RATE,
      { outputTimestamp: { contextTime: 10, performanceTime: 5_000 }, currentTime: 10.2 },
      { performanceNow: 5_200, dateNow: WALL },
    );
    expect(at).toBeCloseTo(WALL - 300, 6);
  });

  it('stays on the wall clock after a sleep, where performance.timeOrigin falls behind', () => {
    // Chromium's monotonic clock stops while the Mac sleeps, so after an hour asleep the page's
    // performance.now() and the context's clocks read as if no time passed, and
    // `timeOrigin + performanceTime` would date this chunk an hour early. Date.now() moved on.
    const asleepMs = 3_600_000;
    const at = frameCapturedAtMs(
      9.9 * RATE,
      RATE,
      { outputTimestamp: { contextTime: 10, performanceTime: 5_000 }, currentTime: 10.2 },
      { performanceNow: 5_200, dateNow: WALL + asleepMs },
    );
    expect(at).toBeCloseTo(WALL + asleepMs - 300, 6);
  });

  it('falls back to the context clock before the context has an output timestamp', () => {
    // Both are 0 until the context renders its first quantum.
    const at = frameCapturedAtMs(
      1.5 * RATE,
      RATE,
      { outputTimestamp: { contextTime: 0, performanceTime: 0 }, currentTime: 1.6 },
      { performanceNow: 9_999, dateNow: WALL },
    );
    expect(at).toBeCloseTo(WALL - 100, 6);
  });

  it('never answers a time main would refuse: an unreadable clock dates the chunk now', () => {
    // Main refuses a chunk whose time is not finite (ipc-validation.ts), and its audio with it.
    const at = frameCapturedAtMs(
      1.5 * RATE,
      RATE,
      { outputTimestamp: {}, currentTime: Number.NaN },
      { performanceNow: 9_999, dateNow: WALL },
    );
    expect(at).toBe(WALL);
  });
});
