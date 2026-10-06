// Makes the audio-backup fixture in this folder (M2-T3). It is laid out like the app's userData
// folder, so a reader points its `--user-data` here:
//
//   roger.sqlite                     built by the app's own store, so every migration ran
//   audio/<meeting>/mic-000000000.m4a     mic, meeting offset 0 to 2000 ms (AAC, from a WAV)
//   audio/<meeting>/mic-000003000.wav     mic, 3000 to 5000 ms (16 kHz mono Int16, as captured)
//   audio/<meeting>/system-000000000.m4a  call audio, 0 to 2000 ms
//   audio/<meeting>/system-000003000.wav  call audio, 3000 to 5000 ms
//
// Meeting 0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b, started 2026-10-06T09:00:00.000Z, ended 5 s
// later. Each stream has a 1 s capture gap (2000 to 3000 ms) between its chunks, and call audio
// has an unrecovered `stt_failed` transcript gap at 3500 to 4500 ms, inside its WAV chunk. The
// audio is a tone (mic 440 Hz, call audio 660 Hz), so no voice is committed. `audio_files.path` is
// relative to userData, as the store requires.
//
// Read by src/main/store/backupFixture.test.ts, M2-T15's backup tests and M3-T12's `bench clip`
// tests. Regenerate on a Mac (it needs /usr/bin/afconvert), from apps/desktop:
//
//   node test/fixtures/backup/make-backup-fixture.mjs
//
// A later migration does not require a rerun: the store migrates a copy when it opens one.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(FIXTURE_DIR, '../../..');
const MEETING_ID = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const STARTED_AT = Date.parse('2026-10-06T09:00:00.000Z');
const SAMPLE_RATE = 16_000;
const TONE_HZ = { mic: 440, system: 660 };
const AFCONVERT = '/usr/bin/afconvert';

/** ISO 8601 instant at a meeting offset. */
function at(offsetMs) {
  return new Date(STARTED_AT + offsetMs).toISOString();
}

/** A 16 kHz mono Int16 WAV with a 44-byte header, as the backup writes while capturing. */
function wavOfTone(hz, ms) {
  const samples = (SAMPLE_RATE * ms) / 1000;
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVE', 8, 'latin1');
  wav.write('fmt ', 12, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i += 1) {
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 8192), 44 + i * 2);
  }
  return wav;
}

if (!existsSync(AFCONVERT)) throw new Error(`${AFCONVERT} is missing: make this fixture on a Mac`);

const { module: storeModule } = await runnerImport(
  join(DESKTOP_DIR, 'src/main/store/SqliteTranscriptStore.ts'),
  { configFile: false, root: DESKTOP_DIR, logLevel: 'error' },
);
const { SqliteTranscriptStore } = storeModule;

const database = join(FIXTURE_DIR, 'roger.sqlite');
for (const stale of [database, `${database}-wal`, `${database}-shm`])
  rmSync(stale, { force: true });
rmSync(join(FIXTURE_DIR, 'audio'), { recursive: true, force: true });
const meetingDir = join(FIXTURE_DIR, 'audio', MEETING_ID);
mkdirSync(meetingDir, { recursive: true });

const store = new SqliteTranscriptStore(database, () => new Date(at(5000)));
store.createMeeting({ id: MEETING_ID, title: 'Backup fixture', startedAt: at(0) });

for (const source of ['mic', 'system']) {
  for (const [startMs, endMs, encode] of [
    [0, 2000, true],
    [3000, 5000, false],
  ]) {
    const id = `${source}-${String(startMs).padStart(9, '0')}`;
    const wavPath = `audio/${MEETING_ID}/${id}.wav`;
    writeFileSync(join(FIXTURE_DIR, wavPath), wavOfTone(TONE_HZ[source], endMs - startMs));
    store.addAudioFile({
      id,
      meetingId: MEETING_ID,
      source,
      startMs,
      path: wavPath,
      format: 'wav',
      createdAt: at(startMs),
    });
    store.closeAudioFile(id, {
      endMs,
      bytes: statSync(join(FIXTURE_DIR, wavPath)).size,
      closedAt: at(endMs),
    });
    if (!encode) continue;
    // The command the backup's compressor runs (M2 D5: AAC in m4a at 48 kbps).
    const m4aPath = `audio/${MEETING_ID}/${id}.m4a`;
    execFileSync(AFCONVERT, [
      '-f',
      'm4af',
      '-d',
      'aac',
      '-b',
      '48000',
      join(FIXTURE_DIR, wavPath),
      join(FIXTURE_DIR, m4aPath),
    ]);
    rmSync(join(FIXTURE_DIR, wavPath));
    store.markAudioFileEncoded(id, {
      path: m4aPath,
      format: 'm4a',
      bytes: statSync(join(FIXTURE_DIR, m4aPath)).size,
    });
  }
}

store.appendSegment({
  id: '4c2d8a1e-6b3f-4e5a-8c7d-1f2e3a4b5c6d',
  meetingId: MEETING_ID,
  source: 'system',
  speaker: 'them',
  startMs: 200,
  endMs: 1800,
  text: 'Call audio before the gap.',
  confidence: 0.9,
  words: null,
  createdAt: at(2100),
});
store.appendSegment({
  id: '7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b',
  meetingId: MEETING_ID,
  source: 'mic',
  speaker: 'me',
  startMs: 3200,
  endMs: 4800,
  text: 'Microphone after the gap.',
  confidence: 0.9,
  words: null,
  createdAt: at(5000),
});
store.addGap({
  id: '9d3e4f5a-6b7c-4d8e-af9b-0c1d2e3f4a5b',
  meetingId: MEETING_ID,
  source: 'system',
  startMs: 3500,
  endMs: 4500,
  reason: 'stt_failed',
  createdAt: at(4600),
});
store.setMeetingStopReason(MEETING_ID, 'user');
store.markMeetingEnded(MEETING_ID, at(5000));
store.close();

// The store runs in WAL mode; a committed file must open read-only with no -wal or -shm beside it.
const raw = new DatabaseSync(database);
raw.exec('PRAGMA journal_mode = DELETE');
raw.exec('VACUUM');
raw.close();

process.stdout.write(`wrote ${database} and ${meetingDir}\n`);
