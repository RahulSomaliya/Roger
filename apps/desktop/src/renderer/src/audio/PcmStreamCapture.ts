import type { AudioSource } from '../../../shared/transcript';
import {
  type ContextClock,
  frameCapturedAtMs,
  type PageClock,
  readPageClock,
} from './captureClock';
import workletUrl from './pcm-worklet.ts?worker&url';
import {
  PCM_WORKLET_NAME,
  type PcmWorkletChunk,
  type PcmWorkletCommand,
  type PcmWorkletOptions,
} from './pcm-worklet-contract';
import { type CaptureStream, stopTracks } from './streams';

export interface PcmStreamCaptureOptions {
  source: AudioSource;
  sampleRate: number;
  chunkSamples: number;
  /** One chunk, with the wall clock of its first sample (`AudioChunkMessage.capturedAtMs`). */
  onChunk: (pcm: ArrayBuffer, capturedAtMs: number) => void;
}

/**
 * The audio graph one capture runs on: an AudioContext, the PCM worklet's one node, and the
 * streams fed into it. An interface so PcmStreamCapture runs under node in its tests;
 * createBrowserGraph below is the real one.
 */
export interface CaptureGraph<S> {
  /** The rate the context really runs at: Chromium may not honour the one asked for. */
  readonly sampleRate: number;
  /** Loads the worklet and makes its one node, wired to a muted output. Once per graph. */
  startWorklet(
    options: PcmWorkletOptions,
    onChunk: (chunk: PcmWorkletChunk) => void,
  ): Promise<void>;
  /** Feeds a stream's audio into the worklet node; the function returned unplugs it again. */
  connect(stream: S): () => void;
  /** Asks the worklet to post its partial chunk and stop. */
  flush(): void;
  readClock(): ContextClock;
  /** Starts the context if Chromium created it suspended. */
  resume(): Promise<void>;
  /** Unplugs the worklet and closes the context. */
  close(): Promise<void>;
}

export type CreateCaptureGraph<S> = (sampleRate: number) => CaptureGraph<S>;

/**
 * One source's capture: stream → AudioContext → worklet → Int16 chunks, each dated where it was
 * captured. The page never touches samples. The stream can be swapped (MicRecovery) without
 * rebuilding the graph: the worklet, its partial chunk and its frame count carry on.
 */
export class PcmStreamCapture<S extends CaptureStream> {
  private graph: CaptureGraph<S> | null = null;
  private stream: S | null = null;
  private unplug: (() => void) | null = null;

  constructor(
    private readonly options: PcmStreamCaptureOptions,
    private readonly createGraph: CreateCaptureGraph<S>,
    private readonly pageClock: () => PageClock = readPageClock,
  ) {}

  async start(stream: S): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The stream has no audio track');
    if (track.readyState === 'ended') {
      // macOS hands out a dead track when the audio-capture permission is missing; Chromium raises no error.
      throw new Error('The audio track ended before capture started (is the permission granted?)');
    }
    this.stream = stream;
    // Kept before the checks below, so stop() closes a context that failed them.
    const graph = this.createGraph(this.options.sampleRate);
    this.graph = graph;
    if (graph.sampleRate !== this.options.sampleRate) {
      // Chromium resamples to the requested rate on every supported platform; refusing is a real fault.
      throw new Error(
        `AudioContext runs at ${graph.sampleRate} Hz, not ${this.options.sampleRate} Hz`,
      );
    }
    await graph.startWorklet({ chunkSamples: this.options.chunkSamples }, (chunk) => {
      this.deliver(graph, chunk);
    });
    this.unplug = graph.connect(stream);
    await graph.resume();
  }

  /**
   * Feeds `stream` into the same worklet node in place of the current one, then ends the old
   * stream's tracks (MicRecovery's swap after a device change).
   */
  replaceStream(stream: S): void {
    const graph = this.graph;
    const unplugOld = this.unplug;
    if (graph === null || unplugOld === null) throw new Error('The capture is not running');
    // The new stream first: unplugging the old one first would leave quanta with no input, a gap
    // the worklet then has to close its chunk over (PcmChunker).
    this.unplug = graph.connect(stream);
    unplugOld();
    stopTracks(this.stream);
    this.stream = stream;
  }

  async stop(): Promise<void> {
    const graph = this.graph;
    graph?.flush();
    // Give the worklet one render quantum to post its last partial chunk before the graph goes away.
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.unplug?.();
    this.unplug = null;
    stopTracks(this.stream);
    this.stream = null;
    this.graph = null;
    await graph?.close();
  }

  private deliver(graph: CaptureGraph<S>, { pcm, frame }: PcmWorkletChunk): void {
    // The clocks are read per chunk, never once per capture: a recording that lives through a
    // sleep would drift (captureClock.ts).
    const capturedAtMs = frameCapturedAtMs(
      frame,
      graph.sampleRate,
      graph.readClock(),
      this.pageClock(),
    );
    this.options.onChunk(pcm, capturedAtMs);
  }
}

/** The graph on a real AudioContext. */
export function createBrowserGraph(sampleRate: number): CaptureGraph<MediaStream> {
  const context = new AudioContext({ sampleRate });
  let node: AudioWorkletNode | null = null;
  return {
    sampleRate: context.sampleRate,
    async startWorklet(options, onChunk) {
      await detachFromOutputDevice(context);
      await context.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: options,
      });
      node = worklet;
      worklet.port.onmessage = (event: MessageEvent<PcmWorkletChunk>) => {
        onChunk(event.data);
      };
      // A muted path to the destination keeps Chromium pulling audio through the worklet.
      const silent = context.createGain();
      silent.gain.value = 0;
      worklet.connect(silent).connect(context.destination);
    },
    connect(stream) {
      if (node === null) throw new Error('The worklet is not running');
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      return () => {
        source.disconnect();
      };
    },
    flush() {
      const flush: PcmWorkletCommand = 'flush';
      node?.port.postMessage(flush);
    },
    readClock: () => ({
      outputTimestamp: context.getOutputTimestamp(),
      currentTime: context.currentTime,
    }),
    async resume() {
      if (context.state === 'suspended') await context.resume();
    },
    async close() {
      node?.disconnect();
      node = null;
      if (context.state !== 'closed') await context.close();
    },
  };
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
