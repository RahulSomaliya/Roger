import { floatToInt16 } from '../../../shared/pcm';

/**
 * Turns Float32 audio blocks into fixed-size Int16 chunks. Pure, so it is unit-tested; the worklet
 * just wires it to the audio graph. No resampling: the AudioContext is created at the target rate
 * and PcmStreamCapture refuses to run if Chromium does not honour it.
 */
export class PcmChunker {
  private buffer: Int16Array<ArrayBuffer>;
  private offset = 0;

  constructor(private readonly chunkSamples: number) {
    if (chunkSamples <= 0) throw new Error('chunkSamples must be positive');
    this.buffer = new Int16Array(chunkSamples);
  }

  /** Returns zero or more complete chunks, each backed by its own transferable ArrayBuffer. */
  push(samples: Float32Array): ArrayBuffer[] {
    const chunks: ArrayBuffer[] = [];
    for (const sample of samples) {
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
