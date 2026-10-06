import { describe, expect, it } from 'vitest';
import type { AudioSource } from '../../shared/transcript';
import { createLogger } from '../logger';
import { AudioFanout, type AudioSink } from './AudioFanout';

interface Delivered {
  source: AudioSource;
  pcm: Uint8Array;
  capturedAtMs: number;
}

function recordingSink(): AudioSink & { got: Delivered[] } {
  const got: Delivered[] = [];
  return {
    got,
    onChunk: (source, pcm, capturedAtMs) => {
      got.push({ source, pcm, capturedAtMs });
    },
  };
}

function logged() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'info',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger };
}

describe('AudioFanout', () => {
  it('hands each chunk to every sink once, with its capture time, in the order they were added', () => {
    const fanout = new AudioFanout(logged().logger);
    const order: string[] = [];
    const first = recordingSink();
    const second = recordingSink();
    fanout.add('first', {
      onChunk: (...args) => {
        order.push('first');
        first.onChunk(...args);
      },
    });
    fanout.add('second', {
      onChunk: (...args) => {
        order.push('second');
        second.onChunk(...args);
      },
    });

    const mic = new Uint8Array(3200).fill(1);
    const system = new Uint8Array(3200).fill(2);
    fanout.push('mic', mic, 1_000_100);
    fanout.push('system', system, 1_000_150);

    const expected = [
      { source: 'mic', pcm: mic, capturedAtMs: 1_000_100 },
      { source: 'system', pcm: system, capturedAtMs: 1_000_150 },
    ];
    expect(first.got).toEqual(expected);
    expect(second.got).toEqual(expected);
    expect(order).toEqual(['first', 'second', 'first', 'second']);
  });

  it('keeps a sink added twice once, and stops a removed sink', () => {
    const fanout = new AudioFanout(logged().logger);
    const sink = recordingSink();
    const remove = fanout.add('backup', sink);
    fanout.add('backup', sink);
    fanout.push('mic', new Uint8Array(2), 1);
    expect(sink.got).toHaveLength(1);

    remove();
    fanout.push('mic', new Uint8Array(2), 2);
    expect(sink.got).toHaveLength(1);
  });

  it('logs a sink that throws and still hands the chunk to the others, and logs a spell once', () => {
    const log = logged();
    const fanout = new AudioFanout(log.logger);
    let failing = true;
    fanout.add('broken', {
      onChunk: () => {
        if (failing) throw new Error('disk full');
      },
    });
    const after = recordingSink();
    fanout.add('after', after);

    for (let i = 0; i < 5; i += 1) fanout.push('system', new Uint8Array(2), i);
    expect(after.got).toHaveLength(5);
    const failures = log.lines.filter((line) => line.message === 'audio sink failed');
    // Ten chunks a second per source: one line per spell, not one per chunk.
    expect(failures).toEqual([
      expect.objectContaining({
        level: 'error',
        sink: 'broken',
        source: 'system',
        error: 'disk full',
      }),
    ]);

    failing = false;
    fanout.push('system', new Uint8Array(2), 5);
    expect(log.lines.filter((line) => line.message === 'audio sink recovered')).toEqual([
      expect.objectContaining({ sink: 'broken', failedChunks: 5 }),
    ]);

    failing = true;
    fanout.push('mic', new Uint8Array(2), 6);
    expect(log.lines.filter((line) => line.message === 'audio sink failed')).toHaveLength(2);
  });
});
