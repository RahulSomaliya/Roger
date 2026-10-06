import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_MIN_FREE_BYTES } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource } from '../../shared/transcript';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { AudioFile } from '../store/TranscriptStore';
import { ensureMeetingAudioDir, meetingAudioDir, storedAudioPath } from './audioPaths';
import type { CompressJob } from './AudioCompressor';
import { AudioBackupWriter, DISK_CHECK_INTERVAL_MS } from './AudioBackupWriter';
import { WAV_HEADER_BYTES, wavHeader } from './wav';

const MEETING = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const SAMPLES_PER_MS = PCM_SAMPLE_RATE / 1_000;
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

/** `ms` of audio whose samples count up from `first`, so a test can tell every sample apart. */
function chunk(ms: number, first: number): Uint8Array {
  const samples = new Int16Array(ms * SAMPLES_PER_MS).map((_, index) => (first + index) % 32_000);
  return new Uint8Array(samples.buffer);
}

describe('AudioBackupWriter', () => {
  let userData = '';
  let store: InMemoryTranscriptStore;
  let now = T0;
  let freeBytes = 100 * BACKUP_MIN_FREE_BYTES;
  let closed: CompressJob[];
  let changes = 0;

  function writer(enabled = true, root = userData): AudioBackupWriter {
    return new AudioBackupWriter({
      store,
      userData: root,
      enabled,
      logger,
      clock: () => now,
      freeDiskBytes: () => freeBytes,
      onFileClosed: (job) => closed.push(job),
      onChange: () => {
        changes += 1;
      },
    });
  }

  /** Feeds `ms` of one source in `chunkMs` chunks, captured from `fromMs` (wall clock). */
  function feed(
    backup: AudioBackupWriter,
    source: AudioSource,
    fromMs: number,
    ms: number,
    chunkMs = 100,
  ): void {
    for (let at = 0; at < ms; at += chunkMs) {
      now = fromMs + at + chunkMs;
      backup.onChunk(source, chunk(Math.min(chunkMs, ms - at), at * SAMPLES_PER_MS), fromMs + at);
    }
  }

  function files(source?: AudioSource): AudioFile[] {
    return store
      .listAudioFiles(MEETING)
      .filter((file) => source === undefined || file.source === source);
  }

  function spans(source: AudioSource): [number, number | null][] {
    return files(source).map((file) => [file.startMs, file.endMs]);
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-backup-writer-'));
    store = new InMemoryTranscriptStore(() => new Date(now));
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    now = T0;
    freeBytes = 100 * BACKUP_MIN_FREE_BYTES;
    closed = [];
    changes = 0;
  });

  afterEach(() => {
    chmodSync(userData, 0o700);
    rmSync(userData, { recursive: true, force: true });
  });

  it('writes each stream to a WAV of its own, placed on the meeting timeline', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0 + 500, 2_000);
    feed(backup, 'system', T0 + 700, 1_000);
    backup.end(MEETING);

    expect(spans('mic')).toEqual([[500, 2_500]]);
    expect(spans('system')).toEqual([[700, 1_700]]);
    const [mic] = files('mic');
    const bytes = readFileSync(join(userData, mic!.path));
    // The samples as fed, behind a header that now says how many there are.
    expect(bytes.subarray(0, WAV_HEADER_BYTES)).toEqual(wavHeader(2_000 * SAMPLES_PER_MS * 2));
    expect(bytes.subarray(WAV_HEADER_BYTES)).toEqual(Buffer.from(chunk(2_000, 0)));
    expect(mic).toMatchObject({ format: 'wav', bytes: bytes.length });
    expect(mic!.path).toMatch(new RegExp(`^audio/${MEETING}/mic-000000500-[0-9a-f]{8}\\.wav$`));
    expect(closed.map((job) => job.id).sort()).toEqual(
      files()
        .map((file) => file.id)
        .sort(),
    );
    expect(statSync(meetingAudioDir(userData, MEETING)).mode & 0o777).toBe(0o700);
    expect(statSync(join(userData, mic!.path)).mode & 0o777).toBe(0o600);
  });

  it('starts a new file at every timeline run, where a capture gap begins', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);
    // 300 ms of audio never came: over the timeline's 250 ms drift limit, so a new run.
    feed(backup, 'mic', T0 + 1_300, 700);
    // Capture times that wobble under the limit stay in one run and one file.
    for (const [index, wobbleMs] of [40, -60, 120, 0, -30].entries()) {
      backup.onChunk('system', chunk(100, index * 1_600), T0 + index * 100 + wobbleMs);
    }
    backup.end(MEETING);

    expect(spans('mic')).toEqual([
      [0, 1_000],
      [1_300, 2_000],
    ]);
    expect(spans('system')).toEqual([[40, 540]]);
  });

  it('never keeps more than 60 s in one file, and splits a chunk at the boundary', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    // 130 ms chunks: the 60 s mark falls inside one of them.
    feed(backup, 'mic', T0, 61_100, 130);
    backup.end(MEETING);

    expect(spans('mic')).toEqual([
      [0, 60_000],
      [60_000, 61_100],
    ]);
    const [first, second] = files('mic').map((file) => readFileSync(join(userData, file.path)));
    expect(first!.length).toBe(WAV_HEADER_BYTES + 60_000 * SAMPLES_PER_MS * 2);
    // Not a sample lost or doubled at the split.
    const whole = Buffer.concat([
      first!.subarray(WAV_HEADER_BYTES),
      second!.subarray(WAV_HEADER_BYTES),
    ]);
    const fed = Buffer.concat(
      Array.from({ length: Math.ceil(61_100 / 130) }, (_, index) =>
        Buffer.from(chunk(Math.min(130, 61_100 - index * 130), index * 130 * SAMPLES_PER_MS)),
      ),
    );
    expect(whole.equals(fed)).toBe(true);
  });

  it('counts offsets from the first start of a resumed meeting', () => {
    const backup = writer();
    // Resumed after a crash (M2 D7): the meeting began ten minutes before this recording.
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 - 600_000 });
    feed(backup, 'mic', T0, 1_000);
    backup.end(MEETING);

    expect(spans('mic')).toEqual([[600_000, 601_000]]);
  });

  it('shows the bytes kept so far while it writes', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);

    expect(backup.live()).toEqual({
      status: {
        state: 'writing',
        bytes: WAV_HEADER_BYTES + 32_000,
        keepUntil: null,
        keptForRerun: false,
        message: null,
      },
      warning: null,
    });
    backup.end(MEETING);
    expect(backup.live()).toBeNull();
  });

  it('pauses below 2 GiB free, says so loudly, and starts again when there is room', () => {
    freeBytes = BACKUP_MIN_FREE_BYTES - 1;
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 2_000);

    expect(files()).toEqual([]);
    expect(backup.live()?.status).toMatchObject({ state: 'paused', bytes: 0 });
    expect(backup.live()?.warning).toEqual({
      kind: 'backup-paused',
      source: null,
      since: new Date(T0).toISOString(),
      message: expect.stringContaining('2 GB') as string,
      loud: true,
    });
    expect(changes).toBeGreaterThan(0);

    freeBytes = BACKUP_MIN_FREE_BYTES;
    // Free space is read again at most every DISK_CHECK_INTERVAL_MS.
    feed(backup, 'mic', T0 + 2_000, DISK_CHECK_INTERVAL_MS);
    backup.end(MEETING);

    // The check runs as a chunk arrives; that chunk was captured 100 ms before.
    expect(spans('mic')).toEqual([[DISK_CHECK_INTERVAL_MS - 100, DISK_CHECK_INTERVAL_MS + 2_000]]);
    expect(store.listCaptureEvents(MEETING).map(({ kind, detail }) => ({ kind, detail }))).toEqual([
      {
        kind: 'backup_paused',
        detail: { freeBytes: BACKUP_MIN_FREE_BYTES - 1, minFreeBytes: BACKUP_MIN_FREE_BYTES },
      },
      { kind: 'backup_resumed', detail: { freeBytes: BACKUP_MIN_FREE_BYTES } },
    ]);
  });

  it('closes its files when the disk fills mid-call', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 3_000);
    freeBytes = BACKUP_MIN_FREE_BYTES / 2;
    feed(backup, 'mic', T0 + 3_000, DISK_CHECK_INTERVAL_MS);

    expect(backup.live()?.status.state).toBe('paused');
    expect(files('mic')).toEqual([
      expect.objectContaining({ startMs: 0, closedAt: expect.any(String) as string }),
    ]);
    // The check that paused it came with the chunk that arrived at the interval, which is not kept.
    expect(files('mic')[0]!.endMs).toBe(DISK_CHECK_INTERVAL_MS - 100);
    expect(closed).toHaveLength(1);
    backup.end(MEETING);
  });

  it('stops keeping audio when a write fails, and the recording goes on', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);
    // The next file cannot be created.
    chmodSync(meetingAudioDir(userData, MEETING), 0o500);
    feed(backup, 'mic', T0 + 2_000, 1_000);
    chmodSync(meetingAudioDir(userData, MEETING), 0o700);
    feed(backup, 'mic', T0 + 3_000, 1_000);

    expect(backup.live()?.status).toMatchObject({
      state: 'error',
      message: expect.stringContaining('EACCES') as string,
    });
    // A failed write is not the low-disk warning: the status says it.
    expect(backup.live()?.warning).toBeNull();
    expect(spans('mic')).toEqual([[0, 1_000]]);
    expect(store.listCaptureEvents(MEETING).map(({ kind, detail }) => ({ kind, detail }))).toEqual([
      { kind: 'backup_failed', detail: { error: 'EACCES' } },
    ]);
    backup.end(MEETING);
    expect(spans('mic')).toEqual([[0, 1_000]]);
  });

  it('keeps nothing when the backup is off', () => {
    const backup = writer(false);
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);

    expect(backup.live()?.status).toMatchObject({ state: 'off', bytes: 0 });
    backup.end(MEETING);
    expect(files()).toEqual([]);
    expect(existsSync(meetingAudioDir(userData, MEETING))).toBe(false);
  });

  it('reports an error, and never throws, when the audio folder cannot be made', () => {
    const backup = writer(true, join(userData, 'missing', 'and-unwritable'));
    chmodSync(userData, 0o500);

    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);

    expect(backup.live()?.status.state).toBe('error');
    expect(files()).toEqual([]);
    backup.end(MEETING);
  });

  it('closes the files of a recording still running at quit, and takes no more', () => {
    const backup = writer();
    backup.begin({ meetingId: MEETING, meetingStartedAtMs: T0 });
    feed(backup, 'mic', T0, 1_000);

    backup.stop();
    feed(backup, 'mic', T0 + 1_000, 1_000);

    expect(spans('mic')).toEqual([[0, 1_000]]);
    expect(closed).toHaveLength(1);
  });
});

describe('AudioBackupWriter.repairLeftOpen', () => {
  let userData = '';
  let store: InMemoryTranscriptStore;
  const now = Date.parse('2026-10-06T10:00:00.000Z');

  function openRow(id: string, startMs: number, path: string): void {
    store.addAudioFile({
      id,
      meetingId: MEETING,
      source: 'mic',
      startMs,
      path,
      format: 'wav',
      createdAt: '2026-10-06T09:00:00.000Z',
    });
  }

  function writer(): AudioBackupWriter {
    return new AudioBackupWriter({
      store,
      userData,
      enabled: true,
      logger,
      clock: () => now,
      onFileClosed: () => undefined,
      onChange: () => undefined,
    });
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-backup-repair-'));
    store = new InMemoryTranscriptStore();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('repairs a torn WAV a crash left open and closes its row', () => {
    const id = '2f6a8c1d-5e3b-4a7f-9c2d-8e1f0a3b4c5d';
    const path = storedAudioPath(MEETING, 'mic-000003000-2f6a8c1d.wav');
    // 1.5 s of samples plus half a sample, behind the header written at open (sizes 0).
    writeFileSync(
      join(ensureMeetingAudioDir(userData, MEETING), 'mic-000003000-2f6a8c1d.wav'),
      Buffer.concat([wavHeader(0), Buffer.alloc(48_001, 3)]),
    );
    openRow(id, 3_000, path);

    expect(writer().repairLeftOpen()).toBe(1);

    expect(store.listOpenAudioFiles()).toEqual([]);
    expect(store.listAudioFiles(MEETING)).toEqual([
      expect.objectContaining({
        id,
        endMs: 4_500,
        bytes: WAV_HEADER_BYTES + 48_000,
        closedAt: new Date(now).toISOString(),
      }),
    ]);
    const repaired = readFileSync(join(userData, path));
    expect(repaired.subarray(0, WAV_HEADER_BYTES)).toEqual(wavHeader(48_000));
  });

  it('makes a WAV that never reached the disk an empty one, so its row names a file', () => {
    const id = '5b7c9d0e-1f2a-4b3c-8d4e-6f7a8b9c0d1e';
    const path = storedAudioPath(MEETING, 'system-000001000-5b7c9d0e.wav');
    openRow(id, 1_000, path);

    expect(writer().repairLeftOpen()).toBe(1);

    expect(store.listAudioFiles(MEETING)).toEqual([
      expect.objectContaining({ id, endMs: 1_000, bytes: WAV_HEADER_BYTES }),
    ]);
    expect(readFileSync(join(userData, path))).toEqual(wavHeader(0));
  });

  it('leaves a row whose path is outside the audio folder as it is', () => {
    openRow('8c0d1e2f-3a4b-4c5d-9e6f-0a1b2c3d4e5f', 0, 'roger.wav');

    expect(writer().repairLeftOpen()).toBe(0);
    expect(store.listOpenAudioFiles()).toHaveLength(1);
    expect(existsSync(join(userData, 'roger.wav'))).toBe(false);
  });
});
