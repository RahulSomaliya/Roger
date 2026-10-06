/** The AudioWorklet global scope is not in lib.dom; this is the subset pcm-worklet.ts uses. */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

/** The AudioContext sample rate, as seen from inside the worklet. */
declare const sampleRate: number;
