import { describe, expect, it } from 'vitest';
import {
  parseSonioxMessage,
  SONIOX_END_OF_AUDIO,
  SONIOX_FINALIZE,
  SONIOX_KEEP_ALIVE,
  SonioxLineAssembler,
  type SonioxToken,
} from './messages';

/** One token as Soniox sends it; `start_ms` and friends overridable, or removed with undefined. */
function wireToken(
  text: string,
  isFinal: boolean,
  startMs: number,
  endMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { text, start_ms: startMs, end_ms: endMs, confidence: 0.9, is_final: isFinal, ...extra };
}

function response(tokens: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tokens, final_audio_proc_ms: 0, total_audio_proc_ms: 0, ...extra });
}

function token(
  text: string,
  isFinal: boolean,
  startMs = 0,
  endMs = 0,
  confidence: number | null = 0.9,
): SonioxToken {
  return { text, isFinal, startMs, endMs, confidence };
}

describe('parseSonioxMessage', () => {
  it('reads every token in order, with millisecond offsets, confidence and finality', () => {
    const raw = response([
      wireToken('How', true, 600, 760, { confidence: 0.97, speaker: '1' }),
      wireToken(' are', false, 800, 950.4, { confidence: 0.5 }),
    ]);

    expect(parseSonioxMessage(raw, 0)).toEqual({
      kind: 'tokens',
      finished: false,
      tokens: [
        { text: 'How', isFinal: true, startMs: 600, endMs: 760, confidence: 0.97 },
        { text: ' are', isFinal: false, startMs: 800, endMs: 950, confidence: 0.5 },
      ],
    });
  });

  it('reads the finished response as the end of the stream', () => {
    const raw = response([], {
      final_audio_proc_ms: 1560,
      total_audio_proc_ms: 1680,
      finished: true,
    });

    expect(parseSonioxMessage(raw, 0)).toEqual({ kind: 'tokens', finished: true, tokens: [] });
  });

  it('reads an error response as the vendor error it is, its code and type named', () => {
    const raw = JSON.stringify({
      tokens: [],
      error_code: 403,
      error_type: 'temp_api_key_session_expired',
      error_message:
        'Temporary API key session duration limit exceeded. Create a new temporary API key to ' +
        'start a new session.',
      more_info: 'https://soniox.com/docs/api-reference/errors#temp-api-key-session-expired',
      request_id: '3d37a3bd-5078-47ee-a369-b204e3bbedda',
    });

    expect(parseSonioxMessage(raw, 0)).toEqual({
      kind: 'error',
      message:
        'Temporary API key session duration limit exceeded. Create a new temporary API key to ' +
        'start a new session. (Soniox error 403 temp_api_key_session_expired)',
    });
  });

  it('reads a response whose error fields are null as no error', () => {
    const raw = response([wireToken('hi', true, 0, 100)], { error_code: null, error_type: null });

    expect(parseSonioxMessage(raw, 0)).toMatchObject({ kind: 'tokens', finished: false });
  });

  it('reads an error response with no message or type by what it has', () => {
    expect(parseSonioxMessage(JSON.stringify({ error_code: 503 }), 0)).toEqual({
      kind: 'error',
      message: 'Soniox error (Soniox error 503)',
    });
    expect(parseSonioxMessage(JSON.stringify({ error_type: 'internal_error' }), 0)).toEqual({
      kind: 'error',
      message: 'Soniox error (Soniox error internal_error)',
    });
  });

  it('keeps a token with no timing, placed at the end of the audio sent, and says so', () => {
    const raw = response([
      wireToken('Linkt', true, 100, 300),
      wireToken('later', true, 0, 0, { start_ms: undefined, end_ms: 'soon' }),
    ]);

    expect(parseSonioxMessage(raw, 4_250.6)).toEqual({
      kind: 'tokens',
      finished: false,
      tokens: [
        { text: 'Linkt', isFinal: true, startMs: 100, endMs: 300, confidence: 0.9 },
        { text: 'later', isFinal: true, startMs: 4_251, endMs: 4_251, confidence: 0.9 },
      ],
      warning: 'token without timing: placed at the end of the audio sent',
    });
  });

  it('reads a confidence that is not a number as unknown', () => {
    const raw = response([wireToken('hi', true, 0, 100, { confidence: 'high' })]);
    const parsed = parseSonioxMessage(raw, 0);

    expect(parsed.kind === 'tokens' && parsed.tokens[0]?.confidence).toBeNull();
  });

  it.each([
    ['not JSON', 'not json', 'not JSON'],
    ['a JSON array', '[]', 'not an object'],
    ['no tokens', JSON.stringify({ final_audio_proc_ms: 0 }), 'no tokens'],
    ['tokens that are not a list', JSON.stringify({ tokens: 'x' }), 'no tokens'],
    ['a token without text', response([{ is_final: true }]), 'malformed token'],
    ['a token without is_final', response([{ text: 'hi' }]), 'malformed token'],
    ['a token that is not an object', JSON.stringify({ tokens: ['hi'] }), 'malformed token'],
    [
      'a finished flag that is not a boolean',
      response([], { finished: 'yes' }),
      'malformed finished',
    ],
  ])('reads %s as invalid, never a throw', (_name, raw, reason) => {
    expect(parseSonioxMessage(raw, 0)).toEqual({ kind: 'invalid', reason });
  });
});

describe('SonioxLineAssembler', () => {
  it('holds final tokens until the endpoint, then makes them one line of whole words', () => {
    const lines = new SonioxLineAssembler();

    expect(
      lines.accept([token('How', true, 600, 760, 0.9), token(' ', true, 760, 800, 1)]),
    ).toEqual([{ type: 'interim', text: 'How', startMs: 600, endMs: 760 }]);
    const events = lines.accept([
      token('are', true, 800, 950, 0.8),
      token(' you', true, 960, 1_100, 0.7),
      token(' do', true, 1_200, 1_300, 0.6),
      token('ing', true, 1_300, 1_400, 0.4),
      token('?', true, 1_400, 1_420, 1),
      token('<end>', true, 1_420, 1_420, 1),
    ]);

    // A word's confidence is its tokens' mean; the line's is its words' mean, as for AssemblyAI.
    const doing = (0.6 + 0.4 + 1) / 3;
    expect(events).toEqual([
      {
        type: 'final',
        text: 'How are you doing?',
        startMs: 600,
        endMs: 1_420,
        confidence: (0.9 + 0.8 + 0.7 + doing) / 4,
        words: [
          { text: 'How', startMs: 600, endMs: 760, confidence: 0.9 },
          { text: 'are', startMs: 800, endMs: 950, confidence: 0.8 },
          { text: 'you', startMs: 960, endMs: 1_100, confidence: 0.7 },
          { text: 'doing?', startMs: 1_200, endMs: 1_420, confidence: doing },
        ],
      },
    ]);
    // Said once: the line is not held any more.
    expect(lines.flush()).toBeNull();
  });

  it('shows the line in progress as one interim: held finals, then the latest guesses', () => {
    const lines = new SonioxLineAssembler();

    expect(lines.accept([token('Hello', true, 0, 300), token(' wor', false, 350, 500)])).toEqual([
      { type: 'interim', text: 'Hello wor', startMs: 0, endMs: 500 },
    ]);
    // Non-final tokens are replaced on every response, never added up.
    expect(lines.accept([token(' world', false, 350, 700)])).toEqual([
      { type: 'interim', text: 'Hello world', startMs: 0, endMs: 700 },
    ]);
    expect(lines.accept([token(' there', false, 350, 650)])).toEqual([
      { type: 'interim', text: 'Hello there', startMs: 0, endMs: 650 },
    ]);
  });

  it('says the line in progress again only when it changed', () => {
    const lines = new SonioxLineAssembler();
    const guess = [token('Hello', true, 0, 300), token(' wor', false, 350, 500)];

    expect(lines.accept(guess)).toHaveLength(1);
    // Soniox answers as it processes audio: the same guess again, or nothing new at all.
    expect(lines.accept([token(' wor', false, 350, 500)])).toEqual([]);
    expect(lines.accept([])).toEqual([{ type: 'interim', text: 'Hello', startMs: 0, endMs: 300 }]);
    expect(lines.accept([])).toEqual([]);
  });

  it('ends a line at the finalize marker too', () => {
    const lines = new SonioxLineAssembler();

    const events = lines.accept([token('Stop', true, 0, 200), token('<fin>', true, 200, 200)]);

    expect(events.map((event) => event.type)).toEqual(['final']);
    expect(events[0]).toMatchObject({ text: 'Stop', startMs: 0, endMs: 200 });
  });

  it('starts the next line with the tokens after the marker in the same response', () => {
    const lines = new SonioxLineAssembler();

    const events = lines.accept([
      token('One', true, 0, 200),
      token('<end>', true, 200, 200),
      token('Two', true, 900, 1_100),
      token(' th', false, 1_150, 1_250),
    ]);

    expect(events.map((event) => event.type)).toEqual(['final', 'interim']);
    expect(events[0]).toMatchObject({ text: 'One', startMs: 0, endMs: 200 });
    expect(events[1]).toEqual({ type: 'interim', text: 'Two th', startMs: 900, endMs: 1_250 });
    expect(lines.flush()).toMatchObject({ type: 'final', text: 'Two', startMs: 900, endMs: 1_100 });
  });

  it('says nothing for a response with no words: no blank interim, no empty line', () => {
    const lines = new SonioxLineAssembler();

    expect(lines.accept([])).toEqual([]);
    expect(lines.accept([token(' ', true, 0, 10), token(' ', false, 10, 20)])).toEqual([]);
    expect(lines.accept([token('<end>', true, 20, 20), token('<end>', true, 30, 30)])).toEqual([]);
    expect(lines.flush()).toBeNull();
  });

  it('never shows a marker as text, final or not', () => {
    const lines = new SonioxLineAssembler();

    expect(lines.accept([token('Hi', true, 0, 100), token('<end>', false, 100, 100)])).toEqual([
      { type: 'interim', text: 'Hi', startMs: 0, endMs: 100 },
    ]);
  });

  it('releases the held finals as the last line and drops the guesses', () => {
    const lines = new SonioxLineAssembler();
    lines.accept([
      token('Last', true, 0, 200),
      token(' words', true, 250, 500),
      token(' mayb', false, 520, 600),
    ]);

    expect(lines.flush()).toEqual({
      type: 'final',
      text: 'Last words',
      startMs: 0,
      endMs: 500,
      confidence: 0.9,
      words: [
        { text: 'Last', startMs: 0, endMs: 200, confidence: 0.9 },
        { text: 'words', startMs: 250, endMs: 500, confidence: 0.9 },
      ],
    });
    expect(lines.flush()).toBeNull();
  });

  it('ends a word at a token that ends in a space as well as before one that starts with one', () => {
    const lines = new SonioxLineAssembler();
    lines.accept([token('ok ', true, 0, 100), token('then', true, 100, 300)]);

    expect(lines.flush()?.words.map((word) => word.text)).toEqual(['ok', 'then']);
  });

  it('gives a word, and its line, no confidence when a token has none', () => {
    const lines = new SonioxLineAssembler();
    lines.accept([token('Lin', true, 0, 100, null), token('kt', true, 100, 200, 0.9)]);

    const line = lines.flush();
    expect(line?.words).toEqual([{ text: 'Linkt', startMs: 0, endMs: 200, confidence: null }]);
    expect(line?.confidence).toBeNull();
  });
});

describe('control messages', () => {
  it('are what Soniox documents', () => {
    expect(SONIOX_FINALIZE).toBe('{"type":"finalize"}');
    expect(SONIOX_KEEP_ALIVE).toBe('{"type":"keepalive"}');
    // An empty text frame ends the stream; an empty binary frame is only an empty audio chunk.
    expect(SONIOX_END_OF_AUDIO).toBe('');
  });
});
