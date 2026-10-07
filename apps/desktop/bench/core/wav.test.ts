import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WAV_SAMPLE_RATE,
  WavFormatError,
  decodeWav,
  encodeStereoWav,
  encodeWav,
  readWav,
  writeWav,
} from './wav';

interface HeaderFields {
  format?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  /** Extra chunks written between `fmt ` and `data`, such as afconvert's `FLLR`. */
  between?: Uint8Array[];
  /** The `data` size the header claims; the real byte count when left out. */
  claimedDataBytes?: number;
  /** Bytes of a WAVE_FORMAT_EXTENSIBLE `fmt ` extension (cbSize 22). */
  extensibleSubformat?: number;
}

/**
 * A WAV file built by hand, so the refusal tests do not depend on the encoder under test.
 * `data` is copied as given.
 */
function wavBytes(data: Uint8Array, fields: HeaderFields = {}): Uint8Array {
  const channels = fields.channels ?? 1;
  const bits = fields.bitsPerSample ?? 16;
  const rate = fields.sampleRate ?? 16_000;
  const blockAlign = (channels * bits) / 8;
  const fmtSize = fields.extensibleSubformat === undefined ? 16 : 40;
  const fmt = new Uint8Array(8 + fmtSize);
  const fmtView = new DataView(fmt.buffer);
  ascii(fmt, 0, 'fmt ');
  fmtView.setUint32(4, fmtSize, true);
  fmtView.setUint16(8, fields.format ?? 1, true);
  fmtView.setUint16(10, channels, true);
  fmtView.setUint32(12, rate, true);
  fmtView.setUint32(16, rate * blockAlign, true);
  fmtView.setUint16(20, blockAlign, true);
  fmtView.setUint16(22, bits, true);
  if (fields.extensibleSubformat !== undefined) {
    fmtView.setUint16(24, 22, true);
    fmtView.setUint16(26, bits, true);
    fmtView.setUint32(28, channels === 1 ? 4 : 3, true);
    // The subformat GUID starts with the plain format code; the rest is the fixed tail.
    fmtView.setUint16(32, fields.extensibleSubformat, true);
  }
  const dataHeader = new Uint8Array(8);
  ascii(dataHeader, 0, 'data');
  new DataView(dataHeader.buffer).setUint32(4, fields.claimedDataBytes ?? data.length, true);
  const body = concat([
    fmt,
    ...(fields.between ?? []),
    dataHeader,
    data,
    data.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0),
  ]);
  const riff = new Uint8Array(12);
  ascii(riff, 0, 'RIFF');
  new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
  ascii(riff, 8, 'WAVE');
  return concat([riff, body]);
}

function chunk(id: string, size: number): Uint8Array {
  const bytes = new Uint8Array(8 + size + (size % 2));
  ascii(bytes, 0, id);
  new DataView(bytes.buffer).setUint32(4, size, true);
  return bytes;
}

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Little-endian PCM16 bytes of these samples. */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return bytes;
}

const SAMPLES = [0, 1, -1, 32_767, -32_768, 1_234, -4_321];

describe('decodeWav', () => {
  it('reads 16 kHz mono PCM16 samples', () => {
    expect(WAV_SAMPLE_RATE).toBe(16_000);
    expect([...decodeWav(wavBytes(pcm(SAMPLES)), 'mic.wav')]).toEqual(SAMPLES);
  });

  it('walks past other chunks, such as the FLLR padding afconvert writes before the data', () => {
    const bytes = wavBytes(pcm(SAMPLES), { between: [chunk('FLLR', 4044), chunk('LIST', 7)] });

    expect([...decodeWav(bytes, 'system.wav')]).toEqual(SAMPLES);
  });

  it('accepts WAVE_FORMAT_EXTENSIBLE when its subformat is PCM', () => {
    const bytes = wavBytes(pcm(SAMPLES), { format: 0xfffe, extensibleSubformat: 1 });

    expect([...decodeWav(bytes, 'mic.wav')]).toEqual(SAMPLES);
  });

  it('reads samples from a buffer that does not start at offset 0 of its memory', () => {
    const file = wavBytes(pcm(SAMPLES));
    const backing = new Uint8Array(file.length + 3);
    backing.set(file, 3);

    expect([...decodeWav(backing.subarray(3), 'mic.wav')]).toEqual(SAMPLES);
  });

  it('refuses another sample rate, naming the rate and how to convert the file', () => {
    const decode = (): Int16Array =>
      decodeWav(wavBytes(pcm(SAMPLES), { sampleRate: 48_000 }), 'items/standup/mic.wav');

    expect(decode).toThrow(WavFormatError);
    expect(decode).toThrow(
      'items/standup/mic.wav: 48000 Hz audio; bench audio must be 16 kHz mono PCM16',
    );
    expect(decode).toThrow('afconvert -f WAVE -d LEI16@16000 -c 1');
  });

  it('refuses stereo, naming the channel count', () => {
    const decode = (): Int16Array =>
      decodeWav(wavBytes(pcm(SAMPLES.slice(0, 6)), { channels: 2 }), 'listen.wav');

    expect(decode).toThrow(WavFormatError);
    expect(decode).toThrow('listen.wav: 2 channels; bench audio must be 16 kHz mono PCM16');
  });

  it('refuses audio that is not PCM16: float, 24-bit, and an extensible float subformat', () => {
    expect(() =>
      decodeWav(wavBytes(new Uint8Array(8), { format: 3, bitsPerSample: 32 }), 'a.wav'),
    ).toThrow('a.wav: format code 3 (IEEE float), not PCM; bench audio must be 16 kHz mono PCM16');
    expect(() => decodeWav(wavBytes(new Uint8Array(6), { bitsPerSample: 24 }), 'b.wav')).toThrow(
      'b.wav: 24-bit samples; bench audio must be 16 kHz mono PCM16',
    );
    expect(() =>
      decodeWav(
        wavBytes(new Uint8Array(8), { format: 0xfffe, extensibleSubformat: 3, bitsPerSample: 32 }),
        'c.wav',
      ),
    ).toThrow('c.wav: format code 3 (IEEE float), not PCM');
  });

  it('refuses a file that is not a little-endian RIFF WAVE file', () => {
    expect(() => decodeWav(new Uint8Array(4), 'short.wav')).toThrow(
      'short.wav: not a WAV file (too short for a RIFF header)',
    );
    const mp3ish = new Uint8Array(64);
    ascii(mp3ish, 0, 'ID3');
    expect(() => decodeWav(mp3ish, 'clip.m4a')).toThrow(
      'clip.m4a: not a WAV file (no RIFF/WAVE header)',
    );
    const rifx = wavBytes(pcm(SAMPLES));
    ascii(rifx, 0, 'RIFX');
    expect(() => decodeWav(rifx, 'big.wav')).toThrow(
      'big.wav: big-endian WAV (RIFX) is not supported',
    );
  });

  it('refuses a file cut short instead of scoring part of the clip', () => {
    const torn = wavBytes(pcm(SAMPLES), { claimedDataBytes: 1_000 });

    expect(() => decodeWav(torn, 'torn.wav')).toThrow(
      'torn.wav: the data chunk says 1000 bytes but only 14 follow; the file is cut short',
    );
  });

  it('refuses a file with no fmt or no data chunk', () => {
    const noData = wavBytes(pcm(SAMPLES)).subarray(0, 12 + 24);
    new DataView(noData.buffer, noData.byteOffset).setUint32(4, noData.length - 8, true);

    expect(() => decodeWav(noData, 'nodata.wav')).toThrow('nodata.wav: no data chunk');
  });
});

describe('encodeWav and the files', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roger-bench-wav-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips samples through the encoder and the decoder', () => {
    const samples = Int16Array.from(SAMPLES);
    const bytes = encodeWav(samples);

    expect(bytes.length).toBe(44 + samples.length * 2);
    expect([...decodeWav(bytes, 'round-trip.wav')]).toEqual(SAMPLES);
  });

  it('round-trips an empty clip', () => {
    expect(decodeWav(encodeWav(new Int16Array(0)), 'empty.wav')).toHaveLength(0);
  });

  it('writes and reads a file, readable by its owner only', async () => {
    const path = join(dir, 'mic.wav');
    await writeWav(path, Int16Array.from(SAMPLES));

    expect([...(await readWav(path))]).toEqual(SAMPLES);
    // Recordings of real people (M3 D2): the folder is 0700 and each file 0600.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('names the path when a file on disk is refused', async () => {
    const path = join(dir, 'loud.wav');
    await writeWav(path, Int16Array.from(SAMPLES));
    const bytes = await readFile(path);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(24, 44_100, true);
    await writeFile(path, bytes);

    await expect(readWav(path)).rejects.toThrow(`${path}: 44100 Hz audio`);
  });
});

describe('encodeStereoWav (listen.wav only)', () => {
  it('interleaves left and right, padding the shorter channel with silence', () => {
    const bytes = encodeStereoWav(Int16Array.from([1, 2, 3]), Int16Array.from([-1]));
    const view = new DataView(bytes.buffer, bytes.byteOffset);

    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(64_000);
    expect(view.getUint16(32, true)).toBe(4);
    const frames = [...new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44))];
    expect(frames).toEqual([1, -1, 2, 0, 3, 0]);
  });

  it('is never readable as bench audio, so a listen file cannot be scored by mistake', () => {
    const bytes = encodeStereoWav(Int16Array.from([1]), Int16Array.from([2]));

    expect(() => decodeWav(bytes, 'listen.wav')).toThrow('listen.wav: 2 channels');
  });
});
