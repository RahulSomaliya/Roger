import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS, BACKUP_MIN_FREE_BYTES } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource } from '../../shared/transcript';
import type { AudioSink } from '../capture/AudioFanout';
import type { StatusContribution } from '../capture/CaptureService';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { TranscriptStore } from '../store/TranscriptStore';
import { AudioBackup, type AudioBackupCapture } from './AudioBackup';
import { DISK_CHECK_INTERVAL_MS } from './AudioBackupWriter';
import type { RunTool } from './AudioCompressor';
import { audioRoot, meetingAudioDir, storedAudioPath } from './audioPaths';
import {
  copyBackupFixture,
  FIXTURE_ENDED_AT_MS,
  FIXTURE_GAP_ID,
  FIXTURE_MEETING_ID,
  type FixtureCopy,
} from './testing/backupFixture';
import { WAV_HEADER_BYTES, wavHeader } from './wav';

const MEETING = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const DAY_MS = 86_400_000;
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

interface Listener {
  started?(recording: { meetingId: string; meetingStartedAtMs: number }): void;
  ended?(recording: { meetingId: string }): void;
}

/** CaptureService's four seams, driven by hand. */
function fakeCapture() {
  const sinks: AudioSink[] = [];
  const listeners: Listener[] = [];
  let read: (() => StatusContribution) | null = null;
  let refreshes = 0;
  const capture: AudioBackupCapture = {
    addAudioSink: (_name, sink) => {
      sinks.push(sink);
      return () => undefined;
    },
    addStatusContributor: (_name, contributor) => {
      read = contributor;
      return () => undefined;
    },
    onRecording: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    refreshStatus: () => {
      refreshes += 1;
    },
  };
  return {
    capture,
    start: (meetingId: string, meetingStartedAtMs: number) => {
      for (const listener of listeners) listener.started?.({ meetingId, meetingStartedAtMs });
    },
    chunk: (source: AudioSource, ms: number, capturedAtMs: number) => {
      const pcm = new Uint8Array((ms * PCM_SAMPLE_RATE * 2) / 1_000).fill(1);
      for (const sink of sinks) sink.onChunk(source, pcm, capturedAtMs);
    },
    end: (meetingId: string) => {
      for (const listener of listeners) listener.ended?.({ meetingId });
    },
    status: (): StatusContribution => read?.() ?? {},
    refreshes: () => refreshes,
  };
}

/** afconvert stand-in that "encodes" at once. */
const encodeAtOnce: RunTool = (_command, args) => {
  writeFileSync(args.at(-1) ?? '', 'm4a');
  return Promise.resolve();
};

describe('AudioBackup', () => {
  let userData = '';
  let store: InMemoryTranscriptStore;
  let now = T0;
  let freeBytes = 100 * BACKUP_MIN_FREE_BYTES;

  function backupFor(
    capture: AudioBackupCapture,
    options: { audioBackup?: boolean; on?: TranscriptStore; root?: string } = {},
  ): AudioBackup {
    return new AudioBackup({
      capture,
      store: options.on ?? store,
      userData: options.root ?? userData,
      settings: { audioBackup: options.audioBackup ?? true, audioRetentionDays: 7 },
      logger,
      clock: () => now,
      freeDiskBytes: () => freeBytes,
      run: encodeAtOnce,
    });
  }

  /** A recording of one second per stream, stopped as CaptureService stops one. */
  function record(fake: ReturnType<typeof fakeCapture>): void {
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    for (let at = 0; at < 1_000; at += 100) {
      now = T0 + at + 100;
      fake.chunk('mic', 100, T0 + at);
      fake.chunk('system', 100, T0 + at);
    }
    store.markMeetingEnded(MEETING, new Date(now).toISOString());
    fake.end(MEETING);
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-backup-'));
    store = new InMemoryTranscriptStore(() => new Date(now));
    now = T0;
    freeBytes = 100 * BACKUP_MIN_FREE_BYTES;
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('keeps a recording through the capture seams, and the status follows it', async () => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    expect(fake.status()).toEqual({});

    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    now = T0 + 100;
    fake.chunk('mic', 100, T0);
    expect(fake.status()).toEqual({
      backup: {
        state: 'writing',
        bytes: WAV_HEADER_BYTES + 3_200,
        keepUntil: null,
        keptForRerun: false,
        message: null,
      },
    });
    store.markMeetingEnded(MEETING, new Date(now).toISOString());
    fake.end(MEETING);
    await backup.idle();

    // The last meeting's backup after Stop, its WAV now an m4a.
    expect(fake.status()).toEqual({
      backup: {
        state: 'kept',
        bytes: 3,
        keepUntil: new Date(now + 7 * DAY_MS).toISOString(),
        keptForRerun: false,
        message: null,
      },
    });
    expect(store.listAudioFiles(MEETING).map((file) => file.format)).toEqual(['m4a']);
    expect(fake.refreshes()).toBeGreaterThan(0);
  });

  it("shows the meeting's audio on disk while recording, an encoded file at its m4a size", async () => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    for (let at = 0; at < 61_000; at += 100) {
      now = T0 + at + 100;
      fake.chunk('mic', 100, T0 + at);
    }
    // The first minute is encoded while the call goes on.
    await backup.idle();

    expect(store.listAudioFiles(MEETING).map((file) => file.format)).toEqual(['m4a', 'wav']);
    // encodeAtOnce's m4a holds 3 bytes; the second minute is a WAV of 1 s so far.
    expect(fake.status().backup?.bytes).toBe(3 + WAV_HEADER_BYTES + 32_000);
    fake.end(MEETING);
  });

  it('warns while the disk is nearly full, and the warning ends with the recording', () => {
    freeBytes = BACKUP_MIN_FREE_BYTES - 1;
    const fake = fakeCapture();
    backupFor(fake.capture).start();

    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    expect(fake.status().backup?.state).toBe('paused');
    expect(fake.status().warnings?.map(({ kind, loud }) => ({ kind, loud }))).toEqual([
      { kind: 'backup-paused', loud: true },
    ]);

    store.markMeetingEnded(MEETING, new Date(now).toISOString());
    fake.end(MEETING);
    // Never `warnings: []`: a status with no warnings has none at all.
    expect(fake.status()).not.toHaveProperty('warnings');
    // Paused for the whole call: nothing is kept, and the status says why.
    expect(fake.status().backup).toMatchObject({ state: 'paused', bytes: 0 });
  });

  it('reports a backup paused for the whole call as paused, after Stop and after a relaunch', () => {
    freeBytes = BACKUP_MIN_FREE_BYTES - 1;
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();

    record(fake);

    const report = backup.report(MEETING);
    // Never `off`: that says config.json turned the backup off.
    expect(report).toEqual({
      state: 'paused',
      bytes: 0,
      keepUntil: null,
      keptForRerun: false,
      message: "None of this call's audio was kept: less than 2 GB of disk was free.",
    });
    expect(fake.status().backup).toEqual(report);
    // Read from the store, so the next launch says the same.
    expect(backupFor(fakeCapture().capture).report(MEETING)).toEqual(report);
  });

  it('reports a backup that failed before its first file as an error, with its code', () => {
    // mkdir of the audio root fails with EEXIST, as an unwritable userData would with EACCES.
    writeFileSync(audioRoot(userData), 'in the way');
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();

    record(fake);

    const report = backup.report(MEETING);
    expect(report).toEqual({
      state: 'error',
      bytes: 0,
      keepUntil: null,
      keptForRerun: false,
      message: "None of this call's audio was kept: Roger could not write it to disk (EEXIST).",
    });
    expect(fake.status().backup).toEqual(report);
    expect(backupFor(fakeCapture().capture).report(MEETING)).toEqual(report);
  });

  it.each([
    ['paused until Stop', false],
    ['paused, then resumed', true],
  ])('reports kept audio as missing part of the call when the backup %s', async (_how, resume) => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    now = T0 + 100;
    fake.chunk('mic', 100, T0);
    freeBytes = BACKUP_MIN_FREE_BYTES - 1;
    now = T0 + DISK_CHECK_INTERVAL_MS;
    fake.chunk('mic', 100, now - 100);
    if (resume) {
      freeBytes = BACKUP_MIN_FREE_BYTES;
      now = T0 + 2 * DISK_CHECK_INTERVAL_MS;
      fake.chunk('mic', 100, now - 100);
    }
    store.markMeetingEnded(MEETING, new Date(now).toISOString());
    fake.end(MEETING);
    await backup.idle();

    const report = backup.report(MEETING);
    // Still `kept`, so the audio that is there can be seen and deleted.
    expect(report).toEqual({
      state: 'kept',
      bytes: store.listAudioFiles(MEETING).reduce((sum, file) => sum + file.bytes, 0),
      keepUntil: new Date(now + 7 * DAY_MS).toISOString(),
      keptForRerun: false,
      message: "Part of this call's audio was not kept: less than 2 GB of disk was free.",
    });
    expect(report.bytes).toBeGreaterThan(0);
    expect(fake.status().backup).toEqual(report);
  });

  it('keeps no audio when config.json turns the backup off', () => {
    const fake = fakeCapture();
    backupFor(fake.capture, { audioBackup: false }).start();

    record(fake);

    expect(store.listAudioFiles(MEETING)).toEqual([]);
    expect(fake.status().backup?.state).toBe('off');
    expect(existsSync(audioRoot(userData))).toBe(false);
  });

  it("deletes a meeting's audio for the user, and its report says so", async () => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    record(fake);
    await backup.idle();

    await backup.deleteMeetingAudio(MEETING);

    expect(existsSync(meetingAudioDir(userData, MEETING))).toBe(false);
    expect(store.listAudioFiles(MEETING)).toEqual([]);
    expect(backup.report(MEETING)).toEqual({
      state: 'deleted',
      bytes: 0,
      keepUntil: null,
      keptForRerun: false,
      message: null,
    });
    expect(fake.status().backup?.state).toBe('deleted');
    expect(store.listCaptureEvents(MEETING).at(-1)).toMatchObject({
      kind: 'audio_deleted',
      detail: { by: 'user', files: 2 },
    });
    // The meeting and its lines stay: only the audio goes.
    expect(store.getMeeting(MEETING)).not.toBeNull();
  });

  it('refuses to delete the audio of the meeting being recorded', async () => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    fake.chunk('mic', 100, T0);

    await expect(backup.deleteMeetingAudio(MEETING)).rejects.toThrow(/being recorded/);
    expect(readdirSync(meetingAudioDir(userData, MEETING))).toHaveLength(1);
    fake.end(MEETING);
  });

  it.each([
    ['a parent folder', '../x'],
    ['an absolute path', '/Users'],
  ])('refuses %s as the meeting to delete, and deletes nothing', async (_what, meetingId) => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    record(fake);
    await backup.idle();

    await expect(backup.deleteMeetingAudio(meetingId)).rejects.toThrow(/not a meeting id/);
    expect(readdirSync(meetingAudioDir(userData, MEETING))).toHaveLength(2);
  });

  it('closes the files of a recording still running at quit, and stops its work', async () => {
    const fake = fakeCapture();
    const backup = backupFor(fake.capture);
    backup.start();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: new Date(T0).toISOString() });
    fake.start(MEETING, T0);
    fake.chunk('mic', 100, T0);

    expect(backup.quitHook.name).toBe('stop the audio backup');
    await backup.quitHook.run();

    expect(store.listOpenAudioFiles()).toEqual([]);
  });
});

describe('AudioBackup on the backup fixture', () => {
  let now = FIXTURE_ENDED_AT_MS;
  let fixture: FixtureCopy;

  function backupFor(capture: AudioBackupCapture): AudioBackup {
    return new AudioBackup({
      capture,
      store: fixture.store,
      userData: fixture.userData,
      settings: { audioBackup: true, audioRetentionDays: 7 },
      logger,
      clock: () => now,
      freeDiskBytes: () => 100 * BACKUP_MIN_FREE_BYTES,
      run: encodeAtOnce,
    });
  }

  beforeEach(() => {
    now = FIXTURE_ENDED_AT_MS + DAY_MS;
    fixture = copyBackupFixture(() => new Date(now));
  });

  afterEach(() => {
    fixture.remove();
  });

  it('reports a meeting kept for its gap past retention, up to the 30-day cap', () => {
    const backup = backupFor(fakeCapture().capture);
    const files = fixture.store.listAudioFiles(FIXTURE_MEETING_ID);

    expect(backup.report(FIXTURE_MEETING_ID)).toEqual({
      state: 'kept',
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      keepUntil: new Date(
        FIXTURE_ENDED_AT_MS + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS,
      ).toISOString(),
      keptForRerun: true,
      message: null,
    });
  });

  it('repairs what a crash left open at launch, then encodes every WAV left over', async () => {
    const torn = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const name = 'system-000005000-3c1d2e4f.wav';
    writeFileSync(
      join(meetingAudioDir(fixture.userData, FIXTURE_MEETING_ID), name),
      Buffer.concat([wavHeader(0), Buffer.alloc(16_000, 2)]),
    );
    fixture.store.addAudioFile({
      id: torn,
      meetingId: FIXTURE_MEETING_ID,
      source: 'system',
      startMs: 5_000,
      path: storedAudioPath(FIXTURE_MEETING_ID, name),
      format: 'wav',
      createdAt: '2026-10-06T09:00:05.000Z',
    });
    const backup = backupFor(fakeCapture().capture);

    backup.start();
    // Synchronous, so the gap re-run's slot (after this one) finds every file closed.
    expect(fixture.store.listOpenAudioFiles()).toEqual([]);
    await backup.idle();

    const files = fixture.store.listAudioFiles(FIXTURE_MEETING_ID);
    expect(files.map((file) => [file.source, file.startMs, file.endMs, file.format])).toEqual([
      ['mic', 0, 2_000, 'm4a'],
      ['system', 0, 2_000, 'm4a'],
      ['mic', 3_000, 5_000, 'm4a'],
      ['system', 3_000, 5_000, 'm4a'],
      ['system', 5_000, 5_500, 'm4a'],
    ]);
    expect(
      readdirSync(meetingAudioDir(fixture.userData, FIXTURE_MEETING_ID)).filter((file) =>
        file.endsWith('.wav'),
      ),
    ).toEqual([]);
  });

  it('deletes audio past its retention at launch', async () => {
    fixture.store.markGapRecovered(FIXTURE_GAP_ID, '2026-10-06T10:00:00.000Z');
    now = FIXTURE_ENDED_AT_MS + 8 * DAY_MS;
    const backup = backupFor(fakeCapture().capture);

    backup.start();
    await backup.idle();

    expect(existsSync(meetingAudioDir(fixture.userData, FIXTURE_MEETING_ID))).toBe(false);
    expect(backup.report(FIXTURE_MEETING_ID).state).toBe('deleted');
    expect(fixture.store.listCaptureEvents(FIXTURE_MEETING_ID).at(-1)).toMatchObject({
      kind: 'audio_deleted',
      detail: { by: 'retention', files: 4 },
    });
    await backup.quitHook.run();
  });
});
