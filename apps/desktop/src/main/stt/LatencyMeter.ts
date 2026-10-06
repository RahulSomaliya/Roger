import type { SttEvent } from './SpeechToText';

/**
 * Word latency for one speech-to-text stream: how long after a word was spoken it first showed
 * (display latency), and how long until the final line holding it arrived (final latency).
 *
 * Measured per word, never per event. "Event lag" (an event's arrival minus the capture time of
 * the audio it ends on) cannot see a stall: if a vendor sends nothing for 4 s and then a partial
 * covering audio up to 0.5 s ago, that event scores 0.5 s while the person waited about 4 s for
 * the words in between. Here a word waits for the first event (interim or final) whose end
 * reaches the word's end. A word only exists where someone spoke, so the longest wait is the
 * longest stall while speech was present.
 *
 * Pure and free of Electron imports on purpose: the app (CaptureSession, which logs `stt latency`
 * at Stop) and the benchmark (which replays WAV files) run this same code, so their numbers can be
 * compared. Memory stays flat over a long call: fixed 50 ms buckets plus one overflow bucket, and
 * a short list of event end points that every final prunes.
 */

/**
 * The wall-clock time (epoch ms) when the sample at `streamMs` of this stream was captured. The app
 * passes the stream's AudioTimeline (M2-T5), the benchmark its replay clock. Every time the meter
 * compares sits on this one clock, so after a reconnect that restarts the vendor's stream time the
 * function must map the new connection's times: end points from the old connection stay valid.
 */
export type CaptureClock = (streamMs: number) => number;

export interface LatencySummary {
  /** Words measured. */
  words: number;
  /** Percentiles are nearest-rank, rounded up to their 50 ms bucket and never past the longest. */
  displayP50Ms: number | null;
  displayP95Ms: number | null;
  finalP50Ms: number | null;
  finalP95Ms: number | null;
  /** The largest single-word display latency. */
  longestWaitMs: number | null;
  /**
   * Words that showed before their last sample was captured, by the two clocks. They count as
   * 0 ms. A few means clock jitter; most of a call's words means the capture clock is wrong, and
   * every number above reads too low.
   */
  clampedWords: number;
  /**
   * Words that lie mostly in audio whose words an earlier final already measured (a replay after
   * a reconnect). Counted here and not measured again.
   */
  repeatedWords: number;
}

const BUCKET_MS = 50;
const RANGE_MS = 10_000;
/** 200 buckets of 50 ms up to 10 s, then one overflow bucket. */
const BUCKETS = RANGE_MS / BUCKET_MS + 1;

/**
 * Most end points held at once. Only a stream that never sends a final reaches it (every final
 * prunes the list). Dropping the oldest end point can only make a later word count from a later
 * event, so the cap can overstate a wait but never understate one.
 */
export const MAX_END_POINTS = 512;

/** Latencies in fixed buckets: memory does not grow with the length of the call. */
class LatencyHistogram {
  // Bucket i holds (50i, 50(i+1)] ms (bucket 0 also holds 0), so a bucket's upper bound is the
  // smallest bound at or above every value in it. A word at exactly 2 000 ms reads 2 000, not 2 050.
  readonly counts = new Uint32Array(BUCKETS);
  count = 0;
  maxMs: number | null = null;

  add(latencyMs: number): void {
    const index =
      latencyMs > RANGE_MS ? BUCKETS - 1 : Math.max(0, Math.ceil(latencyMs / BUCKET_MS) - 1);
    this.counts[index] = (this.counts[index] ?? 0) + 1;
    this.count += 1;
    this.maxMs = this.maxMs === null ? latencyMs : Math.max(this.maxMs, latencyMs);
  }

  addAll(other: LatencyHistogram): void {
    other.counts.forEach((count, index) => {
      this.counts[index] = (this.counts[index] ?? 0) + count;
    });
    this.count += other.count;
    if (other.maxMs !== null) {
      this.maxMs = this.maxMs === null ? other.maxMs : Math.max(this.maxMs, other.maxMs);
    }
  }

  /**
   * Nearest-rank percentile as the upper bound of its bucket, so it is never below the true value
   * and a gate like "p95 of 2 000 ms or less" cannot pass on rounding. Capped at the longest
   * latency; a percentile in the overflow bucket is the longest latency.
   */
  percentile(fraction: number): number | null {
    if (this.maxMs === null) return null;
    const rank = Math.ceil(fraction * this.count);
    let seen = 0;
    for (let index = 0; index < BUCKETS - 1; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= rank) return Math.ceil(Math.min((index + 1) * BUCKET_MS, this.maxMs));
    }
    return Math.ceil(this.maxMs);
  }
}

class WordLatencyStats {
  readonly display = new LatencyHistogram();
  readonly final = new LatencyHistogram();
  clampedWords = 0;
  repeatedWords = 0;

  addWord(displayMs: number, finalMs: number): void {
    // The final arrives no earlier than the first event that showed the word, so a negative
    // final latency always comes with a negative display latency: one word, counted once.
    if (displayMs < 0) this.clampedWords += 1;
    this.display.add(Math.max(0, displayMs));
    this.final.add(Math.max(0, finalMs));
  }

  addAll(other: WordLatencyStats): void {
    this.display.addAll(other.display);
    this.final.addAll(other.final);
    this.clampedWords += other.clampedWords;
    this.repeatedWords += other.repeatedWords;
  }

  summary(): LatencySummary {
    return {
      words: this.display.count,
      displayP50Ms: this.display.percentile(0.5),
      displayP95Ms: this.display.percentile(0.95),
      finalP50Ms: this.final.percentile(0.5),
      finalP95Ms: this.final.percentile(0.95),
      longestWaitMs: this.display.maxMs === null ? null : Math.ceil(this.display.maxMs),
      clampedWords: this.clampedWords,
      repeatedWords: this.repeatedWords,
    };
  }
}

/** An event that showed text up to `shownToMs` (capture clock) when it arrived. */
interface EndPoint {
  arrivedAtMs: number;
  shownToMs: number;
}

/** A word of a final on the capture clock: when its middle and its last sample were captured. */
interface FinalWord {
  middleMs: number;
  endMs: number;
}

/** One meter per stream: mic and system are measured, and gated, separately. */
export class LatencyMeter {
  private readonly stats = new WordLatencyStats();
  /**
   * Only events that showed further than every event before them. The first event to reach a
   * word's end is always one of these (every earlier event ended short of it), and the list is
   * sorted by arrival and by `shownToMs` at once, so a binary search finds it.
   */
  private readonly endPoints: EndPoint[] = [];
  private furthestShownMs = Number.NEGATIVE_INFINITY;
  /**
   * The latest end of a word measured so far. Only measured words set it, never a line's end:
   * Deepgram ends a line at its result window, which can run past the line's last word, and the
   * next line's first word can end inside that window. A line end here would count that new word
   * as a replay and never measure it.
   */
  private measuredToMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly captureTimeAt: CaptureClock) {}

  /** Combined numbers of several streams, as the benchmark reports them across items. */
  static pool(meters: Iterable<LatencyMeter>): LatencySummary {
    const pooled = new WordLatencyStats();
    for (const meter of meters) pooled.addAll(meter.stats);
    return pooled.summary();
  }

  /**
   * Feed every event of the stream, in the order it arrived. `arrivedAtMs` is wall-clock epoch ms,
   * on the same clock as the capture times. Errors and closes show no words and are ignored.
   * Throws a RangeError, and changes nothing, when a time is not a finite number.
   */
  record(event: SttEvent, arrivedAtMs: number): void {
    if (event.type !== 'interim' && event.type !== 'final') return;
    if (!Number.isFinite(arrivedAtMs)) {
      throw new RangeError(
        `Latency meter got an arrival time that is not a number: ${arrivedAtMs}`,
      );
    }
    // Map every time before changing any state, so a refused event leaves the meter as it was.
    const shownToMs = this.captureTime(event.endMs);
    const words: FinalWord[] =
      event.type === 'final'
        ? event.words.map((word) => ({
            middleMs: this.captureTime((word.startMs + word.endMs) / 2),
            endMs: this.captureTime(word.endMs),
          }))
        : [];

    // An event with no text shows nothing, so it must not count as showing the words it spans:
    // a vendor that sends blank partials during speech would read as faster than it is.
    if (event.text.trim() !== '' && shownToMs > this.furthestShownMs) {
      this.furthestShownMs = shownToMs;
      this.endPoints.push({ arrivedAtMs, shownToMs });
      if (this.endPoints.length > MAX_END_POINTS) this.endPoints.shift();
    }
    if (event.type === 'final') this.measureFinal(words, shownToMs, arrivedAtMs);
  }

  summary(): LatencySummary {
    return this.stats.summary();
  }

  /** End points held now (the memory check in the tests). */
  get endPointCount(): number {
    return this.endPoints.length;
  }

  /** Counters in each latency histogram; fixed for the life of the meter. */
  get bucketCount(): number {
    return this.stats.display.counts.length;
  }

  private measureFinal(words: FinalWord[], shownToMs: number, arrivedAtMs: number): void {
    let measuredToMs = this.measuredToMs;
    for (const word of words) {
      // A replayed word whose middle sits in measured audio is the same word, even when the new
      // connection puts its end tens of milliseconds later; its end alone would time it twice. A
      // new word that starts a little before the last one ended still has its middle past it.
      // Compare with what earlier finals measured, never with `measuredToMs` above: words of one
      // line can overlap, and the later one would read as repeated.
      if (word.middleMs <= this.measuredToMs) {
        this.stats.repeatedWords += 1;
        continue;
      }
      // A word that ends past every event (vendors round a word's end past its line's end now
      // and then) showed with this final.
      const shownAtMs = this.firstShownAt(word.endMs) ?? arrivedAtMs;
      this.stats.addWord(shownAtMs - word.endMs, arrivedAtMs - word.endMs);
      measuredToMs = Math.max(measuredToMs, word.endMs);
    }
    this.measuredToMs = measuredToMs;
    // Pruned up to the line's end as well, so a final with no words still keeps the list short.
    // A later new word that ends at or before this point was not in this line, so this line did
    // not show it: it counts from the next event that reaches it, which can overstate its wait but
    // never understate it.
    const prunedToMs = Math.max(shownToMs, measuredToMs);
    const firstKept = this.endPoints.findIndex((point) => point.shownToMs > prunedToMs);
    this.endPoints.splice(0, firstKept === -1 ? this.endPoints.length : firstKept);
  }

  private firstShownAt(wordEndMs: number): number | undefined {
    let low = 0;
    let high = this.endPoints.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.endPoints[middle]?.shownToMs ?? Number.POSITIVE_INFINITY) < wordEndMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return this.endPoints[low]?.arrivedAtMs;
  }

  private captureTime(streamMs: number): number {
    const capturedAtMs = this.captureTimeAt(streamMs);
    if (!Number.isFinite(capturedAtMs)) {
      throw new RangeError(
        `Latency meter got a capture time that is not a number (${capturedAtMs}) for stream ` +
          `time ${streamMs} ms`,
      );
    }
    return capturedAtMs;
  }
}
