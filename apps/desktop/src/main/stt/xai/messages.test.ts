import { describe, expect, it } from 'vitest';
import {
  parseXaiMessage,
  XAI_AUDIO_DONE,
  XAI_FINALIZE,
  XaiLineAssembler,
  type XaiPartial,
} from './messages';

function partial(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'transcript.partial',
    text: 'hello there',
    words: [
      { text: 'hello', start: 0.1, end: 0.4 },
      { text: 'there', start: 0.5, end: 0.9 },
    ],
    is_final: false,
    speech_final: false,
    start: 0.1,
    duration: 0.8,
    ...extra,
  });
}

function parsedPartial(extra: Record<string, unknown> = {}): XaiPartial {
  const parsed = parseXaiMessage(partial(extra));
  if (parsed.kind !== 'partial') throw new Error(`expected a partial, got ${parsed.kind}`);
  return parsed.partial;
}

describe('parseXaiMessage', () => {
  it('reads transcript.created as the ready signal', () => {
    expect(parseXaiMessage('{"type":"transcript.created"}')).toEqual({ kind: 'created' });
  });

  it('reads a partial: text, finality and millisecond timings from seconds', () => {
    expect(parseXaiMessage(partial({ is_final: true, speech_final: true }))).toEqual({
      kind: 'partial',
      partial: {
        text: 'hello there',
        isFinal: true,
        speechFinal: true,
        startMs: 100,
        endMs: 900,
        words: [
          { text: 'hello', startMs: 100, endMs: 400, confidence: null },
          { text: 'there', startMs: 500, endMs: 900, confidence: null },
        ],
      },
    });
  });

  it('rounds fractional milliseconds', () => {
    const read = parsedPartial({ start: 0.0004, duration: 1.2346, words: [] });
    expect(read.startMs).toBe(0);
    expect(read.endMs).toBe(1235);
  });

  it('reads a partial with no words as having none, and one without text as empty', () => {
    // JSON.stringify drops an undefined field, so the message has no `words` at all.
    expect(parsedPartial({ words: undefined }).words).toEqual([]);
    expect(parsedPartial({ text: '' }).text).toBe('');
  });

  it('keeps the line and drops the timings of a malformed word list, with a warning', () => {
    const parsed = parseXaiMessage(partial({ words: [{ text: 'hello', start: 'x', end: 1 }] }));
    expect(parsed).toMatchObject({
      kind: 'partial',
      partial: { text: 'hello there', words: [] },
      warning: 'word timings dropped: malformed word list',
    });
  });

  it('reads transcript.done as the end of the stream, whatever text it repeats', () => {
    expect(
      parseXaiMessage('{"type":"transcript.done","text":"the whole call","duration":3.45}'),
    ).toEqual({ kind: 'done' });
  });

  it('reads an error with its message', () => {
    expect(parseXaiMessage('{"type":"error","message":"invalid api key"}')).toEqual({
      kind: 'error',
      message: 'invalid api key',
    });
    expect(parseXaiMessage('{"type":"error"}')).toEqual({ kind: 'error', message: 'xAI error' });
  });

  it('ignores a message type it does not know', () => {
    expect(parseXaiMessage('{"type":"transcript.speaker_changed"}')).toEqual({
      kind: 'ignored',
      messageType: 'transcript.speaker_changed',
    });
  });

  it.each([
    ['not JSON', 'nope', 'not JSON'],
    ['an array', '[]', 'missing type'],
    ['no type', '{"text":"x"}', 'missing type'],
    [
      'a partial with no text',
      '{"type":"transcript.partial","start":0,"duration":1}',
      'partial without text',
    ],
    [
      'a partial with no timing',
      '{"type":"transcript.partial","text":"x","is_final":false}',
      'partial without timing',
    ],
  ])('never throws on %s', (_name, raw, reason) => {
    expect(parseXaiMessage(raw)).toEqual({ kind: 'invalid', reason });
  });

  it('treats a missing or non-boolean finality flag as not final', () => {
    const read = parsedPartial({ is_final: 'true', speech_final: undefined });
    expect(read.isFinal).toBe(false);
    expect(read.speechFinal).toBe(false);
  });
});

describe('the client messages', () => {
  it('spells Finalize with a capital F, as xAI documents it, and audio.done in lower case', () => {
    expect(XAI_FINALIZE).toBe('{"type":"Finalize"}');
    expect(XAI_AUDIO_DONE).toBe('{"type":"audio.done"}');
  });
});

function piece(
  text: string,
  flags: { isFinal: boolean; speechFinal?: boolean },
  startMs: number,
  endMs: number,
): XaiPartial {
  return {
    text,
    isFinal: flags.isFinal,
    speechFinal: flags.speechFinal ?? false,
    startMs,
    endMs,
    words: text === '' ? [] : [{ text, startMs, endMs, confidence: null }],
  };
}

describe('XaiLineAssembler', () => {
  it('shows an interim, and an utterance-final partial as the one final line', () => {
    const lines = new XaiLineAssembler();

    expect(lines.accept(piece('hello', { isFinal: false }, 100, 400))).toEqual([
      { type: 'interim', text: 'hello', startMs: 100, endMs: 400 },
    ]);
    expect(
      lines.accept(piece('hello there.', { isFinal: true, speechFinal: true }, 100, 900)),
    ).toEqual([
      {
        type: 'final',
        text: 'hello there.',
        startMs: 100,
        endMs: 900,
        confidence: null,
        words: [{ text: 'hello there.', startMs: 100, endMs: 900, confidence: null }],
      },
    ]);
    expect(lines.flush()).toBeNull();
  });

  it('keeps a locked chunk on screen, in front of the next interim, until the utterance ends', () => {
    const lines = new XaiLineAssembler();

    // A chunk final is not a line yet: xAI repeats it inside the stitched utterance at the end.
    expect(lines.accept(piece('first part', { isFinal: true }, 0, 3000))).toEqual([
      { type: 'interim', text: 'first part', startMs: 0, endMs: 3000 },
    ]);
    expect(lines.accept(piece('and more', { isFinal: false }, 3000, 3500))).toEqual([
      { type: 'interim', text: 'first part and more', startMs: 0, endMs: 3500 },
    ]);
    const [final] = lines.accept(
      piece('first part and more.', { isFinal: true, speechFinal: true }, 0, 3600),
    );
    expect(final).toMatchObject({ type: 'final', text: 'first part and more.', startMs: 0 });
    // The locked chunk is gone with the line: the next utterance starts clean.
    expect(lines.accept(piece('next', { isFinal: false }, 4000, 4200))).toEqual([
      { type: 'interim', text: 'next', startMs: 4000, endMs: 4200 },
    ]);
  });

  it('turns locked chunks into the line when the utterance-final partial has no text', () => {
    const lines = new XaiLineAssembler();
    lines.accept(piece('only chunk', { isFinal: true }, 0, 3000));

    const events = lines.accept(piece('', { isFinal: true, speechFinal: true }, 3000, 3000));

    expect(events).toMatchObject([{ type: 'final', text: 'only chunk', startMs: 0, endMs: 3000 }]);
    expect(lines.flush()).toBeNull();
  });

  it('says nothing for an empty partial with nothing held', () => {
    const lines = new XaiLineAssembler();
    expect(lines.accept(piece('', { isFinal: false }, 0, 0))).toEqual([]);
    expect(lines.accept(piece('', { isFinal: true, speechFinal: true }, 0, 0))).toEqual([]);
  });

  it('flush gives locked chunks and the pending interim as one last line, once', () => {
    const lines = new XaiLineAssembler();
    lines.accept(piece('locked', { isFinal: true }, 0, 3000));
    lines.accept(piece('and the tail', { isFinal: false }, 3000, 3600));

    expect(lines.flush()).toEqual({
      type: 'final',
      text: 'locked and the tail',
      startMs: 0,
      endMs: 3600,
      confidence: null,
      words: [
        { text: 'locked', startMs: 0, endMs: 3000, confidence: null },
        { text: 'and the tail', startMs: 3000, endMs: 3600, confidence: null },
      ],
    });
    expect(lines.flush()).toBeNull();
  });

  it('flush gives an interim that never finalized, so Stop cannot lose it', () => {
    const lines = new XaiLineAssembler();
    lines.accept(piece('almost done', { isFinal: false }, 100, 800));

    expect(lines.flush()).toMatchObject({ type: 'final', text: 'almost done', startMs: 100 });
  });

  it('forgets a pending interim once its utterance finalized', () => {
    const lines = new XaiLineAssembler();
    lines.accept(piece('hi', { isFinal: false }, 0, 200));
    lines.accept(piece('hi.', { isFinal: true, speechFinal: true }, 0, 250));

    expect(lines.flush()).toBeNull();
  });
});
