import { describe, expect, it } from 'vitest';
import {
  ReferenceFileError,
  formatReferenceLine,
  parseReference,
  requireCleanReference,
  speakerText,
} from './reference';

describe('parseReference', () => {
  it('reads "[mm:ss] Me: text" and "[mm:ss] Them: text" lines with their line numbers', () => {
    const parsed = parseReference(
      '[00:05] Me: Morning, everyone.\n[00:09] Them: Hi, the ratio is 3:2 today.\n',
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.lines).toEqual([
      { lineNumber: 1, atMs: 5_000, speaker: 'me', text: 'Morning, everyone.' },
      { lineNumber: 2, atMs: 9_000, speaker: 'them', text: 'Hi, the ratio is 3:2 today.' },
    ]);
  });

  it('takes CRLF line ends, a byte order mark, blank lines, any case and long times', () => {
    const parsed = parseReference(
      '\ufeff[01:02] me: one\r\n\r\n   \r\n[125:59]   THEM :  two  \r\n',
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.lines).toEqual([
      { lineNumber: 1, atMs: 62_000, speaker: 'me', text: 'one' },
      { lineNumber: 4, atMs: 7_559_000, speaker: 'them', text: 'two' },
    ]);
  });

  it('reports each problem with its line number and leaves that line out', () => {
    const parsed = parseReference(
      [
        '[00:01] Me: fine',
        'Me: no time on this line',
        '[00:75] Me: seconds past 59',
        '[00:03] Rahul: a name instead of Me or Them',
        '[00:04] Them: we use {linkt | linked} daily',
        '[00:05] Them:   ',
        '[00:06] Them: also fine',
      ].join('\n'),
    );

    expect(parsed.lines.map((line) => line.lineNumber)).toEqual([1, 7]);
    expect(parsed.problems).toEqual([
      {
        lineNumber: 2,
        kind: 'format',
        message: 'line 2: expected "[mm:ss] Me: text" or "[mm:ss] Them: text"',
      },
      {
        lineNumber: 3,
        kind: 'format',
        message: 'line 3: expected "[mm:ss] Me: text" or "[mm:ss] Them: text"',
      },
      { lineNumber: 4, kind: 'speaker', message: 'line 4: unknown speaker; use Me or Them' },
      {
        lineNumber: 5,
        kind: 'brace',
        message:
          'line 5, column 22: unresolved brace from the draft; keep the right words and remove the braces',
      },
      {
        lineNumber: 6,
        kind: 'empty',
        message: 'line 6: no text after the speaker; delete the line',
      },
    ]);
  });

  it("never puts a line's text in a problem message", () => {
    const parsed = parseReference(
      'secret plans for q4\n[00:01] Secret plans: for q4\n[00:02] Me: secret {plans}',
    );

    expect(parsed.problems).toHaveLength(3);
    for (const problem of parsed.problems) expect(problem.message).not.toMatch(/secret|plans|q4/);
  });

  it('reads an empty file as no lines and no problems (bench check reports empty items)', () => {
    expect(parseReference('')).toEqual({ lines: [], problems: [] });
    expect(parseReference('\n\n')).toEqual({ lines: [], problems: [] });
  });
});

describe('formatReferenceLine', () => {
  it('writes the line format, with the time cut to whole seconds', () => {
    expect(formatReferenceLine({ atMs: 125_999, speaker: 'them', text: 'Sounds good.' })).toBe(
      '[02:05] Them: Sounds good.',
    );
    expect(formatReferenceLine({ atMs: 0, speaker: 'me', text: 'Hi' })).toBe('[00:00] Me: Hi');
    expect(formatReferenceLine({ atMs: 6_000_000, speaker: 'me', text: 'Late' })).toBe(
      '[100:00] Me: Late',
    );
  });

  it('keeps a line on one line, whatever whitespace the vendor text holds', () => {
    expect(formatReferenceLine({ atMs: 1_000, speaker: 'me', text: ' two\nlines\t here ' })).toBe(
      '[00:01] Me: two lines here',
    );
  });

  it('refuses a time that is negative or not a number', () => {
    expect(() => formatReferenceLine({ atMs: -1, speaker: 'me', text: 'x' })).toThrow(RangeError);
    expect(() => formatReferenceLine({ atMs: Number.NaN, speaker: 'me', text: 'x' })).toThrow(
      'reference line time must be a finite number of ms at or after 0, got NaN',
    );
  });

  it('round-trips through the parser', () => {
    const lines = [
      { atMs: 3_000, speaker: 'me' as const, text: 'First line.' },
      { atMs: 61_000, speaker: 'them' as const, text: 'Second: with a colon.' },
    ];
    const parsed = parseReference(lines.map(formatReferenceLine).join('\n'));

    expect(parsed.problems).toEqual([]);
    expect(parsed.lines.map(({ atMs, speaker, text }) => ({ atMs, speaker, text }))).toEqual(lines);
  });
});

describe('speakerText', () => {
  it("joins one speaker's lines in file order", () => {
    const { lines } = parseReference(
      '[00:01] Me: one\n[00:02] Them: two\n[00:03] Me: three\n[00:04] Them: four',
    );

    expect(speakerText(lines, 'me')).toBe('one three');
    expect(speakerText(lines, 'them')).toBe('two four');
    expect(speakerText([], 'me')).toBe('');
  });
});

describe('requireCleanReference', () => {
  it('returns the lines of a clean reference', () => {
    expect(requireCleanReference('[00:01] Me: hi', 'items/a/reference.txt')).toHaveLength(1);
  });

  it('refuses a reference with problems, listing every one under the file label', () => {
    const read = (): unknown =>
      requireCleanReference('[00:01] Me: {a | b}\nnope', 'items/a/reference.txt');

    expect(read).toThrow(ReferenceFileError);
    expect(read).toThrow(
      'items/a/reference.txt: 2 problems\n' +
        '  line 1, column 13: unresolved brace from the draft; keep the right words and remove the braces\n' +
        '  line 2: expected "[mm:ss] Me: text" or "[mm:ss] Them: text"',
    );
  });
});
