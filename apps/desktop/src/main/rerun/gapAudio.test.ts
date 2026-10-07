import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { AFCONVERT, type RunTool } from '../backup/AudioCompressor';
import { resolveStoredAudioPath } from '../backup/audioPaths';
import {
  copyBackupFixture,
  FIXTURE_MEETING_ID,
  type FixtureCopy,
} from '../backup/testing/backupFixture';
import { createLogger } from '../logger';
import type { AudioFile, TranscriptStore } from '../store/TranscriptStore';
import { GapAudioReader, heldMs, M4A_DECODE_ARGS } from './gapAudio';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
/** The fixture's call-audio WAV (3000 to 5000 ms), and the tone every fixture file holds. */
const SYSTEM_WAV_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SYSTEM_TONE_HZ = 660;
const SAMPLES_PER_MS = PCM_SAMPLE_RATE / 1_000;

/** As the fixture wrote it; `| 0` makes a rounded -0 the 0 an Int16 holds (toBe tells them apart). */
function tone(hz: number, index: number): number {
  return Math.round(Math.sin((2 * Math.PI * hz * index) / PCM_SAMPLE_RATE) * 8_192) | 0;
}

function samplesOf(pcm: Uint8Array): Int16Array {
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
}

/**
 * A WAV as afconvert writes one (checked with the real tool in gapAudio.mac.test.ts): a
 * WAVE_FORMAT_EXTENSIBLE `fmt ` chunk (tag 0xFFFE, the real format in its sub-format GUID) and a
 * `FLLR` chunk before `data`, so the reader has to walk the chunks rather than assume 44 bytes.
 */
function afconvertWav(samples: Int16Array, rate = PCM_SAMPLE_RATE, channels = 1): Buffer {
  const fmt = Buffer.alloc(8 + 40);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(40, 4);
  fmt.writeUInt16LE(0xfffe, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2 * channels, 16);
  fmt.writeUInt16LE(2 * channels, 20);
  fmt.writeUInt16LE(16, 22);
  fmt.writeUInt16LE(22, 24); // the extension's size
  fmt.writeUInt16LE(16, 26); // valid bits
  fmt.writeUInt32LE(channels === 1 ? 0x4 : 0x3, 28); // speaker mask
  fmt.writeUInt16LE(1, 32); // KSDATAFORMAT_SUBTYPE_PCM's first two bytes
  const filler = Buffer.alloc(8 + 30);
  filler.write('FLLR', 0, 'latin1');
  filler.writeUInt32LE(30, 4);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(samples.byteLength, 4);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    fmt,
    filler,
    data,
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** afconvert stand-in: "decodes" any m4a into `ms` of the call-audio tone. */
function decodeTo(ms: number, calls: (readonly string[])[], rate = PCM_SAMPLE_RATE): RunTool {
  return (command, args) => {
    calls.push([command, ...args]);
    const samples = new Int16Array(ms * SAMPLES_PER_MS);
    for (let i = 0; i < samples.length; i += 1) samples[i] = tone(SYSTEM_TONE_HZ, i);
    writeFileSync(args.at(-1) ?? '', afconvertWav(samples, rate));
    return Promise.resolve();
  };
}

describe('GapAudioReader', () => {
  let fixture: FixtureCopy;

  beforeEach(() => {
    fixture = copyBackupFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  function reader(run: RunTool = decodeTo(0, []), store: TranscriptStore = fixture.store) {
    return new GapAudioReader({ store, userData: fixture.userData, logger, run });
  }

  it("reads a WAV's samples inside the window, dated from the file's start", async () => {
    const pieces = await reader().read(FIXTURE_MEETING_ID, 'system', 3_500, 4_500);
    expect(pieces).toHaveLength(1);
    const [piece] = pieces;
    expect(piece?.startMs).toBe(3_500);
    const samples = samplesOf(piece?.pcm ?? new Uint8Array());
    expect(samples).toHaveLength(1_000 * SAMPLES_PER_MS);
    // The file starts at 3000 ms: the window's first sample is the file's 500 ms mark.
    const fromFile = 500 * SAMPLES_PER_MS;
    expect(Array.from(samples.subarray(0, 3))).toEqual(
      [0, 1, 2].map((i) => tone(SYSTEM_TONE_HZ, fromFile + i)),
    );
    expect(samples.at(-1)).toBe(tone(SYSTEM_TONE_HZ, 1_500 * SAMPLES_PER_MS - 1));
    expect(heldMs(pieces, 3_500, 4_500)).toBe(1_000);
  });

  it('decodes an m4a with afconvert, and keeps the hole between two files', async () => {
    const calls: (readonly string[])[] = [];
    const pieces = await reader(decodeTo(2_000, calls)).read(
      FIXTURE_MEETING_ID,
      'system',
      1_500,
      3_500,
    );
    expect(pieces.map((piece) => [piece.startMs, piece.pcm.byteLength / 2])).toEqual([
      [1_500, 500 * SAMPLES_PER_MS],
      [3_000, 500 * SAMPLES_PER_MS],
    ]);
    // 2000 to 3000 ms was never captured: the window holds 1000 ms of the 2000 asked for.
    expect(heldMs(pieces, 1_500, 3_500)).toBe(1_000);
    const m4a = resolveStoredAudioPath(
      fixture.userData,
      `audio/${FIXTURE_MEETING_ID}/system-000000000.m4a`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, -1)).toEqual([AFCONVERT, ...M4A_DECODE_ARGS, m4a]);
    expect(M4A_DECODE_ARGS).toEqual(['-f', 'WAVE', '-d', 'LEI16@16000']);
  });

  it('reads the row again when the compressor moved its WAV to an m4a meanwhile', async () => {
    const { store, userData } = fixture;
    const stale = store.listAudioFiles(FIXTURE_MEETING_ID);
    // The compressor's order (AudioCompressor): the m4a is written, the row switched, the WAV gone.
    const m4aPath = `audio/${FIXTURE_MEETING_ID}/system-000003000.m4a`;
    writeFileSync(resolveStoredAudioPath(userData, m4aPath), 'm4a');
    store.markAudioFileEncoded(SYSTEM_WAV_ID, { path: m4aPath, format: 'm4a', bytes: 3 });
    rmSync(resolveStoredAudioPath(userData, `audio/${FIXTURE_MEETING_ID}/system-000003000.wav`));
    let reads = 0;
    // The reader listed the rows just before the switch: its first list is the stale one.
    const racing: TranscriptStore = Object.create(store) as TranscriptStore;
    racing.listAudioFiles = (meetingId: string): AudioFile[] => {
      reads += 1;
      return reads === 1 ? stale : store.listAudioFiles(meetingId);
    };
    const calls: (readonly string[])[] = [];
    const pieces = await reader(decodeTo(2_000, calls), racing).read(
      FIXTURE_MEETING_ID,
      'system',
      3_500,
      4_500,
    );
    expect(pieces.map((piece) => [piece.startMs, piece.pcm.byteLength / 2])).toEqual([
      [3_500, 1_000 * SAMPLES_PER_MS],
    ]);
    expect(calls[0]?.at(-2)).toBe(resolveStoredAudioPath(userData, m4aPath));
  });

  it('holds nothing for a file deleted since its row was read, or a window with no file', async () => {
    const { store, userData } = fixture;
    const rows = store.listAudioFiles(FIXTURE_MEETING_ID);
    // Delete-audio's order (AudioBackup.deleteAudio): the folder goes, then the rows.
    rmSync(join(userData, 'audio', FIXTURE_MEETING_ID), { recursive: true });
    store.markMeetingAudioDeleted(FIXTURE_MEETING_ID, new Date().toISOString());
    const stale: TranscriptStore = Object.create(store) as TranscriptStore;
    let reads = 0;
    stale.listAudioFiles = (meetingId: string): AudioFile[] => {
      reads += 1;
      return reads === 1 ? rows : store.listAudioFiles(meetingId);
    };
    await expect(
      reader(decodeTo(0, []), stale).read(FIXTURE_MEETING_ID, 'system', 3_500, 4_500),
    ).resolves.toEqual([]);
    await expect(reader().read(FIXTURE_MEETING_ID, 'mic', 5_500, 9_000)).resolves.toEqual([]);
  });

  it('refuses a decoded file that is not 16 kHz mono PCM16, naming it', async () => {
    await expect(
      reader(decodeTo(2_000, [], 48_000)).read(FIXTURE_MEETING_ID, 'system', 0, 1_000),
    ).rejects.toThrow(/system-000000000\.m4a.*48000 Hz/);
  });
});
