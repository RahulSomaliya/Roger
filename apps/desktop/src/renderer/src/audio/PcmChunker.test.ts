import { describe, expect, it } from 'vitest';
import { PcmChunker } from './PcmChunker';

describe('PcmChunker', () => {
  it('emits fixed-size chunks across pushes and keeps the remainder for flush', () => {
    const chunker = new PcmChunker(4);
    expect(chunker.push(new Float32Array([0.5, 0.5, 0.5]), 0)).toEqual([]);
    const chunks = chunker.push(new Float32Array([0.5, -1, -1, -1, 0.25, 0.25]), 3);
    expect(chunks).toHaveLength(2);
    expect([...new Int16Array(chunks[0]!.pcm)]).toEqual([16384, 16384, 16384, 16384]);
    expect([...new Int16Array(chunks[1]!.pcm)]).toEqual([
      -32768,
      -32768,
      -32768,
      Math.round(0.25 * 0x7fff),
    ]);
    const rest = chunker.flush();
    expect(rest).not.toBeNull();
    expect([...new Int16Array(rest!.pcm)]).toEqual([Math.round(0.25 * 0x7fff)]);
    expect(chunker.flush()).toBeNull();
  });

  it('never hands out the same buffer twice (buffers are transferred to main)', () => {
    const chunker = new PcmChunker(2);
    const [first] = chunker.push(new Float32Array([0, 0]), 0);
    const [second] = chunker.push(new Float32Array([0, 0]), 2);
    expect(first!.pcm).not.toBe(second!.pcm);
  });

  it("dates each chunk by its first sample's frame, the page maps it to the wall clock", () => {
    const chunker = new PcmChunker(4);
    // Render quanta of 3 frames from frame 1000 on: chunks start mid-block.
    const block = new Float32Array(3);
    const frames = [
      ...chunker.push(block, 1000),
      ...chunker.push(block, 1003),
      ...chunker.push(block, 1006),
      ...chunker.push(block, 1009),
      ...chunker.push(block, 1012),
    ].map((chunk) => chunk.frame);
    expect(frames).toEqual([1000, 1004, 1008]);
    expect(chunker.flush()?.frame).toBe(1012);
  });

  it('ends a chunk at a gap in frames, so a chunk is always contiguous audio', () => {
    const chunker = new PcmChunker(4);
    expect(chunker.push(new Float32Array([0.5, 0.5]), 0)).toEqual([]);
    // The input went away for 126 frames (the worklet got no input and skipped those quanta):
    // the two samples before the gap leave as a short chunk of their own, dated by frame 0.
    const chunks = chunker.push(new Float32Array([0.25, 0.25, 0.25, 0.25]), 128);
    expect(chunks.map((chunk) => [chunk.frame, chunk.pcm.byteLength / 2])).toEqual([
      [0, 2],
      [128, 4],
    ]);
  });
});
