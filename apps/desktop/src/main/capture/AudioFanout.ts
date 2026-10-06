import type { AudioSource } from '../../shared/transcript';
import { errorMessage, type Logger } from '../logger';

/**
 * Something that takes every chunk of recorded audio: the meeting's speech-to-text session, and
 * the M2 features that read audio without owning a vendor session (M2-T11's SignalMonitor, M2-T15's
 * backup writer). A sink only reads: it never opens or closes a vendor session (CaptureSession and
 * its guards do that, house rule 9).
 */
export interface AudioSink {
  /**
   * One chunk of one source, in the order the source captured it. `capturedAtMs` is the wall clock
   * (epoch ms) of its first sample. Called on main's event loop for every chunk, ten a second per
   * source, so it returns quickly and never waits. `pcm` is the same bytes every sink gets: read it,
   * never write to it.
   */
  onChunk(source: AudioSource, pcm: Uint8Array, capturedAtMs: number): void;
}

interface SinkEntry {
  name: string;
  /** The error of the spell this sink is failing in, or null while it takes audio. */
  failing: string | null;
  failedChunks: number;
}

/**
 * Hands every recorded chunk to every sink, so a feature that needs the audio adds a sink instead
 * of an edit to CaptureService.pushAudio. One sink that throws (a full disk under the backup) is
 * logged and skipped for that chunk; every other sink, the vendor session included, still gets it.
 */
export class AudioFanout {
  private readonly sinks = new Map<AudioSink, SinkEntry>();

  constructor(private readonly logger: Logger) {}

  /** Adds `sink` (`name` is for logs); returns its removal. Adding the same sink again is a no-op. */
  add(name: string, sink: AudioSink): () => void {
    if (!this.sinks.has(sink)) this.sinks.set(sink, { name, failing: null, failedChunks: 0 });
    return () => {
      this.sinks.delete(sink);
    };
  }

  push(source: AudioSource, pcm: Uint8Array, capturedAtMs: number): void {
    for (const [sink, entry] of this.sinks) {
      try {
        sink.onChunk(source, pcm, capturedAtMs);
      } catch (error) {
        this.failed(entry, source, errorMessage(error));
        continue;
      }
      if (entry.failing !== null) {
        this.logger.info('audio sink recovered', {
          sink: entry.name,
          failedChunks: entry.failedChunks,
        });
        entry.failing = null;
        entry.failedChunks = 0;
      }
    }
  }

  /** One log line per spell of the same error: a broken sink fails ten times a second. */
  private failed(entry: SinkEntry, source: AudioSource, error: string): void {
    entry.failedChunks += 1;
    if (entry.failing === error) return;
    entry.failing = error;
    this.logger.error('audio sink failed', { sink: entry.name, source, error });
  }
}
