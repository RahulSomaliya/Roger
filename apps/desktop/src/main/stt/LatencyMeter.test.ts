import { describe, expect, it } from 'vitest';
import {
  type CaptureClock,
  LatencyMeter,
  type LatencySummary,
  MAX_END_POINTS,
} from './LatencyMeter';
import type { SttEvent } from './SpeechToText';

/** Wall-clock time when the stream's first sample was captured. */
const BASE = Date.UTC(2026, 9, 6, 9, 0, 0);
/** A stream with no gaps: the sample at stream time t was captured at BASE + t. */
const steadyClock: CaptureClock = (streamMs) => BASE + streamMs;

const NO_WORDS: LatencySummary = {
  words: 0,
  displayP50Ms: null,
  displayP95Ms: null,
  finalP50Ms: null,
  finalP95Ms: null,
  longestWaitMs: null,
  clampedWords: 0,
  repeatedWords: 0,
};

const interim = (endMs: number, text = 'partial words'): SttEvent => ({
  type: 'interim',
  text,
  startMs: 0,
  endMs,
});

/** A final holding one word per entry of `wordEndsMs`; the line ends with its last word by default. */
const final = (wordEndsMs: number[], endMs = wordEndsMs.at(-1) ?? 0): SttEvent => ({
  type: 'final',
  text: wordEndsMs.map(() => 'word').join(' '),
  startMs: Math.max(0, (wordEndsMs[0] ?? 0) - 150),
  endMs,
  confidence: 0.9,
  words: wordEndsMs.map((wordEndMs) => ({
    text: 'word',
    startMs: wordEndMs - 150,
    endMs: wordEndMs,
    confidence: 0.9,
  })),
});

/** One word, first shown by its own final `latencyMs` after it was captured. */
const showWord = (meter: LatencyMeter, endMs: number, latencyMs: number): void => {
  meter.record(final([endMs]), BASE + endMs + latencyMs);
};

describe('LatencyMeter', () => {
  it('times a word from the first event whose end reaches the word', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(800), BASE + 1_100); // ends before the word: it does not show it
    meter.record(interim(1_200), BASE + 1_500); // the first to reach the word's end
    meter.record(interim(1_500), BASE + 1_700);
    meter.record(final([1_000], 1_500), BASE + 2_000);

    expect(meter.summary()).toMatchObject({ words: 1, displayP50Ms: 500, longestWaitMs: 500 });
  });

  it('puts every word on the capture clock through the stream timeline', () => {
    // The Mac slept for 10 minutes between stream times 5 s and 6 s. AudioTimeline starts a new
    // run there, so the second word was captured 10 minutes later than its stream time says.
    const sleepMs = 600_000;
    const timeline: CaptureClock = (streamMs) =>
      BASE + streamMs + (streamMs >= 5_000 ? sleepMs : 0);
    const meter = new LatencyMeter(timeline);
    meter.record(final([1_000]), BASE + 1_400);
    meter.record(final([6_000]), BASE + sleepMs + 6_700);

    // On stream time alone the second word would read as a 10-minute wait.
    expect(meter.summary()).toMatchObject({
      words: 2,
      displayP50Ms: 400,
      displayP95Ms: 700,
      longestWaitMs: 700,
    });
  });

  it('reports about 4 s for words behind a 4 s stall, not the 0.5 s lag of the event after it', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(1_000), BASE + 1_300);
    // The vendor sends nothing for almost 4 s while the person keeps talking, then a partial
    // covering audio up to 0.5 s before it arrived. Event lag would score that partial 0.5 s.
    meter.record(interim(4_500), BASE + 5_000);
    meter.record(final([1_000, 1_100, 2_000, 3_000, 4_500]), BASE + 5_600);

    const summary = meter.summary();
    // The word ending at 1.1 s waited from BASE + 1 100 to BASE + 5 000.
    expect(summary.longestWaitMs).toBe(3_900);
    expect(summary.displayP95Ms).toBe(3_900);
    expect(summary.words).toBe(5);
  });

  it('times final latency from the arrival of the final that holds the word', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(1_200), BASE + 1_400);
    meter.record(final([1_000], 1_200), BASE + 2_500);

    expect(meter.summary()).toMatchObject({
      displayP50Ms: 400,
      finalP50Ms: 1_500,
      finalP95Ms: 1_500,
    });
  });

  it('reports the longest wait as the largest display latency, not the largest final latency', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(1_000), BASE + 1_700); // the first word shows after 700 ms
    meter.record(final([1_000, 2_000]), BASE + 3_200); // the second shows with the final, 1 200 ms

    expect(meter.summary()).toMatchObject({ longestWaitMs: 1_200, finalP95Ms: 2_200 });
  });

  it('gives exact nearest-rank p50 and p95 when latencies sit on bucket bounds', () => {
    const meter = new LatencyMeter(steadyClock);
    // 100 words at 20, 40, ... 2 000 ms, in a shuffled order (37 is coprime with 100).
    for (let index = 0; index < 100; index += 1) {
      showWord(meter, (index + 1) * 5_000, (((index * 37) % 100) + 1) * 20);
    }

    expect(meter.summary()).toMatchObject({
      words: 100,
      displayP50Ms: 1_000,
      displayP95Ms: 1_900,
      finalP50Ms: 1_000,
      finalP95Ms: 1_900,
      longestWaitMs: 2_000,
    });
  });

  it('rounds a percentile up to its 50 ms bucket, and never past the longest wait', () => {
    const twoWords = new LatencyMeter(steadyClock);
    showWord(twoWords, 1_000, 1_234);
    showWord(twoWords, 5_000, 1_300);
    expect(twoWords.summary()).toMatchObject({ displayP50Ms: 1_250, displayP95Ms: 1_300 });

    const oneWord = new LatencyMeter(steadyClock);
    showWord(oneWord, 1_000, 1_234);
    expect(oneWord.summary()).toMatchObject({ displayP50Ms: 1_234, longestWaitMs: 1_234 });

    // A word at exactly 2.0 s reads 2 000, so it meets a "2.0 s or less" gate.
    const atTheGate = new LatencyMeter(steadyClock);
    showWord(atTheGate, 1_000, 2_000);
    expect(atTheGate.summary().displayP95Ms).toBe(2_000);
  });

  it('puts waits over 10 s in the overflow bucket and reports the longest one for its percentile', () => {
    const meter = new LatencyMeter(steadyClock);
    for (let index = 0; index < 10; index += 1) showWord(meter, (index + 1) * 5_000, 100);
    for (let index = 10; index < 19; index += 1) showWord(meter, (index + 1) * 60_000, 12_000);
    showWord(meter, 30 * 60_000, 15_500);

    expect(meter.summary()).toMatchObject({
      words: 20,
      displayP50Ms: 100,
      displayP95Ms: 15_500,
      longestWaitMs: 15_500,
    });
  });

  it('does not count an interim with no text as showing a word', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(1_500, '  '), BASE + 1_100);
    meter.record(interim(1_500, 'hello'), BASE + 1_600);
    meter.record(final([1_000], 1_500), BASE + 2_000);

    expect(meter.summary().displayP50Ms).toBe(600);
  });

  it('counts a word that ends past every event from the final that holds it', () => {
    // Vendors now and then put a word's end a little past the end of its line.
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(900), BASE + 1_000);
    meter.record(final([1_000], 950), BASE + 1_700);

    expect(meter.summary()).toMatchObject({ displayP50Ms: 700, finalP50Ms: 700 });
  });

  it('measures a word once when a later final repeats audio an earlier final closed', () => {
    // A reconnect can replay audio the vendor already finalised. Those words were shown long ago;
    // timing them again would add a fake wait the length of the replay.
    const meter = new LatencyMeter(steadyClock);
    meter.record(final([1_000, 2_000]), BASE + 2_300);
    meter.record(final([2_000, 3_000]), BASE + 3_400);

    expect(meter.summary()).toMatchObject({ words: 3, repeatedWords: 1, longestWaitMs: 1_300 });
  });

  it('still measures a replayed word once when the new connection shifts its times a little', () => {
    // Transcribing the same audio again, the vendor can put a word's end 40 ms later than the
    // first time. Timed again, it would add a fake wait from the first line to the replay.
    const meter = new LatencyMeter(steadyClock);
    meter.record(final([1_000, 2_000]), BASE + 2_300);
    meter.record(final([2_040, 3_000]), BASE + 3_400);

    expect(meter.summary()).toMatchObject({ words: 3, repeatedWords: 1, longestWaitMs: 1_300 });
  });

  it('measures a word that ends inside an earlier line it was not part of, and calls it no replay', () => {
    // Deepgram ends a line at its result window (start plus duration), which can run past the
    // line's last word, and the next line's first word can end inside that window.
    const meter = new LatencyMeter(steadyClock);
    meter.record(interim(1_200), BASE + 1_400);
    meter.record(final([1_000, 2_600], 3_000), BASE + 3_300);
    meter.record(interim(3_500), BASE + 3_900);
    meter.record(final([2_950, 3_400]), BASE + 4_200);

    // The line that ended at 3.0 s did not hold the word ending at 2.95 s, so it did not show it:
    // the partial after it did, 950 ms after the word.
    expect(meter.summary()).toMatchObject({ words: 4, repeatedWords: 0, longestWaitMs: 950 });
  });

  it('counts a word that shows before its capture time as 0 ms, and says how many did', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record(final([1_000]), BASE + 960); // the two clocks disagree by 40 ms
    meter.record(final([2_000]), BASE + 2_500);

    expect(meter.summary()).toMatchObject({ words: 2, clampedWords: 1, longestWaitMs: 500 });
  });

  it('ignores errors and closes, which show no words', () => {
    const meter = new LatencyMeter(steadyClock);
    meter.record({ type: 'error', message: 'socket reset', fatal: false }, BASE + 100);
    meter.record({ type: 'closed', code: 1000, reason: null }, BASE + 200);

    expect(meter.endPointCount).toBe(0);
    expect(meter.summary()).toEqual(NO_WORDS);
  });

  it('refuses a capture time that is not a number, naming the stream time, and changes nothing', () => {
    const meter = new LatencyMeter((streamMs) => (streamMs > 1_500 ? Number.NaN : BASE + streamMs));

    expect(() => {
      meter.record(final([1_000, 2_000]), BASE + 2_500);
    }).toThrow(/stream time 2000 ms/);
    expect(meter.endPointCount).toBe(0);
    expect(meter.summary()).toEqual(NO_WORDS);
  });

  it('refuses an arrival time that is not a number', () => {
    const meter = new LatencyMeter(steadyClock);

    expect(() => {
      meter.record(interim(1_000), Number.POSITIVE_INFINITY);
    }).toThrow(/arrival time/);
    expect(meter.endPointCount).toBe(0);
  });

  it('keeps a fixed set of buckets and a short end-point list over 2 hours of events', () => {
    const meter = new LatencyMeter(steadyClock);
    const bucketsAtStart = meter.bucketCount;
    const twoHoursMs = 2 * 60 * 60 * 1_000;
    let mostEndPoints = 0;
    let wordsSpoken = 0;
    // 3 s turns: a partial every 250 ms, then a final with 8 words.
    for (let turnStartMs = 0; turnStartMs < twoHoursMs; turnStartMs += 3_000) {
      for (let endMs = turnStartMs + 250; endMs <= turnStartMs + 3_000; endMs += 250) {
        meter.record(interim(endMs), BASE + endMs + 400);
        mostEndPoints = Math.max(mostEndPoints, meter.endPointCount);
      }
      const wordEndsMs = Array.from({ length: 8 }, (_, index) => turnStartMs + 300 + index * 340);
      meter.record(final(wordEndsMs, turnStartMs + 3_000), BASE + turnStartMs + 3_450);
      wordsSpoken += wordEndsMs.length;
    }

    expect(meter.summary().words).toBe(wordsSpoken);
    // 200 buckets of 50 ms up to 10 s, plus the overflow bucket, for the whole call.
    expect(bucketsAtStart).toBe(201);
    expect(meter.bucketCount).toBe(201);
    // Never more than one turn's partials: each final prunes what it closed.
    expect(mostEndPoints).toBeLessThanOrEqual(12);
    expect(meter.endPointCount).toBe(0);
  });

  it('caps the end-point list when a stream never sends a final, and can then only overstate', () => {
    const meter = new LatencyMeter(steadyClock);
    for (let endMs = 100; endMs <= 200_000; endMs += 100) {
      meter.record(interim(endMs), BASE + endMs + 200);
    }
    expect(meter.endPointCount).toBe(MAX_END_POINTS);

    // The partial that first showed this word (ending at 100 ms, 250 ms after the word) was
    // dropped, so the word counts from a later partial: a longer wait, never a shorter one.
    meter.record(final([50], 200_000), BASE + 200_500);
    expect(meter.summary().longestWaitMs).toBeGreaterThan(250);
  });

  it('pools streams for the benchmark without changing them', () => {
    const mic = new LatencyMeter(steadyClock);
    showWord(mic, 1_000, 300);
    showWord(mic, 5_000, 900);
    mic.record(final([5_000]), BASE + 9_000); // the same word again
    const system = new LatencyMeter(steadyClock);
    system.record(final([500]), BASE + 490); // shows 10 ms early by the clocks
    showWord(system, 1_000, 1_600);

    expect(LatencyMeter.pool([mic, system])).toEqual({
      words: 4,
      displayP50Ms: 300,
      displayP95Ms: 1_600,
      finalP50Ms: 300,
      finalP95Ms: 1_600,
      longestWaitMs: 1_600,
      clampedWords: 1,
      repeatedWords: 1,
    });
    expect(mic.summary()).toMatchObject({ words: 2, longestWaitMs: 900 });
    expect(LatencyMeter.pool([])).toEqual(NO_WORDS);
  });
});
