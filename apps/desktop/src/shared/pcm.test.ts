import { describe, expect, it } from 'vitest';
import { floatToInt16, pcmBytesToMs, resampleLinear, rmsInt16 } from './pcm';

describe('floatToInt16', () => {
  it('maps the full float range onto int16 without overflow', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(0x7fff);
    expect(floatToInt16(-1)).toBe(-0x8000);
    expect(floatToInt16(0.5)).toBe(Math.round(0.5 * 0x7fff));
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    expect(floatToInt16(2)).toBe(0x7fff);
    expect(floatToInt16(-2)).toBe(-0x8000);
  });
});

describe('rmsInt16', () => {
  it('is zero for silence and an empty buffer', () => {
    expect(rmsInt16(new Int16Array(0))).toBe(0);
    expect(rmsInt16(new Int16Array(100))).toBe(0);
  });

  it('is close to one for a full-scale square wave', () => {
    const samples = new Int16Array(100).map((_, i) => (i % 2 === 0 ? 0x7fff : -0x8000));
    expect(rmsInt16(samples)).toBeCloseTo(1, 3);
  });
});

describe('resampleLinear', () => {
  it('returns the input untouched when rates match', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('halves the length when downsampling 2:1 and keeps a constant signal constant', () => {
    const input = new Float32Array(32000).fill(0.25);
    const out = resampleLinear(input, 32000, 16000);
    expect(out.length).toBe(16000);
    expect(out.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
  });

  it('keeps 48k to 16k output at a third of the input length', () => {
    const input = new Float32Array(4800).map((_, i) => Math.sin(i / 10));
    expect(resampleLinear(input, 48000, 16000).length).toBe(1600);
  });
});

describe('pcmBytesToMs', () => {
  it('treats 3200 bytes at 16 kHz as 100 ms', () => {
    expect(pcmBytesToMs(3200, 16000)).toBe(100);
  });
});
