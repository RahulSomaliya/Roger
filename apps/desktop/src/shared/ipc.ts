import type { CaptureStatus, AudioSourceState } from './capture';
import type { AudioSource, InterimTranscript, TranscriptSegment } from './transcript';

/**
 * The IPC contract between renderer and main. Channel names live here once; the preload
 * bridges them into `window.roger`, the main process registers handlers for them.
 */
export const IpcChannel = {
  /** renderer → main, invoke */
  CaptureStart: 'capture:start',
  CaptureStop: 'capture:stop',
  CaptureGetStatus: 'capture:get-status',
  AudioGetSystemSource: 'audio:get-system-source',
  /** renderer → main, fire and forget */
  AudioChunk: 'audio:chunk',
  AudioSourceState: 'audio:source-state',
  /** main → renderer events */
  CaptureStatusChanged: 'capture:status-changed',
  TranscriptSegment: 'transcript:segment',
  TranscriptInterim: 'transcript:interim',
} as const;

/** Sample rate every PCM chunk crossing IPC must have. Vendors are configured to match. */
export const PCM_SAMPLE_RATE = 16_000;

export interface AudioChunkMessage {
  source: AudioSource;
  /** Int16 little-endian mono PCM at PCM_SAMPLE_RATE. */
  pcm: ArrayBuffer;
}

export interface AudioSourceStateMessage {
  source: AudioSource;
  state: AudioSourceState;
  message?: string;
}

export type Unsubscribe = () => void;

/** What the renderer sees as `window.roger`. */
export interface RogerApi {
  startCapture(): Promise<CaptureStatus>;
  stopCapture(): Promise<CaptureStatus>;
  getCaptureStatus(): Promise<CaptureStatus>;
  /** A desktopCapturer source id for system audio, or null when none is available. */
  getSystemAudioSourceId(): Promise<string | null>;
  sendAudioChunk(message: AudioChunkMessage): void;
  reportAudioSourceState(message: AudioSourceStateMessage): void;
  onCaptureStatus(listener: (status: CaptureStatus) => void): Unsubscribe;
  onTranscriptSegment(listener: (segment: TranscriptSegment) => void): Unsubscribe;
  onTranscriptInterim(listener: (interim: InterimTranscript) => void): Unsubscribe;
}
