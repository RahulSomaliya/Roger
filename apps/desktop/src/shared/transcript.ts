/**
 * Transcript domain types shared by main, preload and renderer.
 * Keep this file free of runtime imports: it is bundled into every process.
 */

/** Which audio stream a line came from. The two streams are never mixed. */
export type AudioSource = 'mic' | 'system';

export const AUDIO_SOURCES: readonly AudioSource[] = ['mic', 'system'];

/** Speaker label in M1. Names arrive in M9. */
export type SpeakerLabel = 'me' | 'them';

export const SPEAKER_FOR_SOURCE: Readonly<Record<AudioSource, SpeakerLabel>> = {
  mic: 'me',
  system: 'them',
};

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

/** A final transcript line. Offsets are milliseconds from the meeting start. */
export interface TranscriptSegment {
  id: string;
  meetingId: string;
  source: AudioSource;
  speaker: SpeakerLabel;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  words: TranscriptWord[] | null;
  /** ISO 8601 instant, UTC. */
  createdAt: string;
}

/** Text that may still change. Shown live, never stored. */
export interface InterimTranscript {
  meetingId: string;
  source: AudioSource;
  text: string;
  startMs: number;
  endMs: number;
}

export function isAudioSource(value: unknown): value is AudioSource {
  return value === 'mic' || value === 'system';
}
