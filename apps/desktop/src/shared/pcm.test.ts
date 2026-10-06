import { describe, expect, it } from 'vitest';
import { floatToInt16, pcmBytesToMs, rmsInt16 } from './pcm';

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

describe('pcmBytesToMs', () => {
  it('treats 3200 bytes at 16 kHz as 100 ms', () => {
    expect(pcmBytesToMs(3200, 16000)).toBe(100);
  });
});
