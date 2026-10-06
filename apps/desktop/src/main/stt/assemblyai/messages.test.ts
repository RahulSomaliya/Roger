import { describe, expect, it } from 'vitest';
import { parseAssemblyAiMessage } from './messages';

/** Shapes follow https://www.assemblyai.com/docs/streaming/message-sequence (read 2026-10-06). */
const words = [
  { start: 1216, end: 1635, text: 'my', confidence: 0.5, word_is_final: true },
  { start: 1676, end: 2515, text: 'name', confidence: 0.75, word_is_final: true },
  { start: 2556, end: 2975, text: 'is', confidence: 1, word_is_final: true },
  { start: 3016, end: 4155, text: 'sonny', confidence: 0.75, word_is_final: true },
];

const turn = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    type: 'Turn',
    turn_order: 0,
    turn_is_formatted: false,
    end_of_turn: false,
    transcript: 'my name is',
    end_of_turn_confidence: 0.2,
    words: words.slice(0, 3).map((word) => ({ ...word, word_is_final: false })),
    utterance: '',
    ...overrides,
  });

/** The audio Roger has sent so far, used only when a turn carries no word timings. */
const AUDIO_SENT_MS = 9_000;

describe('parseAssemblyAiMessage', () => {
  it('reads Begin', () => {
    expect(
      parseAssemblyAiMessage(
        JSON.stringify({ type: 'Begin', id: 'session-1', expires_at: 1772570132 }),
        AUDIO_SENT_MS,
      ),
    ).toEqual({ kind: 'begin', sessionId: 'session-1' });
  });

  it('turns a partial Turn into an interim event spanning its words', () => {
    expect(parseAssemblyAiMessage(turn({}), AUDIO_SENT_MS)).toEqual({
      kind: 'turn',
      turnOrder: 0,
      formatted: false,
      event: { type: 'interim', text: 'my name is', startMs: 1216, endMs: 2975 },
    });
  });

  it('shows a partial turn from its words while no word is final yet', () => {
    // In partials `transcript` holds only finalized words; the words list runs ahead of it.
    expect(parseAssemblyAiMessage(turn({ transcript: '' }), AUDIO_SENT_MS)).toMatchObject({
      kind: 'turn',
      event: { type: 'interim', text: 'my name is' },
    });
  });

  it('turns an unformatted end of turn into a final event with word timings', () => {
    const parsed = parseAssemblyAiMessage(
      turn({ end_of_turn: true, transcript: 'my name is sonny', words, utterance: '' }),
      AUDIO_SENT_MS,
    );
    expect(parsed).toEqual({
      kind: 'turn',
      turnOrder: 0,
      formatted: false,
      event: {
        type: 'final',
        text: 'my name is sonny',
        startMs: 1216,
        endMs: 4155,
        confidence: 0.75,
        words: [
          { text: 'my', startMs: 1216, endMs: 1635, confidence: 0.5 },
          { text: 'name', startMs: 1676, endMs: 2515, confidence: 0.75 },
          { text: 'is', startMs: 2556, endMs: 2975, confidence: 1 },
          { text: 'sonny', startMs: 3016, endMs: 4155, confidence: 0.75 },
        ],
      },
    });
  });

  it('marks the formatted copy of an end of turn as formatted', () => {
    const formattedWords = words.map((word, index) =>
      index === 3 ? { ...word, text: 'Sonny.' } : word,
    );
    const parsed = parseAssemblyAiMessage(
      turn({
        turn_order: 4,
        end_of_turn: true,
        turn_is_formatted: true,
        transcript: 'My name is Sonny.',
        words: formattedWords,
        utterance: 'My name is Sonny.',
      }),
      AUDIO_SENT_MS,
    );
    expect(parsed).toMatchObject({
      kind: 'turn',
      turnOrder: 4,
      formatted: true,
      event: { type: 'final', text: 'My name is Sonny.', startMs: 1216, endMs: 4155 },
    });
  });

  it('gives a null confidence when any word lacks one', () => {
    const parsed = parseAssemblyAiMessage(
      turn({ end_of_turn: true, words: [{ start: 1, end: 2, text: 'hi' }] }),
      AUDIO_SENT_MS,
    );
    expect(parsed).toMatchObject({
      kind: 'turn',
      event: { type: 'final', confidence: null, words: [{ confidence: null }] },
    });
  });

  it('keeps a final line with no words, placed at the audio sent so far, and says so', () => {
    expect(parseAssemblyAiMessage(turn({ end_of_turn: true, words: [] }), AUDIO_SENT_MS)).toEqual({
      kind: 'turn',
      turnOrder: 0,
      formatted: false,
      event: {
        type: 'final',
        text: 'my name is',
        startMs: AUDIO_SENT_MS,
        endMs: AUDIO_SENT_MS,
        confidence: null,
        words: [],
      },
      warning: 'no word timings: line placed at the end of the audio sent',
    });
  });

  it('keeps the line but drops the word timings when the word list is malformed, and says so', () => {
    for (const malformed of [[{ text: 1, start: 0, end: 1 }], [null], 'nope', [{ text: 'a' }]]) {
      const parsed = parseAssemblyAiMessage(
        turn({ end_of_turn: true, words: malformed }),
        AUDIO_SENT_MS,
      );
      expect(parsed, JSON.stringify(malformed)).toMatchObject({
        kind: 'turn',
        event: { type: 'final', text: 'my name is', startMs: AUDIO_SENT_MS, words: [] },
        warning: 'word timings dropped: malformed word list',
      });
    }
  });

  it('ignores turns with no text rather than storing blank lines', () => {
    expect(
      parseAssemblyAiMessage(turn({ end_of_turn: true, transcript: '  ', words: [] }), 0),
    ).toEqual({ kind: 'ignored', messageType: 'Turn(empty)' });
    expect(parseAssemblyAiMessage(turn({ transcript: '', words: [] }), 0)).toEqual({
      kind: 'ignored',
      messageType: 'Turn(empty)',
    });
  });

  it('reads Termination', () => {
    expect(
      parseAssemblyAiMessage(
        JSON.stringify({
          type: 'Termination',
          audio_duration_seconds: 13,
          session_duration_seconds: 14,
        }),
        AUDIO_SENT_MS,
      ),
    ).toEqual({ kind: 'termination', audioDurationSeconds: 13 });
  });

  it('maps an Error frame to a fatal error event naming the vendor code', () => {
    expect(
      parseAssemblyAiMessage(
        JSON.stringify({
          type: 'Error',
          error_code: 3008,
          error: 'Session Expired: Maximum session duration exceeded',
        }),
        AUDIO_SENT_MS,
      ),
    ).toEqual({
      kind: 'event',
      event: {
        type: 'error',
        message: 'Session Expired: Maximum session duration exceeded (AssemblyAI error 3008)',
        fatal: true,
      },
    });
    expect(
      parseAssemblyAiMessage(JSON.stringify({ type: 'Error', error: { nested: true } }), 0),
    ).toEqual({
      kind: 'event',
      event: { type: 'error', message: 'AssemblyAI error', fatal: true },
    });
  });

  it('ignores housekeeping messages and reports garbage without throwing', () => {
    for (const type of ['SpeechStarted', 'Heartbeat', 'SpeakerRevision', 'Something new']) {
      expect(parseAssemblyAiMessage(JSON.stringify({ type }), 0)).toEqual({
        kind: 'ignored',
        messageType: type,
      });
    }
    expect(parseAssemblyAiMessage('{nope', 0)).toEqual({ kind: 'invalid', reason: 'not JSON' });
    expect(parseAssemblyAiMessage('[]', 0)).toEqual({ kind: 'invalid', reason: 'missing type' });
    expect(parseAssemblyAiMessage(JSON.stringify({ type: 7 }), 0)).toEqual({
      kind: 'invalid',
      reason: 'missing type',
    });
  });

  it('reports malformed Begin and Turn messages as invalid instead of throwing', () => {
    const malformed: Record<string, unknown>[] = [
      { type: 'Begin' },
      { type: 'Begin', id: 5 },
      { type: 'Turn' },
      { type: 'Turn', turn_order: '0', transcript: 'hi' },
      { type: 'Turn', turn_order: -1, transcript: 'hi' },
      { type: 'Turn', turn_order: 1.5, transcript: 'hi' },
      { type: 'Turn', turn_order: 0, transcript: null },
      { type: 'Turn', turn_order: 0, transcript: 'hi', end_of_turn: 'true' },
      { type: 'Turn', turn_order: 0, transcript: 'hi', turn_is_formatted: 1 },
    ];
    for (const message of malformed) {
      const parsed = parseAssemblyAiMessage(JSON.stringify(message), 0);
      expect(parsed.kind, JSON.stringify(message)).toBe('invalid');
    }
  });
});
