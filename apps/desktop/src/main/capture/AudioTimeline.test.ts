import { describe, expect, it } from 'vitest';
import { AudioTimeline, RUN_DRIFT_LIMIT_MS } from './AudioTimeline';

const RATE = 16_000;
/** 100 ms at 16 kHz: the renderer's and the helper's chunk. */
const CHUNK_SAMPLES = 1_600;
const CHUNK_MS = 100;
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const MINUTE = 60_000;

/** A seeded stand-in for Math.random (mulberry32), so a failing case replays exactly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Appends `count` contiguous 100 ms chunks whose first sample was captured at `fromMs`. */
function appendContiguous(timeline: AudioTimeline, fromMs: number, count: number): void {
  for (let i = 0; i < count; i += 1) timeline.append(fromMs + i * CHUNK_MS, CHUNK_SAMPLES);
}

describe('AudioTimeline', () => {
  it('has no run and maps nothing before its first chunk', () => {
    const timeline = new AudioTimeline(RATE);
    expect(timeline.runs).toEqual([]);
    expect(timeline.sampleCount).toBe(0);
    expect(timeline.toCapturedAtMs(0)).toBeNull();
  });

  it('keeps contiguous audio in one run however late each chunk reached main', () => {
    const random = seeded(7);
    const chunks = Array.from({ length: 600 }, (_, i) => {
      const capturedAtMs = T0 + i * CHUNK_MS;
      // What main sees: the chunk lands 0 to 400 ms after its last sample, the delays in random
      // order (GC pauses, a synchronous SQLite write, IPC). Order itself holds: one pipe per source.
      return { capturedAtMs, arrivedAtMs: capturedAtMs + CHUNK_MS + random() * 400 };
    });

    const byCapture = new AudioTimeline(RATE);
    for (const chunk of chunks) byCapture.append(chunk.capturedAtMs, CHUNK_SAMPLES);
    expect(byCapture.runs).toHaveLength(1);
    expect(byCapture.toCapturedAtMs(59_950)).toBe(T0 + 59_950);

    // The delays are big enough to matter: dated by arrival, the same audio splits into runs. This
    // is why every chunk carries the time it was captured (AudioChunkMessage.capturedAtMs).
    const byArrival = new AudioTimeline(RATE);
    for (const chunk of chunks) byArrival.append(chunk.arrivedAtMs - CHUNK_MS, CHUNK_SAMPLES);
    expect(byArrival.runs.length).toBeGreaterThan(1);
  });

  it('neither splits nor drifts on capture-time jitter under the limit', () => {
    const random = seeded(11);
    const timeline = new AudioTimeline(RATE);
    // Each time is the renderer's mapping of the frame to the wall clock, off by up to 100 ms
    // either way. Predictions come from the run's first chunk and its sample count, never from the
    // previous chunk's time, so the errors cannot add up over 10 minutes.
    for (let i = 0; i < 6_000; i += 1) {
      const jitter = i === 0 ? 0 : (random() * 2 - 1) * 100;
      timeline.append(T0 + i * CHUNK_MS + jitter, CHUNK_SAMPLES);
    }
    expect(timeline.runs).toHaveLength(1);
    expect(timeline.toCapturedAtMs(10 * MINUTE, 'end')).toBe(T0 + 10 * MINUTE);
  });

  it('starts a new run on a capture gap of more than 250 ms, and not on one of 250 ms', () => {
    expect(RUN_DRIFT_LIMIT_MS).toBe(250);
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 10); // 1 s of audio: the next sample is due at T0 + 1000
    timeline.append(T0 + 1_000 + 250, CHUNK_SAMPLES);
    expect(timeline.runs).toHaveLength(1);

    const gap = new AudioTimeline(RATE);
    appendContiguous(gap, T0, 10);
    const run = gap.append(T0 + 1_000 + 300, CHUNK_SAMPLES);
    expect(gap.runs).toHaveLength(2);
    expect(run).toEqual({
      startSample: 10 * CHUNK_SAMPLES,
      capturedAtMs: T0 + 1_300,
      sampleCount: CHUNK_SAMPLES,
      jumpMs: 300,
    });
    // The audio after the gap is placed where it was captured, not right after the first second.
    expect(gap.toCapturedAtMs(1_050)).toBe(T0 + 1_350);
  });

  it('starts a new run when the clock steps back, and says how far', () => {
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 10);
    const run = timeline.append(T0 + 1_000 - 2_000, CHUNK_SAMPLES);
    expect(run?.jumpMs).toBe(-2_000);
    expect(timeline.runs).toHaveLength(2);
  });

  it('reports the first chunk as a run with no jump, and later chunks of a run as none', () => {
    const timeline = new AudioTimeline(RATE);
    expect(timeline.append(T0, CHUNK_SAMPLES)).toEqual({
      startSample: 0,
      capturedAtMs: T0,
      sampleCount: CHUNK_SAMPLES,
      jumpMs: null,
    });
    expect(timeline.append(T0 + CHUNK_MS, CHUNK_SAMPLES)).toBeNull();
    expect(timeline.runs[0]?.sampleCount).toBe(2 * CHUNK_SAMPLES);
    expect(timeline.sampleCount).toBe(2 * CHUNK_SAMPLES);
  });

  it('maps a vendor time into the run that holds it', () => {
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 20); // stream 0-2 s, captured T0 to T0 + 2 s
    appendContiguous(timeline, T0 + 5_000, 10); // stream 2-3 s, captured 3 s later
    appendContiguous(timeline, T0 + 9_000, 10); // stream 3-4 s, captured 6 s later still
    expect(timeline.runs.map((run) => run.capturedAtMs)).toEqual([T0, T0 + 5_000, T0 + 9_000]);

    expect(timeline.toCapturedAtMs(1_500)).toBe(T0 + 1_500);
    expect(timeline.toCapturedAtMs(2_400)).toBe(T0 + 5_400);
    expect(timeline.toCapturedAtMs(3_999)).toBe(T0 + 9_999);
  });

  it('puts a time on a run boundary in the run it opens as a start, the run it closes as an end', () => {
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 20);
    appendContiguous(timeline, T0 + 5_000, 10);
    // A line that starts at stream 2 s starts with the second run's audio; a word that ends there
    // ended with the first run's last sample, before the gap.
    expect(timeline.toCapturedAtMs(2_000, 'start')).toBe(T0 + 5_000);
    expect(timeline.toCapturedAtMs(2_000, 'end')).toBe(T0 + 2_000);
    expect(timeline.toCapturedAtMs(0, 'end')).toBe(T0);
  });

  it('places times outside the audio by the nearest run', () => {
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 10);
    appendContiguous(timeline, T0 + 3_000, 10);
    expect(timeline.toCapturedAtMs(-40)).toBe(T0 - 40);
    // A vendor may stamp an end a little past the audio it was sent.
    expect(timeline.toCapturedAtMs(2_030, 'end')).toBe(T0 + 3_000 + 1_030);
  });

  it('keeps later lines at the wall clock across a 10-minute sleep', () => {
    const timeline = new AudioTimeline(RATE);
    appendContiguous(timeline, T0, 300); // 30 s, then the lid closes
    const wake = T0 + 30_000 + 10 * MINUTE;
    appendContiguous(timeline, wake, 300);
    // The vendor heard 60 s of audio with no hole in it; a line 40 s in was said 10 s after wake.
    // The landed first-chunk offset would have put it at T0 + 40 s, 10 minutes early.
    expect(timeline.toCapturedAtMs(40_000)).toBe(wake + 10_000);
    expect(timeline.toCapturedAtMs(20_000)).toBe(T0 + 20_000);
  });

  it('keeps sample accuracy over 2 hours of chunks', () => {
    const timeline = new AudioTimeline(RATE);
    const chunks = (2 * 60 * MINUTE) / CHUNK_MS; // 72,000
    appendContiguous(timeline, T0, chunks);
    expect(timeline.runs).toHaveLength(1);
    expect(timeline.sampleCount).toBe(chunks * CHUNK_SAMPLES);
    for (let minute = 0; minute <= 120; minute += 10) {
      expect(timeline.toCapturedAtMs(minute * MINUTE, 'end')).toBe(T0 + minute * MINUTE);
    }
    // One sample is 1/16 ms at 16 kHz: the last one is still exactly where it was captured.
    expect(timeline.toCapturedAtMs(2 * 60 * MINUTE - 0.0625)).toBe(T0 + 2 * 60 * MINUTE - 0.0625);
  });

  it('keeps sample accuracy over 2 hours at a rate whose samples are not whole ms', () => {
    // 1,024 samples at 48 kHz is 21.333... ms: summing chunk lengths in ms would round on every
    // chunk. The timeline counts whole samples and converts once.
    const rate = 48_000;
    const samples = 1_024;
    const timeline = new AudioTimeline(rate);
    const chunks = (2 * 60 * 60 * rate) / samples; // 337,500
    for (let i = 0; i < chunks; i += 1) {
      timeline.append(T0 + (i * samples * 1_000) / rate, samples);
    }
    expect(timeline.runs).toHaveLength(1);
    expect(timeline.toCapturedAtMs(2 * 60 * MINUTE, 'end')).toBe(T0 + 2 * 60 * MINUTE);
  });

  it('refuses a capture time or a sample count it cannot place, and skips an empty chunk', () => {
    const timeline = new AudioTimeline(RATE);
    expect(() => timeline.append(Number.NaN, CHUNK_SAMPLES)).toThrow(RangeError);
    expect(() => timeline.append(Number.POSITIVE_INFINITY, CHUNK_SAMPLES)).toThrow(RangeError);
    expect(() => timeline.append(T0, 1.5)).toThrow(RangeError);
    expect(() => timeline.append(T0, -2)).toThrow(RangeError);
    expect(timeline.append(T0, 0)).toBeNull();
    expect(timeline.runs).toEqual([]);
    expect(() => new AudioTimeline(0)).toThrow(RangeError);
  });
});
