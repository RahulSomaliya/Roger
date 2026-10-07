import { describe, expect, it } from 'vitest';
import { AudioPacer, type AudioPacing } from './AudioPacer';

// At 16 kHz Int16 mono one millisecond is 32 bytes. The clock is the `nowMs` each call is given.
const BYTES_PER_MS = 32;
const audio = (ms: number): Uint8Array => new Uint8Array(ms * BYTES_PER_MS);
const msOf = (frames: Uint8Array[]): number =>
  frames.reduce((sum, frame) => sum + frame.byteLength, 0) / BYTES_PER_MS;
const pacer = (pacing: AudioPacing, sampleRate = 16_000): AudioPacer =>
  new AudioPacer({ pacing, sampleRate });

describe('AudioPacer, realtime', () => {
  it('never holds live 100 ms chunks', () => {
    const live = pacer('realtime');
    live.start(1_000);
    // A minute of live audio: each chunk arrives once it was captured, the first 30 ms after ready.
    for (let chunk = 0; chunk < 600; chunk += 1) {
      live.enqueue(audio(100));
      expect(msOf(live.take(1_030 + chunk * 100))).toBe(100);
      expect(live.nextAtMs()).toBeNull();
    }
  });

  it('never holds a late chunk, nor the chunk that arrives on time behind it', () => {
    const live = pacer('realtime');
    live.start(0);
    live.enqueue(audio(100));
    expect(msOf(live.take(0))).toBe(100);
    // The next chunk is 150 ms late and the one after it on time: both go at once.
    live.enqueue(audio(100));
    live.enqueue(audio(100));
    expect(msOf(live.take(250))).toBe(200);
    expect(live.queuedMs).toBe(0);
  });

  it('sends a 3 s backlog right after ready at 1x', () => {
    const reopen = pacer('realtime');
    reopen.start(0);
    for (let chunk = 0; chunk < 30; chunk += 1) reopen.enqueue(audio(100));

    expect(msOf(reopen.take(0))).toBe(100);
    expect(reopen.nextAtMs()).toBe(100);
    expect(reopen.take(99)).toEqual([]);
    expect(msOf(reopen.take(100))).toBe(100);
    expect(msOf(reopen.take(1_000))).toBe(900);
    expect(reopen.queuedMs).toBe(1_900);
    expect(reopen.nextAtMs()).toBe(1_100);
    expect(msOf(reopen.take(2_900))).toBe(1_900);
    expect(reopen.nextAtMs()).toBeNull();
    expect(reopen.queuedMs).toBe(0);
  });

  it('never lets the audio sent run ahead of the real time since ready by more than one frame', () => {
    const paced = pacer('realtime');
    const readyAtMs = 5_000;
    paced.start(readyAtMs);
    // Arrivals and frame sizes from a fixed-seed generator (mulberry32): bursts, stalls and
    // AssemblyAI's 50 to 1000 ms frames, about as much audio as time on average.
    let seed = 42;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    let now = readyAtMs;
    let sentMs = 0;
    for (let step = 0; step < 2_000; step += 1) {
      now += Math.floor(random() * 600);
      if (random() < 0.5) paced.enqueue(audio(50 + Math.floor(random() * 951)));
      for (const frame of paced.take(now)) {
        // A frame goes only once the audio before it fits in the time since ready.
        expect(sentMs).toBeLessThanOrEqual(now - readyAtMs);
        sentMs += frame.byteLength / BYTES_PER_MS;
      }
      // And everything that may go has gone: what waits is not due yet.
      const next = paced.nextAtMs();
      if (next !== null) expect(next).toBeGreaterThan(now);
    }
    expect(sentMs).toBeGreaterThan(0);
  });

  it('never catches up: a backlog stays as lag while live audio keeps coming', () => {
    const reopen = pacer('realtime');
    reopen.start(0);
    for (let chunk = 0; chunk < 10; chunk += 1) reopen.enqueue(audio(100));
    expect(msOf(reopen.take(0))).toBe(100);
    for (let chunk = 1; chunk <= 600; chunk += 1) {
      reopen.enqueue(audio(100));
      expect(msOf(reopen.take(chunk * 100))).toBe(100);
      expect(reopen.queuedMs).toBe(900);
    }
  });

  it('paces by the duration of each frame, whatever its size', () => {
    const framed = pacer('realtime');
    framed.start(0);
    framed.enqueue(audio(1_000));
    framed.enqueue(audio(50));
    framed.enqueue(audio(50));

    expect(msOf(framed.take(0))).toBe(1_000);
    expect(framed.nextAtMs()).toBe(1_000);
    expect(framed.take(999)).toEqual([]);
    expect(msOf(framed.take(1_000))).toBe(50);
    expect(framed.nextAtMs()).toBe(1_050);
  });

  it('counts whole samples at a rate that does not divide a millisecond', () => {
    // 100 ms at 44.1 kHz is 4410 samples, 8820 bytes.
    const odd = pacer('realtime', 44_100);
    odd.start(0);
    for (let chunk = 0; chunk < 10; chunk += 1) odd.enqueue(new Uint8Array(8_820));

    expect(odd.take(500)).toHaveLength(6);
    expect(odd.nextAtMs()).toBe(600);
    expect(odd.queuedMs).toBe(400);
  });
});

describe('AudioPacer, none', () => {
  it('sends a backlog at once', () => {
    const unpaced = pacer('none');
    unpaced.start(0);
    for (let chunk = 0; chunk < 30; chunk += 1) unpaced.enqueue(audio(100));

    expect(msOf(unpaced.take(0))).toBe(3_000);
    expect(unpaced.nextAtMs()).toBeNull();
    expect(unpaced.queuedMs).toBe(0);
  });
});

describe('AudioPacer, either way', () => {
  it.each<AudioPacing>(['realtime', 'none'])(
    '%s sends nothing before the ready signal',
    (pacing) => {
      const early = pacer(pacing);
      early.enqueue(audio(100));

      expect(early.take(60_000)).toEqual([]);
      expect(early.nextAtMs()).toBeNull();
      expect(early.queuedMs).toBe(100);
      early.start(60_000);
      expect(msOf(early.take(60_000))).toBe(100);
    },
  );

  it('discards what is queued and says how much audio that was', () => {
    const closing = pacer('realtime');
    closing.start(0);
    for (let chunk = 0; chunk < 30; chunk += 1) closing.enqueue(audio(100));
    closing.take(0);

    expect(closing.discard()).toBe(2_900);
    expect(closing.queuedMs).toBe(0);
    expect(closing.nextAtMs()).toBeNull();
    expect(closing.take(60_000)).toEqual([]);
    expect(closing.discard()).toBe(0);
  });
});
