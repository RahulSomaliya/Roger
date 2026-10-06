import { readFile } from 'node:fs/promises';
import { PCM_SAMPLE_RATE } from '../../src/shared/ipc';
import { writePrivateFile } from './files';

/**
 * WAV files of the standing test set (`mic.wav`, `system.wav`): 16 kHz mono PCM16, the one format
 * the app streams to every vendor (`PCM_SAMPLE_RATE`, `linear16`).
 *
 * The reader refuses every other format with a message that names what it found, and never
 * resamples or downmixes. The replay sends these samples to the vendor as 16 kHz mono; a vendor
 * told that but sent 48 kHz or interleaved stereo transcribes garbage and reports no error, so a
 * wrong clip would score the vendor on noise. `listen.wav` (stereo, for the owner's ears) is
 * written by `encodeStereoWav` and is refused here on purpose: it can never be scored by mistake.
 *
 * M2-T15's audio backup has its own WAV code (`src/main/backup/wav.ts`, not landed when this was
 * written). When it lands, import its header code here instead of keeping two copies (M3 plan,
 * "Notes for the builders").
 */

/** The only sample rate bench audio may have. */
export const WAV_SAMPLE_RATE = PCM_SAMPLE_RATE;

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 44;
/** The RIFF size field is 32 bits and counts everything after itself. */
const MAX_DATA_BYTES = 0xffff_ffff - (HEADER_BYTES - 8);

const FORMAT_NAMES: Readonly<Record<number, string>> = {
  2: 'Microsoft ADPCM',
  3: 'IEEE float',
  6: 'A-law',
  7: 'mu-law',
  17: 'IMA ADPCM',
};

const EXPECTED = 'bench audio must be 16 kHz mono PCM16';
const CONVERT_HINT = 'convert it with: afconvert -f WAVE -d LEI16@16000 -c 1 <in> <out.wav>';

/** A WAV file the bench cannot use. The message starts with the file's label (usually its path). */
export class WavFormatError extends Error {
  constructor(label: string, problem: string) {
    super(`${label}: ${problem}`);
    this.name = 'WavFormatError';
  }
}

interface FmtChunk {
  format: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/** The samples of a 16 kHz mono PCM16 WAV file. `label` names the file in every error. */
export function decodeWav(bytes: Uint8Array, label: string): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) {
    throw new WavFormatError(label, 'not a WAV file (too short for a RIFF header)');
  }
  const riff = fourCc(bytes, 0);
  if (riff === 'RIFX') {
    throw new WavFormatError(label, `big-endian WAV (RIFX) is not supported; ${CONVERT_HINT}`);
  }
  if (riff !== 'RIFF' || fourCc(bytes, 8) !== 'WAVE') {
    throw new WavFormatError(label, 'not a WAV file (no RIFF/WAVE header)');
  }

  let fmt: FmtChunk | null = null;
  let data: { offset: number; bytes: number } | null = null;
  // Chunks are walked, never assumed at fixed offsets: afconvert writes a `FLLR` padding chunk
  // before `data`, and other tools add `LIST` or `fact`.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = fourCc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = readFmt(view, body, size, label);
    } else if (id === 'data') {
      const available = bytes.length - body;
      if (size > available) {
        throw new WavFormatError(
          label,
          `the data chunk says ${size} bytes but only ${available} follow; the file is cut short`,
        );
      }
      data = { offset: body, bytes: size };
      break;
    }
    // A chunk with an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }

  if (fmt === null) throw new WavFormatError(label, 'no fmt chunk');
  if (data === null) throw new WavFormatError(label, 'no data chunk');
  checkFormat(fmt, label);
  if (data.bytes % BYTES_PER_SAMPLE !== 0) {
    throw new WavFormatError(label, `the data chunk holds ${data.bytes} bytes, not whole samples`);
  }

  const samples = new Int16Array(data.bytes / BYTES_PER_SAMPLE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(data.offset + index * BYTES_PER_SAMPLE, true);
  }
  return samples;
}

/** A 16 kHz mono PCM16 WAV file of these samples. */
export function encodeWav(samples: Int16Array): Uint8Array {
  return encodePcm16(samples, 1);
}

/**
 * A 16 kHz stereo PCM16 WAV file, `left` and `right` interleaved; the shorter channel is padded
 * with silence. Only for `listen.wav` (mic left, system right), which the owner plays while fixing
 * a reference. `decodeWav` refuses it, so it is never scored.
 */
export function encodeStereoWav(left: Int16Array, right: Int16Array): Uint8Array {
  const frames = Math.max(left.length, right.length);
  const interleaved = new Int16Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    interleaved[frame * 2] = left[frame] ?? 0;
    interleaved[frame * 2 + 1] = right[frame] ?? 0;
  }
  return encodePcm16(interleaved, 2);
}

/** Read a bench WAV file; errors name the path. */
export async function readWav(path: string): Promise<Int16Array> {
  return decodeWav(await readFile(path), path);
}

/** Write a 16 kHz mono PCM16 WAV file, readable by its owner only. */
export async function writeWav(path: string, samples: Int16Array): Promise<void> {
  await writePrivateFile(path, encodeWav(samples));
}

function readFmt(view: DataView, body: number, size: number, label: string): FmtChunk {
  if (size < 16 || body + size > view.byteLength) {
    throw new WavFormatError(label, `the fmt chunk is ${size} bytes; it needs at least 16`);
  }
  let format = view.getUint16(body, true);
  // WAVE_FORMAT_EXTENSIBLE keeps the real format code in the first two bytes of its subformat
  // GUID. Plain PCM16 written this way is still PCM16.
  if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
  return {
    format,
    channels: view.getUint16(body + 2, true),
    sampleRate: view.getUint32(body + 4, true),
    blockAlign: view.getUint16(body + 12, true),
    bitsPerSample: view.getUint16(body + 14, true),
  };
}

function checkFormat(fmt: FmtChunk, label: string): void {
  if (fmt.format !== WAVE_FORMAT_PCM) {
    const name = FORMAT_NAMES[fmt.format];
    const code = name === undefined ? `${fmt.format}` : `${fmt.format} (${name})`;
    throw new WavFormatError(label, `format code ${code}, not PCM; ${EXPECTED}; ${CONVERT_HINT}`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new WavFormatError(
      label,
      `${fmt.bitsPerSample}-bit samples; ${EXPECTED}; ${CONVERT_HINT}`,
    );
  }
  if (fmt.channels !== 1) {
    throw new WavFormatError(label, `${fmt.channels} channels; ${EXPECTED}; ${CONVERT_HINT}`);
  }
  if (fmt.sampleRate !== WAV_SAMPLE_RATE) {
    throw new WavFormatError(label, `${fmt.sampleRate} Hz audio; ${EXPECTED}; ${CONVERT_HINT}`);
  }
  if (fmt.blockAlign !== BYTES_PER_SAMPLE) {
    throw new WavFormatError(label, `block align ${fmt.blockAlign}; ${EXPECTED}`);
  }
}

function encodePcm16(samples: Int16Array, channels: 1 | 2): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  if (dataBytes > MAX_DATA_BYTES) {
    // DataView.setUint32 would wrap the size field silently and write a file no tool can read.
    throw new RangeError(`WAV data of ${dataBytes} bytes does not fit a RIFF file (4 GiB)`);
  }
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeFourCc(bytes, 0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeFourCc(bytes, 8, 'WAVE');
  writeFourCc(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * channels * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeFourCc(bytes, 36, 'data');
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => {
    view.setInt16(HEADER_BYTES + index * BYTES_PER_SAMPLE, sample, true);
  });
  return bytes;
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function writeFourCc(bytes: Uint8Array, offset: number, id: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = id.charCodeAt(index);
}
