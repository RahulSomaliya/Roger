import type { CapturePhase } from '../../../shared/capture';
import { PCM_SAMPLE_RATE, type RogerApi } from '../../../shared/ipc';
import type { AudioSource } from '../../../shared/transcript';
import { PcmStreamCapture, type PcmStreamCaptureOptions } from './PcmStreamCapture';
import { describeMediaError, openMicrophoneStream, openSystemAudioStream } from './sources';

/** 100 ms of audio per IPC message. */
const CHUNK_SAMPLES = PCM_SAMPLE_RATE / 10;

const STOPPED_WHILE_STARTING = 'The recording stopped while audio capture was starting';

export interface AudioStartResult {
  /** Null when the system stream is running; otherwise why it is not. The mic failing throws. */
  systemAudioError: string | null;
}

/** One source's running capture, as the controller uses it. */
export interface SourceCapture {
  start(stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
}

/** What the controller takes from the browser. Tests pass fakes: node has no getUserMedia. */
export interface CaptureDevices {
  openMicrophone(): Promise<MediaStream>;
  openSystemAudio(sourceId: string): Promise<MediaStream>;
  createCapture(options: PcmStreamCaptureOptions): SourceCapture;
}

const BROWSER_DEVICES: CaptureDevices = {
  openMicrophone: openMicrophoneStream,
  openSystemAudio: openSystemAudioStream,
  createCapture: (options) => new PcmStreamCapture(options),
};

/** Runs both renderer-side captures and ships their chunks to main through the IPC contract. */
export class AudioCaptureController {
  private readonly captures = new Map<AudioSource, SourceCapture>();
  /**
   * Bumped by stop(), so a start still in flight when main stopped (sleep, no speech) stops the
   * source it was opening and starts no other, instead of running on with main idle.
   */
  private generation = 0;

  constructor(
    private readonly roger: RogerApi,
    private readonly devices: CaptureDevices = BROWSER_DEVICES,
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
    open: () => Promise<MediaStream>,
  ): Promise<boolean> {
    const capture = this.devices.createCapture({
      source,
      sampleRate: PCM_SAMPLE_RATE,
      chunkSamples: CHUNK_SAMPLES,
      onChunk: (pcm) => {
        this.roger.sendAudioChunk({ source, pcm });
      },
      onState: (state, message) => {
        this.roger.reportAudioSourceState(
          message === undefined ? { source, state } : { source, state, message },
        );
      },
    });
    const stream = await open();
    try {
      await capture.start(stream);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await capture.stop();
      throw error;
    }
    if (generation !== this.generation) {
      // Main stopped the recording (sleep, no speech) while this source was starting.
      await capture.stop();
      return false;
    }
    this.captures.set(source, capture);
    return true;
  }
}
