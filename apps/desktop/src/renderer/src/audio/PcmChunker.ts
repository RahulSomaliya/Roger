import { floatToInt16, resampleLinear } from '../../../shared/pcm';

/**
 * Turns Float32 audio blocks into fixed-size Int16 chunks. Pure, so it is unit-tested; the worklet
 * just wires it to the audio graph. Resampling is a fallback: the AudioContext is asked for the
 * target rate and Chromium normally honours it.
 */
export class PcmChunker {
  private buffer: Int16Array<ArrayBuffer>;
  private offset = 0;

  constructor(
    private readonly chunkSamples: number,
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    if (chunkSamples <= 0) throw new Error('chunkSamples must be positive');
    this.buffer = new Int16Array(chunkSamples);
  }

  /** Returns zero or more complete chunks, each backed by its own transferable ArrayBuffer. */
  push(samples: Float32Array): ArrayBuffer[] {
    const resampled = resampleLinear(samples, this.inputRate, this.outputRate);
    const chunks: ArrayBuffer[] = [];
    for (const sample of resampled) {
      this.buffer[this.offset] = floatToInt16(sample);
      this.offset += 1;
      if (this.offset === this.chunkSamples) {
        chunks.push(this.buffer.buffer);
        this.buffer = new Int16Array(this.chunkSamples);
        this.offset = 0;
      }
    }
    return chunks;
  }

  /** The partial chunk accumulated so far, or null when empty. */
  flush(): ArrayBuffer | null {
    if (this.offset === 0) return null;
    const rest = this.buffer.slice(0, this.offset).buffer;
    this.buffer = new Int16Array(this.chunkSamples);
    this.offset = 0;
    return rest;
  }
}
