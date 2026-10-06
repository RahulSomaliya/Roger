/**
 * How far a chunk's capture time may sit from where its run predicts it before the chunk starts a
 * new run (M2 design, "Timeline"). Over it, audio is missing (a stall, a held reconnect, a sleep)
 * or the clock moved; under it is the jitter of the capture times themselves. Inside a run it
 * bounds how far a time can be misdated, so a line stays well inside the echo filter's ±700 ms
 * window. At a run boundary it bounds nothing: there the gap is, and RUN_EDGE_SNAP_MS decides.
 */
export const RUN_DRIFT_LIMIT_MS = 250;

/**
 * How far a span may reach across a run boundary and still be read as spill rather than audio
 * from the other side: toCapturedSpan cuts a piece this short off at the boundary. The vendor
 * hears spliced audio with no hole, and its word edges are a model's estimate, not the splice
 * point, so a word cut by a stall ends a little past the boundary (or the next word starts a
 * little before it), almost never on it. Mapped as it stands, that piece lands on the far side of
 * the gap and stretches the word and its line across all of it: after an 18 s stall a two-word mic
 * line would be 18 s long, overlap its call-audio twin by about 2%, and the echo filter would keep
 * it. A cut moves an edge by at most this much of the stream's own clock; a longer piece is real
 * audio and the span keeps it.
 */
export const RUN_EDGE_SNAP_MS = 200;

/** A stretch of contiguous audio: samples with no hole between them on the wall clock. */
export interface AudioRun {
  /** Where the run begins on the stream's own clock, in samples from the stream's first one. */
  readonly startSample: number;
  /** Wall clock (epoch ms) of the run's first sample, taken where it was captured. */
  readonly capturedAtMs: number;
  /** Samples in the run so far: a live view, it grows while the run is the last one. */
  readonly sampleCount: number;
  /**
   * How far the run's first capture time sits from where the previous run predicted it, or null
   * for the stream's first run. Positive is audio that never came (a stall, a sleep); negative is
   * the clock stepping back (a time correction) or a device clock running fast.
   */
  readonly jumpMs: number | null;
}

/** Which run a time exactly on a run boundary belongs to: see toCapturedAtMs. */
export type TimelineEdge = 'start' | 'end';

/** A span as wall clock (epoch ms): see toCapturedSpan. */
export interface CapturedSpan {
  readonly startMs: number;
  readonly endMs: number;
}

interface Run {
  startSample: number;
  capturedAtMs: number;
  sampleCount: number;
  jumpMs: number | null;
}

/**
 * Where each stretch of one audio stream sits on the wall clock, so a time on the stream's own
 * clock (a vendor's word times count from the first byte it was sent) maps to when that audio was
 * captured (M2 design, "Timeline").
 *
 * A vendor hears its audio as one continuous stream: a stall, a held reconnect or a sleep leaves no
 * hole in it. M1 dated every line from the stream's first chunk, so each such gap made every later
 * line early by the gap's length (a 10-minute sleep, 10 minutes). Here every chunk brings the
 * capture time of its first sample, and a chunk whose time drifts from what its run's samples
 * predict by more than RUN_DRIFT_LIMIT_MS starts a new run; a time maps through the run that holds
 * it, and a span's spill across a run boundary is cut off at it (RUN_EDGE_SNAP_MS).
 *
 * Feed it capture times, never arrival times: chunks reach main 0 to 400 ms late (GC pauses,
 * synchronous SQLite writes, two different paths for the two sources), which would split runs
 * falsely. Predictions come from the run's first chunk plus whole samples, not from the previous
 * chunk, so jitter in the capture times never adds up, and 2 hours of chunks stay sample-accurate
 * at any rate.
 *
 * One instance per vendor stream in CaptureSession (a reopened stream starts its own clock). It
 * keeps every run: a vendor may date a line seconds after its audio, and a run starts only at a
 * gap or a clock jump, so the list stays short.
 */
export class AudioTimeline {
  private readonly runList: Run[] = [];
  private samples = 0;

  constructor(private readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError(
        `An audio timeline needs a positive whole sample rate, not ${sampleRate}.`,
      );
    }
  }

  /** Every run so far, oldest first. */
  get runs(): readonly AudioRun[] {
    return this.runList;
  }

  /** Samples appended so far: where the stream's own clock stands. */
  get sampleCount(): number {
    return this.samples;
  }

  /**
   * The stream's next chunk, in the order it was sent: `samples` of audio whose first sample was
   * captured at `capturedAtMs` (wall clock, epoch ms). Returns the run it started, or null when it
   * continues the last one (or has no samples). Throws a RangeError on a time or a count it cannot
   * place: a chunk dated NaN would date every later line NaN.
   */
  append(capturedAtMs: number, samples: number): AudioRun | null {
    if (!Number.isFinite(capturedAtMs)) {
      throw new RangeError(
        `An audio chunk's capture time must be a finite epoch ms, not ${capturedAtMs}.`,
      );
    }
    if (!Number.isInteger(samples) || samples < 0) {
      throw new RangeError(
        `An audio chunk holds a whole, non-negative number of samples, not ${samples}.`,
      );
    }
    if (samples === 0) return null;
    const last = this.runList.at(-1);
    const jumpMs = last === undefined ? null : capturedAtMs - this.endOf(last);
    let started: Run | null = null;
    if (last === undefined || (jumpMs !== null && Math.abs(jumpMs) > RUN_DRIFT_LIMIT_MS)) {
      started = { startSample: this.samples, capturedAtMs, sampleCount: samples, jumpMs };
      this.runList.push(started);
    } else {
      last.sampleCount += samples;
    }
    this.samples += samples;
    return started;
  }

  /**
   * Wall clock (epoch ms) of `streamMs` on the stream's own clock, or null before the first chunk.
   * A time on a run boundary is both the first sample of the later run and the end of the earlier
   * one: a line's or word's start (`'start'`) belongs to the run it opens, its end (`'end'`) to the
   * run it closes. Times before the first sample or past the last are placed by the nearest run.
   *
   * One time alone cannot tell a vendor's spill past a boundary from audio on the far side of it,
   * so a line's or a word's span goes through toCapturedSpan, never through two calls here.
   */
  toCapturedAtMs(streamMs: number, edge: TimelineEdge = 'start'): number | null {
    const sample = this.msToSamples(streamMs);
    const run = this.runList[this.runIndexAt(sample, edge)];
    return run === undefined ? null : this.throughRun(run, sample);
  }

  /**
   * A span on the stream's own clock (a line's or a word's) as wall clock (epoch ms), or null
   * before the first chunk. A span inside one run maps as its two edges do. A span across a run
   * boundary loses a piece of RUN_EDGE_SNAP_MS or less beyond it: its end is cut back to the end of
   * the run before (spill past the splice), its start moved up to the start of the run after (spill
   * before it). Over a single boundary only the shorter piece is cut, so a short word astride one
   * lands on the side that holds more of it (a tie stays before the boundary). Over several, each
   * edge is cut at its own nearest boundary only, so no edge moves by more than RUN_EDGE_SNAP_MS
   * of the stream's clock (on the wall clock it moves by that plus the gap it no longer crosses).
   *
   * The decision needs both edges: a short word that ends just before a gap is real audio before
   * it, and its start must not be carried across with a start rule alone. A span whose end comes
   * before its start is mapped as it stands.
   */
  toCapturedSpan(startMs: number, endMs: number): CapturedSpan | null {
    let start = this.msToSamples(startMs);
    let end = this.msToSamples(endMs);
    let first = this.runIndexAt(start, 'start');
    let last = this.runIndexAt(end, 'end');
    const afterFirst = this.runList[first + 1];
    const lastRun = this.runList[last];
    if (last > first && afterFirst !== undefined && lastRun !== undefined) {
      const snap = this.msToSamples(RUN_EDGE_SNAP_MS);
      const head = afterFirst.startSample - start;
      const tail = end - lastRun.startSample;
      // Over one boundary, head and tail are the two sides of it: never cut both.
      const oneBoundary = last === first + 1;
      if (tail <= snap && (!oneBoundary || tail <= head)) {
        end = lastRun.startSample;
        last -= 1;
      }
      if (head <= snap && (!oneBoundary || head < tail)) {
        start = afterFirst.startSample;
        first += 1;
      }
    }
    const startRun = this.runList[first];
    const endRun = this.runList[last];
    if (startRun === undefined || endRun === undefined) return null;
    return { startMs: this.throughRun(startRun, start), endMs: this.throughRun(endRun, end) };
  }

  /**
   * Index of the last run that starts at the sample (a start) or before it (an end): see
   * toCapturedAtMs. The first run's for a sample before any, and 0 with no run yet.
   */
  private runIndexAt(sample: number, edge: TimelineEdge): number {
    let index = 0;
    let low = 1;
    let high = this.runList.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = this.runList[middle];
      if (candidate === undefined) break;
      const holds =
        edge === 'start' ? candidate.startSample <= sample : candidate.startSample < sample;
      if (holds) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return index;
  }

  /** Wall clock of a sample on the stream's clock, placed through `run`. */
  private throughRun(run: Run, sample: number): number {
    return run.capturedAtMs + this.samplesToMs(sample - run.startSample);
  }

  /** Where the run's next sample is due on the wall clock. */
  private endOf(run: Run): number {
    return run.capturedAtMs + this.samplesToMs(run.sampleCount);
  }

  private samplesToMs(samples: number): number {
    return (samples * 1_000) / this.sampleRate;
  }

  private msToSamples(ms: number): number {
    return (ms * this.sampleRate) / 1_000;
  }
}
