import { describe, expect, it } from 'vitest';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { TranscriptWord } from '../../shared/transcript';
import { AudioTimeline } from '../capture/AudioTimeline';
import { mapFinal, missingPart, type RerunFinal } from './rerunLines';

function word(text: string, startMs: number, endMs: number): TranscriptWord {
  return { text, startMs, endMs, confidence: 0.9 };
}

function line(words: TranscriptWord[]): RerunFinal {
  return {
    startMs: words[0]?.startMs ?? 0,
    endMs: words.at(-1)?.endMs ?? 0,
    text: words.map((w) => w.text).join(' '),
    confidence: 0.8,
    words,
  };
}

describe('missingPart', () => {
  it('drops the words a stored line already holds and keeps the rest, spanned anew', () => {
    const rerun = line([
      word('first.', 2_200, 2_800),
      word('lost', 3_500, 3_900),
      word('words', 4_000, 4_400),
      word('second', 6_200, 6_600),
    ]);
    const stored = [
      { startMs: 0, endMs: 3_000 },
      { startMs: 6_000, endMs: 8_000 },
    ];
    expect(missingPart(rerun, stored)).toEqual({
      startMs: 3_500,
      endMs: 4_400,
      text: 'lost words',
      confidence: 0.8,
      words: [word('lost', 3_500, 3_900), word('words', 4_000, 4_400)],
    });
  });

  it("judges a word by its middle: one astride a stored line's edge goes to the side holding more", () => {
    // The stored line ends at 3000: "edge" (2900 to 3300) is mostly after it, "late" mostly before.
    const rerun = line([word('late', 2_600, 3_100), word('edge', 2_900, 3_300)]);
    expect(missingPart(rerun, [{ startMs: 0, endMs: 3_000 }])?.text).toBe('edge');
  });

  it('answers null for a line the stored lines already hold, and the line itself for none', () => {
    const rerun = line([word('said', 1_000, 1_400), word('already', 1_500, 1_900)]);
    expect(missingPart(rerun, [{ startMs: 900, endMs: 2_000 }])).toBeNull();
    expect(missingPart(rerun, [])).toEqual(rerun);
  });

  it("spreads a line's text over its span when the vendor sent no words, and keeps none", () => {
    const wordless: RerunFinal = {
      startMs: 1_000,
      endMs: 5_000,
      text: 'one two three four',
      confidence: null,
      words: [],
    };
    // Each word gets 1000 ms; a stored line over 1000 to 2600 holds "one" and "two".
    expect(missingPart(wordless, [{ startMs: 1_000, endMs: 2_600 }])).toEqual({
      startMs: 3_000,
      endMs: 5_000,
      text: 'three four',
      confidence: null,
      words: [],
    });
    expect(missingPart(wordless, [{ startMs: 9_000, endMs: 9_500 }])).toEqual(wordless);
  });
});

describe('mapFinal', () => {
  /** Pieces at meeting 2000 to 2500 and 3000 to 4000: the stream heard them back to back. */
  function timeline(): AudioTimeline {
    const runs = new AudioTimeline(PCM_SAMPLE_RATE);
    runs.append(2_000, 500 * 16);
    runs.append(3_000, 1_000 * 16);
    return runs;
  }

  it('maps a final and its words through the pieces it was heard in, to whole meeting ms', () => {
    const mapped = mapFinal(timeline(), {
      text: 'before after',
      startMs: 100,
      endMs: 900.4,
      confidence: 0.7,
      words: [word('before', 100, 300), word('after', 700, 900.4)],
    });
    expect(mapped).toEqual({
      startMs: 2_100,
      endMs: 3_400,
      text: 'before after',
      confidence: 0.7,
      words: [word('before', 2_100, 2_300), word('after', 3_200, 3_400)],
    });
  });

  it('widens the line over its words, as CaptureSession.lineSpan does for the echo filter', () => {
    const mapped = mapFinal(timeline(), {
      text: 'wide',
      startMs: 700,
      endMs: 800,
      confidence: null,
      words: [word('wide', 650, 950)],
    });
    expect([mapped.startMs, mapped.endMs]).toEqual([3_150, 3_450]);
  });
});
