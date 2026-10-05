import type { AudioSource } from './transcript';

/** The capture state machine owned by the main process. */
export type CapturePhase = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the renderer reports about a MediaStream track. */
export type AudioSourceState = 'active' | 'ended' | 'error';

/**
 * `stalled`: recording, but no PCM chunk from this source for NO_AUDIO_WARNING_MS (a dead track, a
 * missing permission, a stuck worklet). Main sets it and clears it on the next chunk.
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

export type SttStreamState = 'closed' | 'connecting' | 'open' | 'error';

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
  /** Final segments stored locally in this session. */
  segmentsStored: number;
  /** Final segments this session that the local store refused (shown live, not saved). */
  segmentsUnsaved: number;
  upload: UploadStatus;
  /** Last error worth showing the user, or null. */
  error: string | null;
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
    segmentsStored: 0,
    segmentsUnsaved: 0,
    upload,
    error: null,
  };
}
