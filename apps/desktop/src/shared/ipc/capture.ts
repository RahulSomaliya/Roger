import type {
  AudioSourceState,
  CaptureReport,
  CaptureStatus,
  TranscriptSegmentChange,
} from '../capture';
import type { AudioSource, InterimTranscript, TranscriptSegment } from '../transcript';
import type { Unsubscribe } from './unsubscribe';

/**
 * Capture's channels. Main registers them in src/main/ipc.ts and validates every renderer payload
 * in src/main/ipc-validation.ts first.
 */
export const captureChannels = {
  /** renderer → main, invoke */
  CaptureStart: 'capture:start',
  CaptureStop: 'capture:stop',
  CaptureGetStatus: 'capture:get-status',
  AudioGetSystemSource: 'audio:get-system-source',
  CaptureGetReport: 'capture:get-report',
  CaptureRerunGaps: 'capture:rerun-gaps',
  AudioDeleteMeeting: 'audio:delete-meeting',
  TranscriptUnhideSegment: 'transcript:unhide-segment',
  /** renderer → main, fire and forget */
  AudioChunk: 'audio:chunk',
  AudioSourceState: 'audio:source-state',
  /** main → renderer events */
  CaptureStatusChanged: 'capture:status-changed',
  TranscriptSegment: 'transcript:segment',
  TranscriptInterim: 'transcript:interim',
  TranscriptSegmentChanged: 'transcript:segment-changed',
} as const;

/**
 * The one audio format the renderer sends: every PCM chunk crossing IPC is PCM_ENCODING at
 * PCM_SAMPLE_RATE. The API's STT stream settings must name the same pair; main refuses to start a
 * session otherwise (src/main/stt/streamSettings.ts), because a vendor told another rate
 * transcribes garbage and reports no error.
 */
export const PCM_SAMPLE_RATE = 16_000;
/** Int16 little-endian mono, which is what the PCM worklet produces. */
export const PCM_ENCODING = 'linear16';

export interface AudioChunkMessage {
  source: AudioSource;
  /** PCM_ENCODING mono PCM at PCM_SAMPLE_RATE. */
  pcm: ArrayBuffer;
  /**
   * Wall clock (epoch ms) of the chunk's first sample, taken where it was captured: the worklet's
   * frame mapped through `AudioContext.getOutputTimestamp()` (M2-T12). Arrival times in main
   * jitter, which would split the audio timeline falsely (M2 design, "Timeline"). Main refuses a
   * chunk whose value is not finite or is more than a day from now. Optional until M2-T12 sends
   * it: main uses the arrival time when it is missing.
   */
  capturedAtMs?: number;
}

export interface AudioSourceStateMessage {
  source: AudioSource;
  state: AudioSourceState;
  message?: string;
}

/**
 * A request about one meeting. Main refuses an id that is not a lowercase UUIDv4: meeting ids
 * name folders on disk (`userData/audio/<id>`), and a renderer-supplied `../x` would otherwise be
 * a path-traversal delete.
 */
export interface MeetingRequest {
  meetingId: string;
}

/** A request about one line of a meeting; both ids are UUIDv4s, as for MeetingRequest. */
export interface SegmentRequest {
  meetingId: string;
  segmentId: string;
}

/** Capture's part of `window.roger`. */
export interface CaptureApi {
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
  /** What the echo filter did to a line (hide, trim, unhide), live or later (M2-T14b). */
  onTranscriptSegmentChanged(listener: (change: TranscriptSegmentChange) => void): Unsubscribe;
  /** What happened to a meeting's capture: gaps, events, echo counts, its audio backup. */
  getCaptureReport(request: MeetingRequest): Promise<CaptureReport>;
  /**
   * Re-runs the meeting's gaps from its audio backup (M2-T16) and answers the report after it.
   * Refused while a recording runs; progress shows in `CaptureStatus.rerun` meanwhile.
   */
  rerunGaps(request: MeetingRequest): Promise<CaptureReport>;
  /** Deletes the meeting's local audio backup (its lines stay) and answers the report after it. */
  deleteMeetingAudio(request: MeetingRequest): Promise<CaptureReport>;
  /**
   * Shows a hidden echo line again, which uploads it; a segment change event follows. Only a
   * `hidden` line: a `trimmed` one already uploads, and main's store will not unhide it
   * (TranscriptStore.unhideSegment), so offer no Unhide on trimmed text.
   */
  unhideSegment(request: SegmentRequest): Promise<void>;
}
