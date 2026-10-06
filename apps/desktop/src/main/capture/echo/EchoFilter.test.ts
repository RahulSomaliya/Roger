import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ECHO_MATCH_WINDOW_MS,
  type EchoLine,
  type EchoOutputRoute,
  filterEcho,
  isEchoFilterOn,
} from './EchoFilter';

type TimedWord = [text: string, startMs: number, endMs: number];

/** A line with word timings; its span runs from the first word's start to the last word's end. */
function line(id: string, words: TimedWord[]): EchoLine {
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) throw new Error('a test line needs at least one word');
  return {
    id,
    startMs: first[1],
    endMs: last[2],
    text: words.map(([text]) => text).join(' '),
    words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs, confidence: 0.9 })),
  };
}

/** Words of `text` spaced 300 ms apart from `startMs`, each 250 ms long. */
function spoken(text: string, startMs: number): TimedWord[] {
  return text.split(' ').map((word, index): TimedWord => {
    const wordStart = startMs + index * 300;
    return [word, wordStart, wordStart + 250];
  });
}

const speakers: EchoOutputRoute = 'speakers';

describe('isEchoFilterOn', () => {
  it('is off only for known headphones', () => {
    expect(isEchoFilterOn('headphones')).toBe(false);
    expect(isEchoFilterOn('speakers')).toBe(true);
    // An unknown route might be the laptop speakers, which leak call audio into the mic.
    expect(isEchoFilterOn('unknown')).toBe(true);
  });
});

describe('filterEcho', () => {
  it('hides a mic line that repeats call audio within 700 ms', () => {
    const them = line('them-1', spoken('so the plan is to ship on Friday', 10_000));
    const me = line('me-1', spoken('so the plan is to ship on Friday', 10_120));

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
  });

  it('matches words whatever their case, punctuation, quotes or apostrophe style', () => {
    // Two-word lines hide only when every word matches, so each spelling below is decisive.
    const them = line('them-1', [
      ["Don't,", 4_000, 4_300],
      ["'Friday'?", 4_350, 4_800],
    ]);
    const me = line('me-1', [
      ['don’t', 4_050, 4_350],
      ['friday', 4_400, 4_850],
    ]);

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
  });

  it('keeps a mic line with different words at the same moment', () => {
    const them = line('them-1', spoken('so the plan is to ship on Friday', 10_000));
    const me = line('me-1', spoken('can we move the review to Monday', 10_000));

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('matches a call-audio word up to 700 ms before or after the mic word, and not beyond', () => {
    const them = line('them-1', spoken('we should ship it today', 20_000));
    const earlier = line('me-1', spoken('we should ship it today', 20_000 - ECHO_MATCH_WINDOW_MS));
    const later = line('me-2', spoken('we should ship it today', 20_000 + ECHO_MATCH_WINDOW_MS));
    const tooLate = line(
      'me-3',
      spoken('we should ship it today', 20_000 + ECHO_MATCH_WINDOW_MS + 1),
    );

    expect(ECHO_MATCH_WINDOW_MS).toBe(700);
    expect(filterEcho(earlier, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
    expect(filterEcho(later, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
    // The user saying the same words back a moment later is their own speech.
    expect(filterEcho(tooLate, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('hides a line when at least 70% of its words match, and keeps it below that', () => {
    const them = line('them-1', spoken('one two three four five six seven', 0));
    const sevenOfTen = line(
      'me-1',
      spoken('one two three four five six seven eight nine ten', 30).map(
        ([text, start, end], index): TimedWord => [index < 7 ? text : `x${text}`, start, end],
      ),
    );
    const twoOfThree = line('me-2', spoken('one two zebra', 30));

    expect(filterEcho(sevenOfTen, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
    // Two of three is 67%, and no run reaches three words, so the line stays whole.
    expect(filterEcho(twoOfThree, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('trims only the runs of 3 or more matched words from a mixed line and keeps the original', () => {
    const them = line('them-1', spoken('so the plan is to ship on Friday', 10_900));
    const me = line('me-1', [
      ['Yeah,', 10_000, 10_200],
      ['I', 10_300, 10_400],
      ['think', 10_500, 10_800],
      ...spoken('so the plan is to ship on Friday', 10_950),
      ['we', 13_400, 13_500],
      ['can,', 13_600, 13_800],
      ['probably', 13_900, 14_300],
      ['yes', 14_400, 14_600],
    ]);

    const decision = filterEcho(me, [them], speakers);

    expect(decision).toEqual({
      action: 'trim',
      echoOf: 'them-1',
      text: 'Yeah, I think we can, probably yes',
      originalText: me.text,
      words: [
        { text: 'Yeah,', startMs: 10_000, endMs: 10_200, confidence: 0.9 },
        { text: 'I', startMs: 10_300, endMs: 10_400, confidence: 0.9 },
        { text: 'think', startMs: 10_500, endMs: 10_800, confidence: 0.9 },
        { text: 'we', startMs: 13_400, endMs: 13_500, confidence: 0.9 },
        { text: 'can,', startMs: 13_600, endMs: 13_800, confidence: 0.9 },
        { text: 'probably', startMs: 13_900, endMs: 14_300, confidence: 0.9 },
        { text: 'yes', startMs: 14_400, endMs: 14_600, confidence: 0.9 },
      ],
    });
  });

  it('keeps matched words that do not form a run of 3', () => {
    const them = line('them-1', spoken('the deck is ready and the demo works', 5_000));
    // "the deck" and "the demo" match, but each run is two words: they could be the user's own.
    const me = line('me-1', [
      ['the', 5_000, 5_250],
      ['deck', 5_300, 5_550],
      ['looked', 5_600, 5_850],
      ['great', 5_900, 6_150],
      ['honestly', 6_200, 6_400],
      ['the', 6_500, 6_750],
      ['demo', 6_800, 7_050],
      ['too', 7_100, 7_300],
    ]);

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('hides a line whose every word sits in a matched run instead of trimming it to nothing', () => {
    const first = line('them-1', spoken('we ship', 0));
    const second = line('them-2', spoken('on Friday morning', 600));
    const me = line('me-1', spoken('we ship on Friday morning', 40));

    expect(filterEcho(me, [first, second], speakers)).toEqual({ action: 'hide', echoOf: 'them-2' });
  });

  it('hides a 1 or 2 word line only when every word matches and the times overlap by half', () => {
    const them = line('them-1', [
      ['Yes,', 30_000, 30_300],
      ['exactly.', 30_350, 30_800],
    ]);
    const echo = line('me-1', [
      ['yes', 30_050, 30_300],
      ['exactly', 30_400, 30_850],
    ]);
    // Said back 500 ms later: within the 700 ms window, but the spans barely overlap.
    const reply = line('me-2', [
      ['Yes,', 30_500, 30_800],
      ['exactly.', 30_850, 31_300],
    ]);
    const halfMatched = line('me-3', [
      ['yes', 30_050, 30_300],
      ['absolutely', 30_400, 30_850],
    ]);

    expect(filterEcho(echo, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
    expect(filterEcho(reply, [them], speakers)).toEqual({ action: 'keep' });
    expect(filterEcho(halfMatched, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('measures the overlap of a one-word line against its twin', () => {
    const them = line('them-1', [['okay', 8_000, 8_400]]);
    const overlapping = line('me-1', [['okay', 8_150, 8_550]]);
    const shifted = line('me-2', [['okay', 8_250, 8_650]]);

    // 250 of 400 ms overlap (62%) hides; 150 of 400 ms (37%) keeps.
    expect(filterEcho(overlapping, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
    expect(filterEcho(shifted, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('lets each call-audio word match one mic word only', () => {
    const them = line('them-1', spoken('no', 2_000));
    const me = line('me-1', spoken('no no no', 2_000));

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'keep' });
  });

  it('names the call-audio line that supplied the most matched words', () => {
    const before = line('them-1', spoken('okay', 9_700));
    const main = line('them-2', spoken('the numbers look good this quarter', 10_000));
    const me = line('me-1', spoken('okay the numbers look good this quarter', 9_720));

    expect(filterEcho(me, [before, main], speakers)).toEqual({ action: 'hide', echoOf: 'them-2' });
  });

  it('names the first call-audio line passed when two supplied as many words', () => {
    const first = line('them-1', spoken('we ship', 0));
    const second = line('them-2', spoken('on time', 600));
    const me = line('me-1', spoken('we ship on time', 40));

    expect(filterEcho(me, [first, second], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
  });

  it('ignores call-audio lines far from the mic line', () => {
    const earlier = line('them-1', spoken('so the plan is to ship on Friday', 0));
    const me = line('me-1', spoken('so the plan is to ship on Friday', 60_000));

    expect(filterEcho(me, [earlier], speakers)).toEqual({ action: 'keep' });
  });

  it('spreads the text of a line without word timings over its span', () => {
    const them: EchoLine = {
      id: 'them-1',
      startMs: 3_000,
      endMs: 5_400,
      text: 'the build is green again now',
      words: null,
    };
    const me: EchoLine = { ...them, id: 'me-1', startMs: 3_100, endMs: 5_500, words: [] };

    expect(filterEcho(me, [them], speakers)).toEqual({ action: 'hide', echoOf: 'them-1' });
  });

  it('trims a line without word timings by its text and invents no timings', () => {
    const them = line('them-1', spoken('the build is green again', 3_000));
    const me: EchoLine = {
      id: 'me-1',
      startMs: 2_700,
      endMs: 5_100,
      text: 'nice the build is green again cool thanks',
      words: null,
    };

    expect(filterEcho(me, [them], speakers)).toEqual({
      action: 'trim',
      echoOf: 'them-1',
      text: 'nice cool thanks',
      originalText: me.text,
      words: null,
    });
  });

  it('keeps every line when the output is headphones', () => {
    const them = line('them-1', spoken('so the plan is to ship on Friday', 10_000));
    const me = line('me-1', spoken('so the plan is to ship on Friday', 10_000));

    expect(filterEcho(me, [them], 'headphones')).toEqual({ action: 'keep' });
    expect(filterEcho(me, [them], 'unknown')).toEqual({ action: 'hide', echoOf: 'them-1' });
  });

  it('keeps a mic line with nothing to compare', () => {
    const me = line('me-1', spoken('hello there', 1_000));
    const punctuation: EchoLine = { id: 'me-2', startMs: 0, endMs: 100, text: '...', words: null };

    expect(filterEcho(me, [], speakers)).toEqual({ action: 'keep' });
    expect(filterEcho(punctuation, [line('them-1', spoken('...', 0))], speakers)).toEqual({
      action: 'keep',
    });
  });

  it('imports nothing that needs Electron, so the benchmark can load it in plain Node', () => {
    // M3-T11's bench runs this filter outside Electron. An import of `electron`, or of a main
    // module that pulls it in (the logger, the store), breaks the bench, not the app.
    const source = readFileSync(new URL('./EchoFilter.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['../../../shared/transcript']);
  });
});
