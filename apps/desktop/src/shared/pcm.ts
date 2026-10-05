/** Pure PCM helpers. Used by the renderer worklet (via PcmChunker) and by main-side adapters. */

/** Convert one Float32 sample in [-1, 1] to Int16, clamping out-of-range input. */
export function floatToInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** Root mean square of Int16 samples, normalised to [0, 1]. Zero for an empty buffer. */
export function rmsInt16(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const s = sample / 0x8000;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/** Milliseconds of audio in a byte count of Int16 mono PCM at `sampleRate`. */
export function pcmBytesToMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}
