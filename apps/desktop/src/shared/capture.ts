import type { AudioSource } from './transcript';

/** The capture state machine owned by the main process. */
export type CapturePhase = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the renderer reports about a MediaStream track. */
export type AudioSourceState = 'active' | 'ended' | 'error';

/**
 * `stalled`: recording, but no PCM chunk at all from this source for NO_AUDIO_WARNING_MS (the
 * renderer, its worklet or the IPC path stopped). A live track of silence still sends chunks and
 * stays `active` until M2's silence warning. Main sets it and clears it on the next chunk.
 */
export type SourceHealth = 'pending' | 'active' | 'stalled' | 'ended' | 'error';

/** How long a recording source may go without a single chunk before it is shown as stalled. */
export const NO_AUDIO_WARNING_MS = 5_000;

/** How the UI and user-facing errors name each stream. */
export const AUDIO_SOURCE_LABEL: Readonly<Record<AudioSource, string>> = {
  mic: 'Mic (me)',
  system: 'Call audio (them)',
};

export interface SourceStatus {
  health: SourceHealth;
  /** PCM chunks received from the renderer in this session. */
  chunks: number;
  /** Epoch ms of the last chunk, or null. */
  lastChunkAt: number | null;
  message: string | null;
}

/**
 * A source's speech-to-text session. Only `connecting` and `open` hold a socket the vendor bills.
 * - closed: none (before Start, after Stop, or the source failed or ended)
 * - paused: closed because the source sent no audio for the stall window; its next chunk reopens it
 * - retrying: the vendor ended it, or the open budget is full; reopens with audio after a wait
 * - error: ended and will not reopen this meeting; `streamMessages` says why
 */
export type SttStreamState = 'closed' | 'connecting' | 'open' | 'paused' | 'retrying' | 'error';

export interface UploadStatus {
  state: 'idle' | 'uploading' | 'backoff';
  /** Segments saved locally that are not yet in Postgres. */
  pending: number;
  /** Segments the API rejected as invalid. They stay local and never block the queue. */
  rejected: number;
  lastError: string | null;
  /** Epoch ms of the next attempt while backing off. */
  nextAttemptAt: number | null;
}

export interface CaptureStatus {
  phase: CapturePhase;
  meetingId: string | null;
  /** ISO 8601 instant, UTC. */
  startedAt: string | null;
  sttProvider: string | null;
  sources: Record<AudioSource, SourceStatus>;
  streams: Record<AudioSource, SttStreamState>;
  /** Why a source's session is not open (paused, failed), or null. */
  streamMessages: Record<AudioSource, string | null>;
  /** Final segments stored locally in this session. */
  segmentsStored: number;
  /** Final segments this session that the local store refused (shown live, not saved). */
  segmentsUnsaved: number;
  upload: UploadStatus;
  /** Last error worth showing the user, or null. */
  error: string | null;
  /**
   * Why Roger stopped the last recording on its own (no speech, the length cap, quit, sleep, the
   * window closing or crashing), or null. Cleared by the next Start.
   */
  notice: string | null;
}

export function emptySourceStatus(): SourceStatus {
  return { health: 'pending', chunks: 0, lastChunkAt: null, message: null };
}

export function idleCaptureStatus(upload: UploadStatus): CaptureStatus {
  return {
    phase: 'idle',
    meetingId: null,
    startedAt: null,
    sttProvider: null,
    sources: { mic: emptySourceStatus(), system: emptySourceStatus() },
    streams: { mic: 'closed', system: 'closed' },
    streamMessages: { mic: null, system: null },
    segmentsStored: 0,
    segmentsUnsaved: 0,
    upload,
    error: null,
    notice: null,
  };
}
