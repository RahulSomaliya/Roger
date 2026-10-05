import { PcmChunker } from './PcmChunker';

/** Options passed through `AudioWorkletNodeOptions.processorOptions`. */
export interface PcmWorkletOptions {
  chunkSamples: number;
  outputSampleRate: number;
}

export const PCM_WORKLET_NAME = 'pcm-chunker';

/** Runs on the audio thread: downmix to mono, convert to Int16, post complete chunks to the page. */
class PcmChunkerProcessor extends AudioWorkletProcessor {
  private readonly chunker: PcmChunker;
  private stopped = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    // processorOptions is untyped on the wire; PcmStreamCapture is the only sender.
    const { chunkSamples, outputSampleRate } = options.processorOptions as PcmWorkletOptions;
    this.chunker = new PcmChunker(chunkSamples, sampleRate, outputSampleRate);
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== 'flush') return;
      const rest = this.chunker.flush();
      if (rest) this.port.postMessage(rest, [rest]);
      this.stopped = true;
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const mono = channels.length === 1 ? (channels[0] ?? new Float32Array(0)) : downmix(channels);
    for (const chunk of this.chunker.push(mono)) this.port.postMessage(chunk, [chunk]);
    return true;
  }
}

function downmix(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1)
      out[i] = (out[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  return out;
}

registerProcessor(PCM_WORKLET_NAME, PcmChunkerProcessor);
