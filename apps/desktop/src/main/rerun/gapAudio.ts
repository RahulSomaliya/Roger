import { accessSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource } from '../../shared/transcript';
import { AFCONVERT, type RunTool, runTool } from '../backup/AudioCompressor';
import { resolveStoredAudioPath } from '../backup/audioPaths';
import type { Logger } from '../logger';
import type { AudioFile, TranscriptStore } from '../store/TranscriptStore';

/**
 * afconvert's arguments that turn a backup m4a back into what the vendor is sent: WAVE, Int16
 * little-endian at 16 kHz (M2-T16). The input and output paths follow. gapAudio.mac.test.ts runs
 * this exact command on the backup fixture's m4a.
 */
export const M4A_DECODE_ARGS: readonly string[] = ['-f', 'WAVE', '-d', `LEI16@${PCM_SAMPLE_RATE}`];

/** A 60 s chunk decodes in well under a second; this only stops a hung afconvert. */
const DECODE_TIMEOUT_MS = 60_000;

const SAMPLES_PER_MS = PCM_SAMPLE_RATE / 1_000;
const BYTES_PER_SAMPLE = 2;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * How often a file is looked up again after its audio was not where its row said. Once covers the
 * compressor's move (AudioCompressor: the row names the m4a before the WAV goes); the rest is
 * slack for a second move that cannot happen today.
 */
const MAX_LOOKUPS = 3;

/** A stretch of one source's backup audio, as the vendor is sent it. */
export interface GapAudioPiece {
  /** Meeting offset of the first sample. */
  startMs: number;
  /** Int16 little-endian mono at PCM_SAMPLE_RATE, its own copy. */
  pcm: Uint8Array;
}

/** Ms of audio the pieces hold inside `[fromMs, toMs]`: 0 means the backup holds none of it. */
export function heldMs(pieces: readonly GapAudioPiece[], fromMs: number, toMs: number): number {
  let held = 0;
  for (const piece of pieces) {
    const endMs = piece.startMs + piece.pcm.byteLength / BYTES_PER_SAMPLE / SAMPLES_PER_MS;
    held += Math.max(0, Math.min(endMs, toMs) - Math.max(piece.startMs, fromMs));
  }
  return held;
}

export interface GapAudioReaderOptions {
  store: Pick<TranscriptStore, 'listAudioFiles'>;
  /** The app's data folder: `audio_files.path` is relative to it. */
  userData: string;
  logger: Logger;
  /** afconvert's runner (AudioCompressor's). */
  run?: RunTool;
}

/**
 * Reads a window of one source's audio back from the local backup (M2 D5) for the gap re-run: the
 * files that overlap it, in start order, each cut to the window. A WAV is read as it lies; an m4a
 * is decoded with afconvert into a private temp folder first (M4A_DECODE_ARGS). Pieces keep the
 * holes between files: one source's files never span a timeline run, so a hole is audio that was
 * never captured, and the caller maps the vendor's times back through each piece's own start.
 *
 * Trap: the compressor switches a row to its m4a before it deletes the WAV, so between this
 * reader's read of the rows and its open of a WAV the WAV can be gone. That is never "no audio":
 * the row is read again (AudioCompressor's header says the same). A row gone too means the
 * meeting's audio was deleted (by the user or retention): that file holds nothing.
 */
export class GapAudioReader {
  private readonly run: RunTool;

  constructor(private readonly options: GapAudioReaderOptions) {
    this.run = options.run ?? runTool;
  }

  /**
   * The source's audio in `[fromMs, toMs]` (meeting offsets), oldest first; empty when the backup
   * holds none of it. Throws, naming the file, when a file is there but cannot be read or decoded.
   */
  async read(
    meetingId: string,
    source: AudioSource,
    fromMs: number,
    toMs: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<GapAudioPiece[]> {
    const files = this.options.store
      .listAudioFiles(meetingId)
      .filter((file) => file.source === source && overlaps(file, fromMs, toMs));
    const pieces: GapAudioPiece[] = [];
    for (const file of files) {
      const samples = await this.samplesOf(meetingId, file, signal);
      if (samples === null) continue;
      const first = Math.max(0, Math.round((fromMs - file.startMs) * SAMPLES_PER_MS));
      const last = Math.min(
        samples.byteLength / BYTES_PER_SAMPLE,
        Math.round((toMs - file.startMs) * SAMPLES_PER_MS),
      );
      if (last <= first) continue;
      pieces.push({
        startMs: file.startMs + first / SAMPLES_PER_MS,
        // A copy: the vendor's adapter reads it as Int16 over its own buffer.
        pcm: samples.slice(first * BYTES_PER_SAMPLE, last * BYTES_PER_SAMPLE),
      });
    }
    return pieces;
  }

  /** The file's samples, or null when its audio is gone for good (see the class comment). */
  private async samplesOf(
    meetingId: string,
    listed: AudioFile,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    let file = listed;
    for (let lookup = 1; ; lookup += 1) {
      const path = resolveStoredAudioPath(this.options.userData, file.path);
      try {
        return file.format === 'wav'
          ? wavSamples(readFileSync(path), path)
          : await this.decode(path, signal);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const again = this.options.store.listAudioFiles(meetingId).find((row) => row.id === file.id);
      if (again === undefined || again.path === file.path || lookup === MAX_LOOKUPS) {
        this.options.logger.warn('gap re-run: a backup file is gone; its audio is skipped', {
          meetingId,
          fileId: file.id,
          deleted: again === undefined,
        });
        return null;
      }
      file = again;
    }
  }

  /** An m4a decoded to the vendor's format in a folder only this user can read, then removed. */
  private async decode(m4a: string, signal: AbortSignal): Promise<Uint8Array> {
    // Before afconvert, whose failure for a missing input carries no ENOENT to tell it apart.
    accessSync(m4a);
    // mkdtemp makes the folder 0700: the decoded call stays private while it exists.
    const folder = mkdtempSync(join(tmpdir(), 'roger-rerun-'));
    try {
      const wav = join(folder, 'decoded.wav');
      await this.run(AFCONVERT, [...M4A_DECODE_ARGS, m4a, wav], {
        timeoutMs: DECODE_TIMEOUT_MS,
        signal,
      });
      return wavSamples(readFileSync(wav), m4a);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

function overlaps(file: AudioFile, fromMs: number, toMs: number): boolean {
  // A file never closed has no end yet: AudioBackup.start() repairs those before the re-run reads.
  return file.startMs < toMs && (file.endMs === null || file.endMs > fromMs);
}

/**
 * The samples of a WAV that must hold what the vendor is sent: PCM16 mono at PCM_SAMPLE_RATE. It
 * walks the chunks: the backup's own WAVs have the canonical 44-byte header, afconvert's output a
 * `FLLR` chunk before `data`. Throws, naming `name`, on anything else: a vendor sent audio at
 * another rate transcribes garbage and reports no error (stt/streamSettings.ts).
 */
export function wavSamples(bytes: Buffer, name: string): Uint8Array {
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${name} is not a WAV file.`);
  }
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      const tag = bytes.readUInt16LE(body);
      format = {
        // afconvert writes WAVE_FORMAT_EXTENSIBLE (0xFFFE) even for mono PCM16: the real format is
        // the first two bytes of its sub-format GUID, 24 bytes into the chunk. Read as the plain
        // tag, every decoded m4a was refused as "format 65534" (gapAudio.mac.test.ts).
        tag:
          tag === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= bytes.length
            ? bytes.readUInt16LE(body + 24)
            : tag,
        channels: bytes.readUInt16LE(body + 2),
        rate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (format === null) throw new Error(`${name} has its audio before its format.`);
      if (
        format.tag !== WAVE_FORMAT_PCM ||
        format.channels !== 1 ||
        format.rate !== PCM_SAMPLE_RATE ||
        format.bits !== 16
      ) {
        throw new Error(
          `${name} holds ${format.rate} Hz, ${format.channels}-channel, ${format.bits}-bit audio ` +
            `(format ${format.tag}), not the ${PCM_SAMPLE_RATE} Hz mono PCM16 the vendor is sent.`,
        );
      }
      // A header a crash left with size 0 (AudioBackup repairs those at launch) reads to the end.
      const end = size === 0 ? bytes.length : Math.min(bytes.length, body + size);
      const whole = end - ((end - body) % BYTES_PER_SAMPLE);
      return new Uint8Array(bytes.buffer, bytes.byteOffset + body, whole - body);
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  throw new Error(`${name} holds no audio (no data chunk).`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
