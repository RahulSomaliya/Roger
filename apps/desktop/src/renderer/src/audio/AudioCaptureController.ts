import { PCM_SAMPLE_RATE, type RogerApi } from '../../../shared/ipc';
import type { AudioSource } from '../../../shared/transcript';
import { PcmStreamCapture } from './PcmStreamCapture';
import { describeMediaError, openMicrophoneStream, openSystemAudioStream } from './sources';

/** 100 ms of audio per IPC message. */
const CHUNK_SAMPLES = PCM_SAMPLE_RATE / 10;

export interface AudioStartResult {
  /** Null when the system stream is running; otherwise why it is not. The mic failing throws. */
  systemAudioError: string | null;
}

/** Runs both renderer-side captures and ships their chunks to main through the IPC contract. */
export class AudioCaptureController {
  private readonly captures = new Map<AudioSource, PcmStreamCapture>();

  constructor(private readonly roger: RogerApi) {}

  async start(): Promise<AudioStartResult> {
    await this.startSource('mic', openMicrophoneStream);
    const sourceId = await this.roger.getSystemAudioSourceId();
    let systemAudioError: string | null = null;
    if (sourceId === null) {
      systemAudioError = 'No screen source is available for system audio';
    } else {
      try {
        await this.startSource('system', () => openSystemAudioStream(sourceId));
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
    const captures = [...this.captures.values()];
    this.captures.clear();
    await Promise.allSettled(captures.map((capture) => capture.stop()));
  }

  private async startSource(source: AudioSource, open: () => Promise<MediaStream>): Promise<void> {
    const capture = new PcmStreamCapture({
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
    this.captures.set(source, capture);
  }
}
