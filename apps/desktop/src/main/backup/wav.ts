import { closeSync, fstatSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { errorMessage } from '../logger';

/**
 * The WAV files of the local audio backup (M2 D5): 16 kHz mono PCM16, the samples exactly as main
 * receives them (`PCM_SAMPLE_RATE`, `linear16`), behind the canonical 44-byte header. The writer
 * puts the header down first with both sizes 0 and appends samples after it, so a crash mid-call
 * leaves a file whose samples are all there and whose sizes are wrong: `repairWavFile` rewrites
 * them from the file's size at the next launch. That is why the backup is WAV while recording
 * (crash-safe) and AAC only once a file is closed (AudioCompressor).
 *
 * bench/core/wav.ts (M3's bench) reads these files and keeps its own copy of the header code from
 * before this file existed; the M3 plan asks it to import this one instead.
 */

/** RIFF header, a 16-byte `fmt ` chunk, and the `data` chunk's id and size. */
export const WAV_HEADER_BYTES = 44;

/** Int16 mono: one sample is two bytes. */
const BYTES_PER_SAMPLE = 2;
const WAVE_FORMAT_PCM = 1;
/** The RIFF size field is 32 bits and counts everything after itself. */
const MAX_DATA_BYTES = 0xffff_ffff - (WAV_HEADER_BYTES - 8);

/** The header of a backup WAV holding `dataBytes` of samples. */
export function wavHeader(dataBytes: number): Buffer {
  if (!Number.isInteger(dataBytes) || dataBytes < 0 || dataBytes % BYTES_PER_SAMPLE !== 0) {
    throw new RangeError(`WAV data must be whole Int16 samples, not ${dataBytes} bytes.`);
  }
  if (dataBytes > MAX_DATA_BYTES) {
    // writeUInt32LE would refuse it anyway, but with no word of why.
    throw new RangeError(`WAV data of ${dataBytes} bytes does not fit a RIFF file (4 GiB).`);
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** How long `dataBytes` of backup samples play. */
export function wavDataBytesToMs(dataBytes: number): number {
  return (dataBytes / BYTES_PER_SAMPLE / PCM_SAMPLE_RATE) * 1_000;
}

export interface RepairedWav {
  /** Bytes of samples the file now holds, whole samples only. */
  dataBytes: number;
  /** The file's size after the repair. */
  bytes: number;
}

/**
 * Makes a backup WAV a crash left open readable again: its header is written afresh for the whole
 * samples on disk, and a half sample at the end is cut off. A file torn inside its header holds no
 * samples and becomes an empty WAV. A file that was closed properly comes out the same.
 *
 * Only for files this backup wrote: the header is rewritten as 16 kHz mono PCM16 whatever it said,
 * so another WAV (a `FLLR` chunk, another rate) would be corrupted rather than repaired. Throws
 * with the path when the file cannot be opened or written.
 */
export function repairWavFile(path: string): RepairedWav {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    throw new Error(`could not open the backup WAV ${path} to repair it: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  try {
    const size = fstatSync(fd).size;
    const samples = Math.max(0, size - WAV_HEADER_BYTES);
    const dataBytes = samples - (samples % BYTES_PER_SAMPLE);
    const bytes = WAV_HEADER_BYTES + dataBytes;
    if (size !== bytes) ftruncateSync(fd, bytes);
    writeSync(fd, wavHeader(dataBytes), 0, WAV_HEADER_BYTES, 0);
    return { dataBytes, bytes };
  } catch (error) {
    throw new Error(`could not repair the backup WAV ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    closeSync(fd);
  }
}
