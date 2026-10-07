import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairWavFile, WAV_HEADER_BYTES, wavDataBytesToMs, wavHeader } from './wav';

/** T3's committed backup fixture: a WAV chunk of 2000 ms, written as the backup writes one. */
const FIXTURE_WAV = fileURLToPath(
  new URL(
    '../../../test/fixtures/backup/audio/0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b/mic-000003000.wav',
    import.meta.url,
  ),
);

describe('wavHeader', () => {
  it('is the 44-byte header of 16 kHz mono PCM16, as the backup fixture has it', () => {
    const fixture = readFileSync(FIXTURE_WAV);
    expect(wavHeader(fixture.length - WAV_HEADER_BYTES)).toEqual(
      fixture.subarray(0, WAV_HEADER_BYTES),
    );
  });

  it('counts the data and everything after the RIFF size field', () => {
    const header = wavHeader(3_200);
    expect(header).toHaveLength(WAV_HEADER_BYTES);
    expect(header.toString('latin1', 0, 4)).toBe('RIFF');
    expect(header.readUInt32LE(4)).toBe(36 + 3_200);
    expect(header.toString('latin1', 36, 40)).toBe('data');
    expect(header.readUInt32LE(40)).toBe(3_200);
  });

  it('refuses a size that is not whole samples or does not fit a RIFF file', () => {
    expect(() => wavHeader(3)).toThrow(RangeError);
    expect(() => wavHeader(-2)).toThrow(RangeError);
    expect(() => wavHeader(0xffff_fffe)).toThrow(RangeError);
  });
});

describe('wavDataBytesToMs', () => {
  it('is 32 bytes per millisecond at 16 kHz mono PCM16', () => {
    expect(wavDataBytesToMs(64_000)).toBe(2_000);
    expect(wavDataBytesToMs(0)).toBe(0);
  });
});

describe('repairWavFile', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roger-wav-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites the sizes a crash left at 0 from the bytes on disk', () => {
    const path = join(dir, 'mic.wav');
    const pcm = Buffer.alloc(6_400, 7);
    // What the writer has on disk mid-call: the header written at open, sizes still 0.
    writeFileSync(path, Buffer.concat([wavHeader(0), pcm]));

    expect(repairWavFile(path)).toEqual({ dataBytes: 6_400, bytes: WAV_HEADER_BYTES + 6_400 });

    const repaired = readFileSync(path);
    expect(repaired.subarray(0, WAV_HEADER_BYTES)).toEqual(wavHeader(6_400));
    expect(repaired.subarray(WAV_HEADER_BYTES)).toEqual(pcm);
  });

  it('cuts a half sample the crash tore off, so the data is whole samples', () => {
    const path = join(dir, 'torn.wav');
    writeFileSync(path, Buffer.concat([wavHeader(0), Buffer.alloc(3_201, 1)]));

    expect(repairWavFile(path)).toEqual({ dataBytes: 3_200, bytes: WAV_HEADER_BYTES + 3_200 });
    expect(statSync(path).size).toBe(WAV_HEADER_BYTES + 3_200);
  });

  it('makes a file torn inside its header an empty WAV', () => {
    const path = join(dir, 'header.wav');
    writeFileSync(path, wavHeader(0).subarray(0, 20));

    expect(repairWavFile(path)).toEqual({ dataBytes: 0, bytes: WAV_HEADER_BYTES });
    expect(readFileSync(path)).toEqual(wavHeader(0));
  });

  it('leaves a closed file as it was', () => {
    const path = join(dir, 'closed.wav');
    const whole = Buffer.concat([wavHeader(3_200), Buffer.alloc(3_200, 9)]);
    writeFileSync(path, whole);

    expect(repairWavFile(path)).toEqual({ dataBytes: 3_200, bytes: whole.length });
    expect(readFileSync(path)).toEqual(whole);
  });

  it('throws with the path when the file is missing', () => {
    expect(() => repairWavFile(join(dir, 'gone.wav'))).toThrow(/gone\.wav/);
  });
});
