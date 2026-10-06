import { describe, expect, it } from 'vitest';
import { AudioFrameSizer } from './AudioFrameSizer';

// At 16 kHz Int16 mono: 50 ms = 1600 bytes, 100 ms = 3200 bytes, 1000 ms = 32000 bytes.
const sizer = () => new AudioFrameSizer({ sampleRate: 16_000, minMs: 50, maxMs: 1000 });
const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

describe('AudioFrameSizer', () => {
  it('passes 100 ms renderer chunks straight through', () => {
    const frames = sizer();
    const chunk = bytes(3200);
    expect(frames.push(chunk)).toEqual([chunk]);
    expect(frames.flush()).toBeNull();
  });

  it('holds audio shorter than the minimum until there is enough', () => {
    const frames = sizer();
    expect(frames.push(bytes(1000, 1))).toEqual([]);
    const [frame, ...rest] = frames.push(bytes(1000, 2));
    expect(rest).toEqual([]);
    expect(frame?.byteLength).toBe(2000);
    expect(frame?.[0]).toBe(1);
    expect(frame?.[1999]).toBe(2);
  });

  it('splits a chunk longer than the maximum, in order', () => {
    const frames = sizer();
    const chunk = new Uint8Array(70_000);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = i % 251;
    const out = frames.push(chunk);
    expect(out.map((frame) => frame.byteLength)).toEqual([32_000, 32_000, 6_000]);
    expect(Buffer.concat(out).equals(Buffer.from(chunk))).toBe(true);
  });

  it('keeps a remainder below the minimum for the next push', () => {
    const frames = sizer();
    const out = frames.push(bytes(32_000 + 800));
    expect(out.map((frame) => frame.byteLength)).toEqual([32_000]);
    expect(frames.push(bytes(3200)).map((frame) => frame.byteLength)).toEqual([4000]);
  });

  it('pads the tail with silence up to the minimum on flush', () => {
    const frames = sizer();
    frames.push(bytes(640, 7));
    const tail = frames.flush();
    expect(tail?.byteLength).toBe(1600);
    expect(tail?.[639]).toBe(7);
    expect(tail?.[640]).toBe(0);
    expect(tail?.[1599]).toBe(0);
    expect(frames.flush()).toBeNull();
  });

  it('rounds the limits to whole Int16 samples', () => {
    const odd = new AudioFrameSizer({ sampleRate: 44_100, minMs: 50, maxMs: 1000 });
    expect(odd.minBytes % 2).toBe(0);
    expect(odd.maxBytes % 2).toBe(0);
    expect(odd.minBytes).toBe(4410);
    expect(odd.maxBytes).toBe(88_200);
  });
});
