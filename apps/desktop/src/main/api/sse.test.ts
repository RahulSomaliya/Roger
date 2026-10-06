import { describe, expect, it } from 'vitest';
import { SseParser, type SseEvent } from './sse';

const encoder = new TextEncoder();

/** Feeds `bytes` to one parser in the given pieces and returns every event it gave. */
function parse(pieces: Uint8Array[]): SseEvent[] {
  const parser = new SseParser();
  return pieces.flatMap((piece) => parser.push(piece));
}

const whole = (text: string): SseEvent[] => parse([encoder.encode(text)]);

describe('SseParser', () => {
  it('parses events across any byte split', () => {
    // Multi-byte UTF-8 (2, 3 and 4 bytes), CRLF, LF and lone CR endings, a ping, a BOM at the start:
    // a split can land inside a character, between a CR and its LF, or inside a field name.
    const stream =
      '\uFEFFevent: run\r\ndata: {"run_id":"r-1"}\r\n\r\n' +
      ': ping\n\n' +
      'event: item\ndata: {"text":"Caf\u00e9 \u2713 \u65e5\u672c \ud83d\ude00"}\n\n' +
      'event: delta\rdata: line one\rdata: line two\r\r' +
      'event: done\r\ndata: {}\r\n\r\n';
    const bytes = encoder.encode(stream);
    const expected: SseEvent[] = [
      { event: 'run', data: '{"run_id":"r-1"}' },
      { event: 'item', data: '{"text":"Caf\u00e9 \u2713 \u65e5\u672c \ud83d\ude00"}' },
      { event: 'delta', data: 'line one\nline two' },
      { event: 'done', data: '{}' },
    ];

    expect(parse([bytes])).toEqual(expected);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      expect(parse([bytes.slice(0, cut), bytes.slice(cut)]), `cut at byte ${cut}`).toEqual(
        expected,
      );
    }
    const oneByteAtATime = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(parse(oneByteAtATime)).toEqual(expected);
  });

  it('handles CRLF and multi-line data', () => {
    expect(whole('data: first\r\ndata: second\r\n\r\n')).toEqual([
      { event: 'message', data: 'first\nsecond' },
    ]);
    expect(whole('event: delta\rdata: a\rdata:\rdata: b\r\r')).toEqual([
      { event: 'delta', data: 'a\n\nb' },
    ]);
    // One space after the colon is dropped, any more are data; a field with no colon is empty.
    expect(whole('data:tight\ndata:  two spaces\ndata\n\n')).toEqual([
      { event: 'message', data: 'tight\n two spaces\n' },
    ]);
    // The event type does not carry over to the next event.
    expect(whole('event: run\ndata: 1\n\ndata: 2\n\n')).toEqual([
      { event: 'run', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });

  it('ignores comments and pings', () => {
    expect(whole(': ping\n\n:\n\n: ping\r\n\r\n')).toEqual([]);
    // A comment inside an event, and fields Roger does not use (id, retry, unknown names).
    expect(
      whole('event: section\n: ping\nid: 7\nretry: 1000\nfoo: bar\ndata: {"index":0}\n\n'),
    ).toEqual([{ event: 'section', data: '{"index":0}' }]);
    // An event with no data line is no event, and its type does not leak into the next one.
    expect(whole('event: run\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x' }]);
    // An event the stream never closed with a blank line is never dispatched.
    expect(whole('event: done\ndata: {}\n')).toEqual([]);
  });
});
