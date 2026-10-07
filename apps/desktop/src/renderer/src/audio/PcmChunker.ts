import { floatToInt16 } from '../../../shared/pcm';
import type { PcmWorkletChunk } from './pcm-worklet-contract';

/**
 * Turns Float32 audio blocks into fixed-size Int16 chunks, each dated by the frame of its first
 * sample. Pure, so it is unit-tested; the worklet just wires it to the audio graph. No resampling:
 * the AudioContext is created at the target rate and PcmStreamCapture refuses to run if Chromium
 * does not honour it.
 */
export class PcmChunker {
  private buffer: Int16Array<ArrayBuffer>;
  private offset = 0;
  /** The frame of `buffer[0]`, while `offset` is above 0. */
  private startFrame = 0;

  constructor(private readonly chunkSamples: number) {
    if (chunkSamples <= 0) throw new Error('chunkSamples must be positive');
    this.buffer = new Int16Array(chunkSamples);
  }

  /**
   * Takes one block whose first sample is at `frame`. Returns zero or more complete chunks, each
   * backed by its own transferable ArrayBuffer.
   */
  push(samples: Float32Array, frame: number): PcmWorkletChunk[] {
    const chunks: PcmWorkletChunk[] = [];
    // A block that does not follow the last one (the input went away for a while and the worklet
    // skipped those quanta) ends the partial chunk: dated by its first sample, a chunk that ran on
    // across the gap would put the samples after it too early on the meeting's timeline.
    if (this.offset > 0 && frame !== this.startFrame + this.offset) {
      const rest = this.flush();
      if (rest) chunks.push(rest);
    }
    for (let i = 0; i < samples.length; i += 1) {
      if (this.offset === 0) this.startFrame = frame + i;
      this.buffer[this.offset] = floatToInt16(samples[i] ?? 0);
      this.offset += 1;
      if (this.offset === this.chunkSamples) {
        chunks.push({ pcm: this.buffer.buffer, frame: this.startFrame });
        this.buffer = new Int16Array(this.chunkSamples);
        this.offset = 0;
      }
    }
    return chunks;
  }

  /** The partial chunk accumulated so far, or null when empty. */
  flush(): PcmWorkletChunk | null {
    if (this.offset === 0) return null;
    const rest = { pcm: this.buffer.slice(0, this.offset).buffer, frame: this.startFrame };
    this.buffer = new Int16Array(this.chunkSamples);
    this.offset = 0;
    return rest;
  }
}
