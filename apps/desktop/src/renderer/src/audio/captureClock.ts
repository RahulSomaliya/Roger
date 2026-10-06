/**
 * When a chunk's first sample was captured, on the wall clock: `AudioChunkMessage.capturedAtMs`
 * (M2 design, "Timeline"). The worklet names the sample by its frame on the AudioContext's clock;
 * the page dates it as `Date.now()` minus the frame's age on the monotonic clock, read per chunk.
 *
 * Never `performance.timeOrigin + performanceTime`: on macOS Chromium's monotonic clock stops
 * while the Mac sleeps, so that sum falls behind the wall clock by every sleep since the page
 * loaded, and the page lives for days once closing the window hides it (M5-T11). The mic's lines
 * would land hours early, and past a day main refuses every mic chunk. An age is a difference of
 * two monotonic readings, which a sleep does not touch; the wall clock is read only as `Date.now()`.
 */

/** The AudioContext's clocks, read when a chunk arrives. */
export interface ContextClock {
  /** `getOutputTimestamp()`: a context time, and the `performance.now()` time it plays at. */
  outputTimestamp: AudioTimestamp;
  /** `currentTime`, in seconds. */
  currentTime: number;
}

/** The page's clocks, read when a chunk arrives. */
export interface PageClock {
  /** `performance.now()`: monotonic, ms. */
  performanceNow: number;
  /** `Date.now()`: the wall clock, epoch ms. */
  dateNow: number;
}

export function readPageClock(): PageClock {
  return { performanceNow: performance.now(), dateNow: Date.now() };
}

/** The wall clock (epoch ms) of the sample at `frame` on a context running at `sampleRate`. */
export function frameCapturedAtMs(
  frame: number,
  sampleRate: number,
  context: ContextClock,
  page: PageClock,
): number {
  const frameSeconds = frame / sampleRate;
  const { contextTime, performanceTime } = context.outputTimestamp;
  const ageMs =
    contextTime !== undefined && performanceTime !== undefined && performanceTime > 0
      ? page.performanceNow - (performanceTime + (frameSeconds - contextTime) * 1000)
      : // Both are 0 until the context renders its first quantum. Its own clock is monotonic too,
        // and differs from the output clock only by the output latency.
        (context.currentTime - frameSeconds) * 1000;
  // Main refuses a chunk whose time is not finite, and its audio with it (ipc-validation.ts):
  // dated now, the chunk is a few ms late on the timeline instead of lost.
  return Number.isFinite(ageMs) ? page.dateNow - ageMs : page.dateNow;
}
