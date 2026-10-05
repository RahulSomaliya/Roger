import type { AudioSourceState } from '../../../shared/capture';
import type { AudioSource } from '../../../shared/transcript';
import workletUrl from './pcm-worklet.ts?worker&url';
import {
  PCM_WORKLET_NAME,
  type PcmWorkletCommand,
  type PcmWorkletOptions,
} from './pcm-worklet-contract';

export interface PcmStreamCaptureOptions {
  source: AudioSource;
  sampleRate: number;
  chunkSamples: number;
  onChunk: (pcm: ArrayBuffer) => void;
  onState: (state: AudioSourceState, message?: string) => void;
}

/** One MediaStream → AudioContext → worklet → Int16 chunks. The page never touches samples. */
export class PcmStreamCapture {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;

  constructor(private readonly options: PcmStreamCaptureOptions) {}

  async start(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The stream has no audio track');
    if (track.readyState === 'ended') {
      // macOS hands out a dead track when the audio-capture permission is missing; Chromium raises no error.
      throw new Error('The audio track ended before capture started (is the permission granted?)');
    }
    this.stream = stream;
    const context = new AudioContext({ sampleRate: this.options.sampleRate });
    this.context = context;
    if (context.sampleRate !== this.options.sampleRate) {
      // Chromium resamples to the requested rate on every supported platform; refusing is a real fault.
      throw new Error(
        `AudioContext runs at ${context.sampleRate} Hz, not ${this.options.sampleRate} Hz`,
      );
    }
    await detachFromOutputDevice(context);
    await context.audioWorklet.addModule(workletUrl);
    const processorOptions: PcmWorkletOptions = { chunkSamples: this.options.chunkSamples };
    const node = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions,
    });
    this.node = node;
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.options.onChunk(event.data);
    };
    // A muted path to the destination keeps Chromium pulling audio through the worklet.
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node);
    node.connect(silent).connect(context.destination);
    track.addEventListener('ended', () => {
      this.options.onState('ended', 'The audio device stopped delivering audio');
    });
    if (context.state === 'suspended') await context.resume();
    this.options.onState('active');
  }

  async stop(): Promise<void> {
    const flush: PcmWorkletCommand = 'flush';
    this.node?.port.postMessage(flush);
    // Give the worklet one render quantum to post its last partial chunk before the graph goes away.
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.node?.disconnect();
    this.node = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}

/**
 * Bluetooth headsets switching to the call profile can stall an AudioContext bound to the default
 * output. Detach it: we never play anything.
 */
async function detachFromOutputDevice(context: AudioContext): Promise<void> {
  // `AudioContext.setSinkId` (Chromium 110+) is not in lib.dom yet.
  const sinkable = context as AudioContext & {
    setSinkId?: (sink: { type: 'none' }) => Promise<void>;
  };
  if (typeof sinkable.setSinkId !== 'function') return;
  try {
    await sinkable.setSinkId({ type: 'none' });
  } catch {
    // Not supported on this platform; the gain-0 path still works.
  }
}
