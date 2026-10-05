/**
 * What the page and the worklet agree on. This module has no side effects and no worklet
 * globals, so it is safe to import from both sides. `pcm-worklet.ts` itself must only ever be
 * loaded through `audioWorklet.addModule`.
 */
export const PCM_WORKLET_NAME = 'pcm-chunker';

/** Passed through `AudioWorkletNodeOptions.processorOptions`. */
export interface PcmWorkletOptions {
  chunkSamples: number;
}

/** A page-to-worklet message. */
export type PcmWorkletCommand = 'flush';
