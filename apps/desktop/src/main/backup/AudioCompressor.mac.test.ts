import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { ensureMeetingAudioDir, storedAudioPath } from './audioPaths';
import { AFCONVERT, AudioCompressor } from './AudioCompressor';
import { wavHeader } from './wav';

/**
 * macOS only (`pnpm test:mac`): the real afconvert on WAV files this test makes, in a temp folder.
 * AudioCompressor.test.ts covers the queue and the bookkeeping with a stand-in on any machine; this
 * pins the command itself (M2 risk "afconvert rejects 48 kbps AAC at 16 kHz").
 */

const MEETING = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const FILE_ID = '2f6a8c1d-5e3b-4a7f-9c2d-8e1f0a3b4c5d';
const TONE_HZ = 440;
const SECONDS = 2;
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function tone(index: number): number {
  return Math.round(Math.sin((2 * Math.PI * TONE_HZ * index) / PCM_SAMPLE_RATE) * 8_192);
}

/** The samples of afconvert's own WAV output, which puts a `FLLR` chunk before `data`. */
function wavSamples(bytes: Buffer): Int16Array {
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('latin1', offset, offset + 4) === 'data') {
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

describe('AudioCompressor on macOS', () => {
  let userData = '';
  let store: InMemoryTranscriptStore;

  /** A closed backup WAV and its row, as the writer leaves them. */
  function closedWav(content: Buffer): { path: string; wav: string } {
    store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    const path = storedAudioPath(MEETING, 'mic-000000000-2f6a8c1d.wav');
    const wav = join(ensureMeetingAudioDir(userData, MEETING), 'mic-000000000-2f6a8c1d.wav');
    writeFileSync(wav, content);
    store.addAudioFile({
      id: FILE_ID,
      meetingId: MEETING,
      source: 'mic',
      startMs: 0,
      path,
      format: 'wav',
      createdAt: '2026-10-06T09:00:00.000Z',
    });
    store.closeAudioFile(FILE_ID, {
      endMs: SECONDS * 1_000,
      bytes: content.length,
      closedAt: '2026-10-06T09:00:02.000Z',
    });
    return { path, wav };
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-compressor-mac-'));
    store = new InMemoryTranscriptStore();
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('turns a backup WAV into an AAC m4a that decodes back to the same audio', async () => {
    const samples = new Int16Array(SECONDS * PCM_SAMPLE_RATE).map((_, index) => tone(index));
    const pcm = Buffer.from(samples.buffer);
    const { path, wav } = closedWav(Buffer.concat([wavHeader(pcm.length), pcm]));
    const compressor = new AudioCompressor({ store, userData, logger });

    compressor.enqueue({ id: FILE_ID, meetingId: MEETING, path });
    await compressor.idle();

    const [row] = store.listAudioFiles(MEETING);
    expect(row).toMatchObject({ format: 'm4a', path: path.replace(/\.wav$/, '.m4a') });
    const m4a = join(userData, row!.path);
    expect(existsSync(wav)).toBe(false);
    expect(readdirSync(join(userData, 'audio', MEETING))).toEqual([row!.path.split('/').at(-1)]);
    expect(readFileSync(m4a).toString('latin1', 4, 8)).toBe('ftyp');
    // A small fraction of the WAV: the point of encoding (M2 D5).
    expect(row!.bytes).toBeLessThan(pcm.length / 4);
    const info = execFileSync('/usr/bin/afinfo', [m4a], { encoding: 'utf8' });
    expect(info).toMatch(/1 ch,\s+16000 Hz, aac/);
    expect(info).toContain(`audio ${samples.length} valid frames`);

    const decoded = join(userData, 'decoded.wav');
    execFileSync(AFCONVERT, [
      '-f',
      'WAVE',
      '-d',
      `LEI16@${PCM_SAMPLE_RATE}`,
      '-c',
      '1',
      m4a,
      decoded,
    ]);
    const back = wavSamples(readFileSync(decoded));
    expect(back).toHaveLength(samples.length);
    // Lossy, so compared by correlation with the tone that went in; priming left in would shift it
    // by 2112 samples and the correlation would collapse.
    let dot = 0;
    let backEnergy = 0;
    let toneEnergy = 0;
    back.forEach((sample, index) => {
      const expected = samples[index] ?? 0;
      dot += sample * expected;
      backEnergy += sample * sample;
      toneEnergy += expected * expected;
    });
    expect(dot / Math.sqrt(backEnergy * toneEnergy)).toBeGreaterThan(0.95);
  });

  it('keeps the WAV, and leaves nothing beside it, when afconvert cannot read it', async () => {
    const { path, wav } = closedWav(Buffer.from('not a WAV file at all'));
    const compressor = new AudioCompressor({ store, userData, logger });

    compressor.enqueue({ id: FILE_ID, meetingId: MEETING, path });
    await compressor.idle();

    expect(store.listAudioFiles(MEETING)).toEqual([
      expect.objectContaining({ format: 'wav', path }),
    ]);
    expect(readdirSync(join(userData, 'audio', MEETING))).toEqual([wav.split('/').at(-1)]);
  });
});
