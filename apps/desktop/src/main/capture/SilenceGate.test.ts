import { describe, expect, it } from 'vitest';
import {
  chunkLevelDb,
  DIGITAL_SILENCE_DB,
  SilenceGate,
  type SilenceGateOptions,
} from './SilenceGate';

const options: SilenceGateOptions = { closeAfterMs: 30_000, preRollMs: 1_000, sampleRate: 16_000 };

/** 100 ms of 16 kHz PCM at about `levelDb` dBFS: alternating +v, -v, so its RMS is v. */
function tone(levelDb: number): Uint8Array {
  const value = Math.round(32_768 * 10 ** (levelDb / 20));
  const samples = new Int16Array(1_600).map((_, i) => (i % 2 === 0 ? value : -value));
  return new Uint8Array(samples.buffer);
}

const zeros = (): Uint8Array => new Uint8Array(3_200);

/** Feeds `count` chunks of `pcm()` from capture time `fromMs`; answers how many were speech. */
function feed(gate: SilenceGate, pcm: () => Uint8Array, fromMs: number, count: number): number {
  let speech = 0;
  for (let i = 0; i < count; i += 1) {
    if (gate.hear(pcm(), fromMs + i * 100).speech) speech += 1;
  }
  return speech;
}

describe('chunkLevelDb', () => {
  it('reads a chunk with rmsInt16 as dBFS, and digital silence as one LSB', () => {
    expect(chunkLevelDb(tone(-20))).toBeCloseTo(-20, 1);
    expect(chunkLevelDb(tone(-60))).toBeCloseTo(-60, 0);
    // Exact zeros have no level (-Infinity): read as the floor of 16-bit audio, so a waiting
    // room's zeros followed by a dither of one LSB is not 9 dB of "speech".
    expect(chunkLevelDb(zeros())).toBe(DIGITAL_SILENCE_DB);
    expect(chunkLevelDb(tone(-96))).toBe(DIGITAL_SILENCE_DB);
    expect(chunkLevelDb(new Uint8Array(0))).toBe(DIGITAL_SILENCE_DB);
  });

  it('reads PCM that starts at an odd byte offset, as a Node buffer slice can', () => {
    const backing = new Uint8Array(3_201);
    backing.set(tone(-30), 1);
    expect(chunkLevelDb(backing.subarray(1))).toBeCloseTo(-30, 1);
  });
});

describe('SilenceGate', () => {
  it("never counts a quiet room's noise floor as speech, and counts a soft voice 9 dB over it", () => {
    const gate = new SilenceGate(options);
    // 30 s of a room at -65 dBFS: nothing in it is speech but its first chunk, heard before
    // there was any floor (the floor starts at digital silence, so the gate leans to speech).
    expect(feed(gate, () => tone(-65), 0, 300)).toBe(1);
    expect(gate.floorDb).toBeCloseTo(-65, 0);
    // A voice far below -40 dBFS, but more than 9 dB over the room: speech.
    expect(gate.hear(tone(-55.5), 30_000)).toMatchObject({ speech: true });
    // 8 dB over it is still the room.
    expect(gate.hear(tone(-57), 30_100)).toMatchObject({ speech: false });
  });

  it('counts anything louder than -40 dBFS as speech, however loud the room', () => {
    const gate = new SilenceGate(options);
    expect(feed(gate, () => tone(-42), 0, 1)).toBe(1); // 9 dB over no floor yet
    expect(feed(gate, () => tone(-42), 100, 299)).toBe(0);
    expect(gate.hear(tone(-38), 30_000).speech).toBe(true);
  });

  it('takes the floor from the last 30 s only, so a room that got quieter lowers it', () => {
    const gate = new SilenceGate(options);
    feed(gate, () => tone(-50), 0, 300);
    feed(gate, () => tone(-70), 30_000, 300);
    expect(gate.floorDb).toBeCloseTo(-70, 0);
    expect(gate.hear(tone(-58), 60_000).speech).toBe(true);
  });

  it('counts the hang-over in audio since the last speech chunk', () => {
    const gate = new SilenceGate(options);
    feed(gate, zeros, 0, 299);
    expect(gate.silentForMs).toBe(29_900);
    expect(gate.shouldClose).toBe(false);
    gate.hear(zeros(), 29_900);
    expect(gate.shouldClose).toBe(true);
    // One speech chunk starts it over.
    gate.hear(tone(-20), 30_000);
    expect(gate.silentForMs).toBe(0);
    expect(gate.shouldClose).toBe(false);
  });

  it('while closed keeps the newest pre-roll before the speech, and its peak level', () => {
    const gate = new SilenceGate(options);
    feed(gate, () => tone(-70), 0, 300); // a room at -70 dBFS
    gate.close();
    expect(gate.gated).toBe(true);
    expect(gate.shouldClose).toBe(false); // already closed
    feed(gate, () => tone(-70), 30_000, 20); // 2 s, more than the 1 s ring
    gate.hear(tone(-75), 32_000);
    const onset = gate.hear(tone(-20), 32_100);
    expect(onset.speech).toBe(true);

    const { preRoll, peakDb } = gate.open();
    expect(gate.gated).toBe(false);
    // The second before the speech chunk, which the caller holds itself after it.
    expect(preRoll.map((chunk) => chunk.capturedAtMs)).toEqual(
      Array.from({ length: 10 }, (_, i) => 31_100 + i * 100),
    );
    expect(peakDb).toBeCloseTo(-70, 0);
    // The ring is gone once taken: a second open hands nothing.
    expect(gate.open().preRoll).toEqual([]);
  });

  it('keeps nothing while open, and a 3 s pre-roll holds 3 s', () => {
    const gate = new SilenceGate({ ...options, preRollMs: 3_000 });
    feed(gate, zeros, 0, 50);
    gate.close();
    expect(gate.open().preRoll).toEqual([]);
    gate.close();
    feed(gate, zeros, 5_000, 50);
    expect(gate.open().preRoll).toHaveLength(30);
  });

  it('refuses settings it cannot count with', () => {
    expect(() => new SilenceGate({ ...options, closeAfterMs: 0 })).toThrow(RangeError);
    expect(() => new SilenceGate({ ...options, preRollMs: -1 })).toThrow(RangeError);
    expect(() => new SilenceGate({ ...options, sampleRate: 0 })).toThrow(RangeError);
  });
});
