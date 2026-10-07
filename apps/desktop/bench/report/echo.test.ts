import { describe, expect, it } from 'vitest';
import { parseReference } from '../core/reference';
import { errorCount, scoreSpeakers } from '../core/wer';
import { type ReplayedFinal, meScoring } from './echo';

/** A final whose words are spread evenly, `msPerWord` each, from `startMs`. */
function final(text: string, startMs: number, msPerWord = 400): ReplayedFinal {
  const words = text.split(' ').map((word, index) => ({
    text: word,
    startMs: startMs + index * msPerWord,
    endMs: startMs + (index + 1) * msPerWord - 40,
    confidence: 0.9,
  }));
  return { text, startMs, endMs: words.at(-1)?.endMs ?? startMs, words };
}

const REFERENCE = parseReference(
  '[00:00] Me: I think we should ship on Friday\n' +
    '[00:05] Them: the build is green and ready to go\n',
).lines;

const MIC = [
  final('I think we should ship on Friday', 0),
  // Them's line, heard again by the mic from the laptop speakers.
  final('the build is green and ready to go', 5_080),
];
const SYSTEM = [final('the build is green and ready to go', 5_000)];

describe('meScoring', () => {
  it("hides Them's words echoed on the mic: Me WER stays at 0, the raw mic shows insertions", () => {
    const me = meScoring({ origin: 'backup', setup: 'speakers' }, MIC, SYSTEM, {
      echoFilter: true,
    });

    expect(me).toEqual({
      kind: 'scored',
      filterApplied: true,
      filtered: ['I think we should ship on Friday'],
      rawMic: ['I think we should ship on Friday', 'the build is green and ready to go'],
    });
    if (me.kind !== 'scored') return;
    const them = SYSTEM.map((line) => line.text);
    const filtered = scoreSpeakers(REFERENCE, { mic: me.filtered, system: them });
    const raw = scoreSpeakers(REFERENCE, { mic: me.rawMic, system: them });
    expect(filtered.me === null ? null : errorCount(filtered.me)).toBe(0);
    expect(raw.me?.insertions).toBe(8);
  });

  it('filters an unknown route, as the app does: it may be the laptop speakers', () => {
    const me = meScoring({ origin: 'backup', setup: 'unknown' }, MIC, SYSTEM, { echoFilter: true });

    expect(me).toMatchObject({ kind: 'scored', filterApplied: true });
  });

  it('keeps a headphones item as the vendor wrote it: the app turns the filter off there', () => {
    const me = meScoring({ origin: 'backup', setup: 'headphones' }, MIC, SYSTEM, {
      echoFilter: true,
    });

    expect(me).toEqual({
      kind: 'scored',
      filterApplied: false,
      filtered: MIC.map((line) => line.text),
      rawMic: MIC.map((line) => line.text),
    });
  });

  it('trims a mic line that only partly repeats Them', () => {
    const mixed = [final('yes I agree that the build is green and ready to go now', 3_480)];

    const me = meScoring({ origin: 'backup', setup: 'speakers' }, mixed, SYSTEM, {
      echoFilter: true,
    });

    expect(me).toMatchObject({ kind: 'scored', filtered: ['yes I agree that now'] });
  });

  it('leaves a meet recording out of Me: it has no mic stream', () => {
    expect(
      meScoring({ origin: 'meet-recording', setup: 'unknown' }, null, SYSTEM, { echoFilter: true }),
    ).toEqual({ kind: 'no-mic', reason: 'a meet recording has only the system stream' });
  });

  it('without the filter, leaves a speakers item out of Me and the pooled number, and says why', () => {
    const me = meScoring({ origin: 'backup', setup: 'speakers' }, MIC, SYSTEM, {
      echoFilter: false,
    });

    expect(me).toEqual({
      kind: 'needs-filter',
      rawMic: MIC.map((line) => line.text),
      reason:
        'speakers: Me needs the echo filter, which this score ran without (--no-echo-filter); ' +
        'left out of Me and the pooled WER',
    });
  });

  it('without the filter, still scores a headphones item in full', () => {
    expect(
      meScoring({ origin: 'backup', setup: 'headphones' }, MIC, SYSTEM, { echoFilter: false }),
    ).toMatchObject({ kind: 'scored', filterApplied: false });
  });
});
