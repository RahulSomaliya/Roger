import { describe, expect, it } from 'vitest';
import { PcmChunker } from './PcmChunker';

describe('PcmChunker', () => {
  it('emits fixed-size chunks across pushes and keeps the remainder for flush', () => {
    const chunker = new PcmChunker(4, 16000, 16000);
    expect(chunker.push(new Float32Array([0.5, 0.5, 0.5]))).toEqual([]);
    const chunks = chunker.push(new Float32Array([0.5, -1, -1, -1, 0.25, 0.25]));
    expect(chunks).toHaveLength(2);
    expect([...new Int16Array(chunks[0]!)]).toEqual([16384, 16384, 16384, 16384]);
    expect([...new Int16Array(chunks[1]!)]).toEqual([
      -32768,
      -32768,
      -32768,
      Math.round(0.25 * 0x7fff),
    ]);
    const rest = chunker.flush();
    expect(rest).not.toBeNull();
    expect([...new Int16Array(rest!)]).toEqual([Math.round(0.25 * 0x7fff)]);
    expect(chunker.flush()).toBeNull();
  });

  it('never hands out the same buffer twice (buffers are transferred to main)', () => {
    const chunker = new PcmChunker(2, 16000, 16000);
    const [first] = chunker.push(new Float32Array([0, 0]));
    const [second] = chunker.push(new Float32Array([0, 0]));
    expect(first).not.toBe(second);
  });

  it('downsamples when the context rate is not the target rate', () => {
    const chunker = new PcmChunker(1600, 48000, 16000);
    const chunks = chunker.push(new Float32Array(4800).fill(0.1));
    expect(chunks).toHaveLength(1);
    expect(chunker.flush()).toBeNull();
  });
});
