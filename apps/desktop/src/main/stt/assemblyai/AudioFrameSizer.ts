export interface AudioFrameSizerOptions {
  sampleRate: number;
  minMs: number;
  maxMs: number;
}

/**
 * Keeps every binary audio message inside AssemblyAI's allowed duration. A message under 50 ms or
 * over 1000 ms ends the session with close code 3007 ("Input duration violation"), and the
 * renderer can send both: the partial chunk PcmChunker flushes on Stop is usually shorter, and IPC
 * accepts chunks up to 1 MiB (about 32 s). Pure, for Int16 mono PCM; byte lengths stay whole samples.
 */
export class AudioFrameSizer {
  readonly minBytes: number;
  readonly maxBytes: number;
  private pending = new Uint8Array(0);

  constructor(options: AudioFrameSizerOptions) {
    this.minBytes = msToSampleBytes(options.minMs, options.sampleRate);
    this.maxBytes = msToSampleBytes(options.maxMs, options.sampleRate);
  }

  /** The frames ready to send, in order. Audio under the minimum waits for the next push. */
  push(pcm: Uint8Array): Uint8Array[] {
    if (this.pending.byteLength === 0 && this.fits(pcm.byteLength)) return [pcm];
    const buffered = new Uint8Array(this.pending.byteLength + pcm.byteLength);
    buffered.set(this.pending);
    buffered.set(pcm, this.pending.byteLength);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (buffered.byteLength - offset >= this.maxBytes) {
      frames.push(buffered.subarray(offset, offset + this.maxBytes));
      offset += this.maxBytes;
    }
    if (buffered.byteLength - offset >= this.minBytes) {
      frames.push(buffered.subarray(offset));
      offset = buffered.byteLength;
    }
    this.pending = buffered.slice(offset);
    return frames;
  }

  /** The held tail, padded with silence up to the minimum, or null when nothing is held. */
  flush(): Uint8Array | null {
    if (this.pending.byteLength === 0) return null;
    const frame = new Uint8Array(Math.max(this.pending.byteLength, this.minBytes));
    frame.set(this.pending);
    this.pending = new Uint8Array(0);
    return frame;
  }

  private fits(byteLength: number): boolean {
    return byteLength >= this.minBytes && byteLength <= this.maxBytes;
  }
}

function msToSampleBytes(ms: number, sampleRate: number): number {
  return Math.round((sampleRate * ms) / 1000) * 2;
}
