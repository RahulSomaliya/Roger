import { describe, expect, it } from 'vitest';
import { parseDeepgramMessage } from './messages';

const results = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    start: 1.5,
    duration: 0.75,
    is_final: false,
    channel: {
      alternatives: [
        {
          transcript: 'hello there',
          confidence: 0.91,
          words: [
            { word: 'hello', start: 1.5, end: 1.9, confidence: 0.95, punctuated_word: 'Hello' },
            { word: 'there', start: 1.95, end: 2.25, confidence: 0.87 },
          ],
        },
      ],
    },
    metadata: {
      request_id: 'r',
      model_info: { name: 'nova-3', version: '1', arch: 'x' },
      model_uuid: 'u',
    },
    ...overrides,
  });

describe('parseDeepgramMessage', () => {
  it('turns a non-final result into an interim event with millisecond offsets', () => {
    expect(parseDeepgramMessage(results({}))).toEqual({
      kind: 'event',
      event: { type: 'interim', text: 'hello there', startMs: 1500, endMs: 2250 },
    });
  });

  it('turns is_final into a final event with punctuated words', () => {
    const parsed = parseDeepgramMessage(results({ is_final: true }));
    expect(parsed).toEqual({
      kind: 'event',
      event: {
        type: 'final',
        text: 'hello there',
        startMs: 1500,
        endMs: 2250,
        confidence: 0.91,
        words: [
          { text: 'Hello', startMs: 1500, endMs: 1900, confidence: 0.95 },
          { text: 'there', startMs: 1950, endMs: 2250, confidence: 0.87 },
        ],
      },
    });
  });

  it('treats from_finalize as final too (the flush after Finalize)', () => {
    const parsed = parseDeepgramMessage(results({ from_finalize: true }));
    expect(parsed.kind).toBe('event');
    expect(parsed.kind === 'event' && parsed.event.type).toBe('final');
  });

  it('ignores empty transcripts rather than storing blank lines', () => {
    const parsed = parseDeepgramMessage(
      results({ is_final: true, channel: { alternatives: [{ transcript: '   ', words: [] }] } }),
    );
    expect(parsed).toEqual({ kind: 'ignored', messageType: 'Results(empty)' });
  });

  it('maps Error messages to a fatal error event', () => {
    expect(
      parseDeepgramMessage(JSON.stringify({ type: 'Error', description: 'bad token' })),
    ).toEqual({
      kind: 'event',
      event: { type: 'error', message: 'bad token', fatal: true },
    });
  });

  it('ignores housekeeping messages and reports garbage without throwing', () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata' }))).toEqual({
      kind: 'ignored',
      messageType: 'Metadata',
    });
    expect(parseDeepgramMessage(JSON.stringify({ type: 'UtteranceEnd' })).kind).toBe('ignored');
    expect(parseDeepgramMessage('{nope')).toEqual({ kind: 'invalid', reason: 'not JSON' });
    expect(parseDeepgramMessage('[]')).toEqual({ kind: 'invalid', reason: 'missing type' });
  });
});
