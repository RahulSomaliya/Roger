import type { CapturePhase } from '../../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../../shared/ipc';
import type { CaptureApi } from '../../../shared/ipc/capture';
import type { AudioSource } from '../../../shared/transcript';
import {
  createBrowserGraph,
  PcmStreamCapture,
  type PcmStreamCaptureOptions,
} from './PcmStreamCapture';
import { describeMediaError, openMicrophoneStream, openSystemAudioStream } from './sources';
import { type CaptureStream, stopTracks } from './streams';

/** 100 ms of audio per IPC message. */
const CHUNK_SAMPLES = PCM_SAMPLE_RATE / 10;

const STOPPED_WHILE_STARTING = 'The recording stopped while audio capture was starting';

export interface AudioStartResult {
  /** Null when the system stream is running; otherwise why it is not. The mic failing throws. */
  systemAudioError: string | null;
}

/** One source's running capture, as the controller uses it (PcmStreamCapture). */
export interface SourceCapture<S> {
  start(stream: S): Promise<void>;
  stop(): Promise<void>;
}

/** What the controller takes from the browser. Tests pass fakes: node has no getUserMedia. */
export interface CaptureDevices<S extends CaptureStream> {
  openMicrophone(): Promise<S>;
  openSystemAudio(sourceId: string): Promise<S>;
  createCapture(options: PcmStreamCaptureOptions): SourceCapture<S>;
}

/** The real devices: getUserMedia, and a capture on a real AudioContext. */
export function browserCaptureDevices(): CaptureDevices<MediaStream> {
  return {
    openMicrophone: openMicrophoneStream,
    openSystemAudio: openSystemAudioStream,
    createCapture: (options) => new PcmStreamCapture(options, createBrowserGraph),
  };
}

/** Runs both renderer-side captures and ships their chunks to main through the IPC contract. */
export class AudioCaptureController<S extends CaptureStream = MediaStream> {
  private readonly captures = new Map<AudioSource, SourceCapture<S>>();
  /**
   * Bumped by stop(), so a start still in flight when main stopped (sleep, no speech) stops the
   * source it was opening and starts no other, instead of running on with main idle.
   */
  private generation = 0;

  constructor(
    // Capture's part only, not RogerApi: typed against every feature's part, this file and its test
    // fake would fail the type check whenever another feature adds a member to its own IPC module.
    private readonly roger: CaptureApi,
    private readonly devices: CaptureDevices<S>,
  ) {}

  /** True while any source captures. False while the first one is still starting. */
  get running(): boolean {
    return this.captures.size > 0;
  }

  /**
   * Main owns the recording: once it is idle, nothing here may capture, a source still starting
   * included. So every idle status stops, without asking `running`: gated on it, the stop missed a
   * mic still starting (the Mac slept during getUserMedia), which then came up with main idle and
   * kept the device on; the next Start then put a second mic capture beside it, main sent the
   * vendor the mic at twice real time (AssemblyAI closes with 3007) and each reopen spent the
   * meeting's open budget. A stop with nothing running costs nothing.
   */
  followMain(phase: CapturePhase): void {
    if (phase === 'idle') void this.stop();
  }

  async start(): Promise<AudioStartResult> {
    // Never on top of a capture: two on one source would send main the same audio twice. stop()
    // bumps the generation before it awaits, so this start is the current one from here on.
    const leftovers = this.stop();
    const generation = this.generation;
    await leftovers;
    if (!(await this.startSource('mic', generation, () => this.devices.openMicrophone()))) {
      return { systemAudioError: STOPPED_WHILE_STARTING };
    }
    const sourceId = await this.roger.getSystemAudioSourceId();
    if (generation !== this.generation) return { systemAudioError: STOPPED_WHILE_STARTING };
    let systemAudioError: string | null = null;
    if (sourceId === null) {
      systemAudioError = 'No screen source is available for system audio';
    } else {
      try {
        const started = await this.startSource('system', generation, () =>
          this.devices.openSystemAudio(sourceId),
        );
        if (!started) return { systemAudioError: STOPPED_WHILE_STARTING };
      } catch (error) {
        systemAudioError = describeMediaError(error);
      }
    }
    if (systemAudioError !== null) {
      this.roger.reportAudioSourceState({
        source: 'system',
        state: 'error',
        message: systemAudioError,
      });
    }
    return { systemAudioError };
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const captures = [...this.captures.values()];
    this.captures.clear();
    await Promise.allSettled(captures.map((capture) => capture.stop()));
  }

  /** True once the source captures; false when main stopped while it was starting (it stopped). */
  private async startSource(
    source: AudioSource,
    generation: number,
    open: () => Promise<S>,
  ): Promise<boolean> {
    const capture = this.devices.createCapture({
      source,
      sampleRate: PCM_SAMPLE_RATE,
      chunkSamples: CHUNK_SAMPLES,
      onChunk: (pcm, capturedAtMs) => {
        this.roger.sendAudioChunk({ source, pcm, capturedAtMs });
      },
    });
    const stream = await open();
    // Listen before the awaits below: a track that ends during setup must still be reported.
    // Main shows it on that source's row, names the stream in the error and closes its session.
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      // A capture main stopped since ended its own tracks; that is no news for main.
      if (generation !== this.generation) return;
      this.roger.reportAudioSourceState({
        source,
        state: 'ended',
        message: 'The audio device stopped delivering audio',
      });
    });
    try {
      await capture.start(stream);
    } catch (error) {
      stopTracks(stream);
      await capture.stop();
      throw error;
    }
    if (generation !== this.generation) {
      // Main stopped the recording (sleep, no speech) while this source was starting.
      await capture.stop();
      return false;
    }
    this.captures.set(source, capture);
    this.roger.reportAudioSourceState({ source, state: 'active' });
    return true;
  }
}
