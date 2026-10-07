import type { CaptureStatus } from '../../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../../shared/ipc';
import type { CaptureApi } from '../../../shared/ipc/capture';
import type { AudioSource } from '../../../shared/transcript';
import { type DeviceWatch, MicRecovery } from './MicRecovery';
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
const CALL_AUDIO_GIVEN_UP = 'Call audio stopped earlier in this meeting';

export interface AudioStartResult {
  /** Null when the system stream is running; otherwise why it is not. The mic failing throws. */
  systemAudioError: string | null;
}

/** One source's running capture, as the controller uses it (PcmStreamCapture). */
export interface SourceCapture<S> {
  start(stream: S): Promise<void>;
  /** Feeds another stream into the same worklet and ends the old one (MicRecovery's swap). */
  replaceStream(stream: S): void;
  stop(): Promise<void>;
}

/** What the controller takes from the browser. Tests pass fakes: node has no getUserMedia. */
export interface CaptureDevices<S extends CaptureStream> {
  /** The device list and its devicechange event, which MicRecovery follows. */
  mediaDevices: DeviceWatch;
  openMicrophone(): Promise<S>;
  openSystemAudio(sourceId: string): Promise<S>;
  createCapture(options: PcmStreamCaptureOptions): SourceCapture<S>;
}

/** The real devices: getUserMedia, and a capture on a real AudioContext. */
export function browserCaptureDevices(): CaptureDevices<MediaStream> {
  const { mediaDevices } = navigator;
  return {
    mediaDevices,
    openMicrophone: () => openMicrophoneStream(mediaDevices),
    openSystemAudio: (sourceId) => openSystemAudioStream(sourceId, mediaDevices),
    createCapture: (options) => new PcmStreamCapture(options, createBrowserGraph),
  };
}

/** What capture here follows of main's status. */
export type MainCapture = Pick<CaptureStatus, 'phase' | 'meetingId' | 'sources' | 'systemCapture'>;

/**
 * Whether this page opens call audio: only on Electron's path. From M2-T10 the helper's tap runs
 * in main, and a second call audio stream beside it would send main the call twice. No field is a
 * main from before M2-T10, where Electron's path is the only one; null is a main that has not
 * said, and a guess could double the call.
 */
function opensCallAudio(status: MainCapture): boolean {
  return status.systemCapture === undefined || status.systemCapture === 'electron';
}

/**
 * Main closed this source's session for the meeting (G1: it failed or ended) and never reopens it,
 * so a capture opened for it here (a page reloaded mid-recording) would stream into nothing until
 * Stop. Only a new Start resets it.
 */
function mainGaveUpOn(status: MainCapture, source: AudioSource): boolean {
  const { health } = status.sources[source];
  return health === 'error' || health === 'ended';
}

/** Runs both renderer-side captures and ships their chunks to main through the IPC contract. */
export class AudioCaptureController<S extends CaptureStream = MediaStream> {
  private readonly captures = new Map<AudioSource, SourceCapture<S>>();
  /** Follows the mic through device changes while it captures. */
  private micRecovery: MicRecovery<S> | null = null;
  /**
   * Bumped by every stop, so a start still in flight when main stopped (sleep, no speech) stops
   * the source it was opening and starts no other, instead of running on with main idle.
   */
  private generation = 0;
  /** The start in flight: a second start joins it, or the mic would be opened twice. */
  private starting: Promise<AudioStartResult> | null = null;
  /** Every stop still finishing: a start waits, or an old capture's last chunk would follow. */
  private stopping: Promise<void> = Promise.resolve();
  /** What the running capture's start answered, for a start that finds it running. */
  private lastStart: AudioStartResult = { systemAudioError: null };
  /** The meeting the capture runs for, as main named it when it started. */
  private meetingId: string | null = null;
  /** The meeting whose mic failed here: followMain leaves it shut, since main has the error. */
  private micFailedFor: { meetingId: string | null } | null = null;
  /**
   * Set by stop(), the person's Stop (or a failed Start) that main is about to follow: until main
   * says idle, its status still says recording (a stop takes seconds to finish the sessions), and
   * followMain must not open the mic again in between.
   */
  private stoppedUntilIdle = false;

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
   *
   * And while main records, the mic captures (M2-T12): a page loaded mid-recording (a reload, the
   * reload after a renderer crash, a resume at launch) or a mic stopped since opens it again here.
   * Until its chunks come, main's stall close shuts the mic's vendor session after 30 s (G2), and
   * the first chunk reopens it.
   */
  followMain(status: MainCapture): void {
    if (status.phase === 'idle') {
      this.stoppedUntilIdle = false;
      void this.stopCaptures();
      return;
    }
    if (status.phase !== 'recording' || !this.shouldOpenMic(status)) return;
    this.start(status).catch((error: unknown) => {
      // Main shows it as the mic's error and closes the mic's session (G1); call audio goes on.
      this.roger.reportAudioSourceState({
        source: 'mic',
        state: 'error',
        message: describeMediaError(error),
      });
    });
  }

  /**
   * Starts capture for the recording `status` describes: the mic (its failure throws) and, on
   * Electron's path, call audio. Never on top of a capture, since two on one source would send
   * main the same audio twice: it joins a start in flight and keeps a running capture.
   */
  start(status: MainCapture): Promise<AudioStartResult> {
    this.stoppedUntilIdle = false;
    if (this.starting !== null) return this.starting;
    if (this.captures.has('mic')) return Promise.resolve(this.lastStart);
    // The stop takes whatever ran without its mic, and bumps the generation before it awaits, so
    // this start is the current one from here on.
    const leftovers = this.stopCaptures();
    const generation = this.generation;
    const starting = this.open(status, generation, leftovers).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /** The person's Stop, or a Start that failed: main stops next, and nothing reopens until then. */
  stop(): Promise<void> {
    this.stoppedUntilIdle = true;
    return this.stopCaptures();
  }

  private stopCaptures(): Promise<void> {
    this.generation += 1;
    this.starting = null;
    this.micRecovery?.stop();
    this.micRecovery = null;
    const captures = [...this.captures.values()];
    this.captures.clear();
    const stopping = Promise.allSettled([
      this.stopping,
      ...captures.map((capture) => capture.stop()),
    ]).then(() => undefined);
    this.stopping = stopping;
    return stopping;
  }

  /**
   * Main records and the mic does not capture. Not while a start runs (statuses join it), not
   * between the person's Stop and main going idle (stoppedUntilIdle), not for a mic main gave up
   * on this meeting (mainGaveUpOn), and not again for one that failed here: main sends a status
   * every second while it records, and each would open the mic again. Call audio is gated the
   * same way in open().
   */
  private shouldOpenMic(status: MainCapture): boolean {
    if (this.stoppedUntilIdle || this.captures.has('mic') || this.starting !== null) return false;
    if (mainGaveUpOn(status, 'mic')) return false;
    return this.micFailedFor?.meetingId !== status.meetingId;
  }

  private async open(
    status: MainCapture,
    generation: number,
    leftovers: Promise<void>,
  ): Promise<AudioStartResult> {
    await leftovers;
    this.meetingId = status.meetingId;
    try {
      if (!(await this.startMic(generation))) return { systemAudioError: STOPPED_WHILE_STARTING };
    } catch (error) {
      this.micFailedFor = { meetingId: status.meetingId };
      throw error;
    }
    let result: AudioStartResult = { systemAudioError: null };
    if (opensCallAudio(status)) {
      result = mainGaveUpOn(status, 'system')
        ? { systemAudioError: CALL_AUDIO_GIVEN_UP }
        : await this.startCallAudio(generation);
    }
    this.lastStart = result;
    return result;
  }

  /** Call audio on Electron's path; a failure is reported to main, and the mic goes on. */
  private async startCallAudio(generation: number): Promise<AudioStartResult> {
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
        if (started === null) return { systemAudioError: STOPPED_WHILE_STARTING };
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

  /**
   * The mic, with MicRecovery following it through device changes. False when main stopped while
   * it was starting (it stopped).
   */
  private async startMic(generation: number): Promise<boolean> {
    const started = await this.startSource('mic', generation, () => this.devices.openMicrophone());
    if (started === null) return false;
    const { capture, stream } = started;
    const recovery = new MicRecovery<S>({
      mediaDevices: this.devices.mediaDevices,
      acquire: () => this.devices.openMicrophone(),
      swap: (next) => {
        capture.replaceStream(next);
      },
      onSwitched: (device) => {
        // ASSUMES main makes this the "Switched to <device>" notice (CaptureStatus.notices, kind
        // `device-switched`). Until it does, main reads `active` and drops the message: the
        // switch is not a warning either way, and the chunks carry on in the same session.
        this.roger.reportAudioSourceState({
          source: 'mic',
          state: 'active',
          message: `Switched to ${device}`,
        });
      },
      onFailed: (error) => {
        this.micFailed(capture, error);
      },
    });
    // Set before the await: a stop() meanwhile stops it too.
    this.micRecovery = recovery;
    await recovery.start(stream);
    return generation === this.generation;
  }

  /**
   * MicRecovery gave up: the mic's permission is gone. Main closes the mic's session (G1) and
   * shows the error; call audio goes on.
   */
  private micFailed(capture: SourceCapture<S>, error: unknown): void {
    if (this.captures.get('mic') !== capture) return;
    this.captures.delete('mic');
    this.micRecovery = null;
    this.micFailedFor = { meetingId: this.meetingId };
    this.roger.reportAudioSourceState({
      source: 'mic',
      state: 'error',
      message: describeMediaError(error),
    });
    // As in stop(): the device is let go of either way, and the next start waits for it.
    this.stopping = Promise.allSettled([this.stopping, capture.stop()]).then(() => undefined);
  }

  /** The capture once the source captures; null when main stopped while it was starting. */
  private async startSource(
    source: AudioSource,
    generation: number,
    open: () => Promise<S>,
  ): Promise<{ capture: SourceCapture<S>; stream: S } | null> {
    const capture = this.devices.createCapture({
      source,
      sampleRate: PCM_SAMPLE_RATE,
      chunkSamples: CHUNK_SAMPLES,
      onChunk: (pcm, capturedAtMs) => {
        this.roger.sendAudioChunk({ source, pcm, capturedAtMs });
      },
    });
    const stream = await open();
    // Call audio: listen before the awaits below, so a track that ends during setup is reported
    // too. Main shows it on that source's row, names the stream in the error and closes its
    // session. Never the mic's: MicRecovery reacquires an ended mic, and main told `ended` would
    // close the mic's session for the rest of the meeting (G1).
    if (source === 'system') {
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        // A capture main stopped since ended its own tracks; that is no news for main.
        if (generation !== this.generation) return;
        this.roger.reportAudioSourceState({
          source,
          state: 'ended',
          message: 'The audio device stopped delivering audio',
        });
      });
    }
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
      return null;
    }
    this.captures.set(source, capture);
    this.roger.reportAudioSourceState({ source, state: 'active' });
    return { capture, stream };
  }
}
