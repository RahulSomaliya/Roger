import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS } from '../../shared/capture';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  audioKeep,
  AudioRetentionSweeper,
  RETENTION_SWEEP_INTERVAL_MS,
} from './AudioRetentionSweeper';
import {
  copyBackupFixture,
  FIXTURE_ENDED_AT_MS,
  FIXTURE_GAP_ID,
  FIXTURE_MEETING_ID,
  type FixtureCopy,
} from './testing/backupFixture';

const DAY_MS = 86_400_000;
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('audioKeep', () => {
  const endedAt = '2026-10-06T09:00:05.000Z';

  it('keeps audio for the retention days after the meeting ends', () => {
    expect(audioKeep(endedAt, 0, 7)).toEqual({
      keepUntilMs: FIXTURE_ENDED_AT_MS + 7 * DAY_MS,
      keptForRerun: false,
    });
    // 0 days keeps nothing past the next sweep (the backup is off).
    expect(audioKeep(endedAt, 0, 0).keepUntilMs).toBe(FIXTURE_ENDED_AT_MS);
  });

  it('keeps a meeting with a gap still to re-run up to the 30-day cap', () => {
    expect(audioKeep(endedAt, 1, 7)).toEqual({
      keepUntilMs: FIXTURE_ENDED_AT_MS + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS,
      keptForRerun: true,
    });
  });

  it('never deletes the audio of a meeting that is still open', () => {
    expect(audioKeep(null, 0, 7)).toEqual({ keepUntilMs: null, keptForRerun: false });
    expect(audioKeep(null, 2, 7)).toEqual({ keepUntilMs: null, keptForRerun: true });
  });
});

describe('AudioRetentionSweeper on the backup fixture', () => {
  let now = 0;
  let fixture: FixtureCopy;
  let deleted: string[];

  function sweeper(retentionDays = 7, fail: string | null = null): AudioRetentionSweeper {
    return new AudioRetentionSweeper({
      store: fixture.store,
      retentionDays,
      logger,
      clock: () => now,
      deleteMeetingAudio: (meetingId) => {
        if (meetingId === fail) return Promise.reject(new Error('EACCES'));
        deleted.push(meetingId);
        return Promise.resolve();
      },
    });
  }

  beforeEach(() => {
    now = FIXTURE_ENDED_AT_MS;
    fixture = copyBackupFixture(() => new Date(now));
    deleted = [];
  });

  afterEach(() => {
    fixture.remove();
  });

  it('keeps a meeting with an unrecovered gap past retention, until the 30-day cap', async () => {
    now = FIXTURE_ENDED_AT_MS + 8 * DAY_MS;
    expect(await sweeper().sweep()).toEqual([]);

    now = FIXTURE_ENDED_AT_MS + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS;
    expect(await sweeper().sweep()).toEqual([FIXTURE_MEETING_ID]);
    expect(deleted).toEqual([FIXTURE_MEETING_ID]);
  });

  it('deletes a meeting at its retention once its gap is recovered', async () => {
    fixture.store.markGapRecovered(FIXTURE_GAP_ID, '2026-10-06T10:00:00.000Z');

    now = FIXTURE_ENDED_AT_MS + 7 * DAY_MS - 1;
    expect(await sweeper().sweep()).toEqual([]);
    now = FIXTURE_ENDED_AT_MS + 7 * DAY_MS;
    expect(await sweeper().sweep()).toEqual([FIXTURE_MEETING_ID]);
  });

  it('reads the retention days it is given', async () => {
    fixture.store.markGapRecovered(FIXTURE_GAP_ID, '2026-10-06T10:00:00.000Z');
    now = FIXTURE_ENDED_AT_MS + DAY_MS;

    expect(await sweeper(2).sweep()).toEqual([]);
    expect(await sweeper(1).sweep()).toEqual([FIXTURE_MEETING_ID]);
  });

  it('logs a meeting it could not delete and goes on with the others', async () => {
    const other = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
    fixture.store.createMeeting({ id: other, title: 'T', startedAt: '2026-10-06T08:00:00.000Z' });
    fixture.store.addAudioFile({
      id: '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      meetingId: other,
      source: 'mic',
      startMs: 0,
      path: `audio/${other}/mic.wav`,
      format: 'wav',
      createdAt: '2026-10-06T08:00:00.000Z',
    });
    fixture.store.markMeetingEnded(other, '2026-10-06T08:30:00.000Z');
    now = FIXTURE_ENDED_AT_MS + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS;

    expect(await sweeper(7, FIXTURE_MEETING_ID).sweep()).toEqual([other]);
  });
});

describe('AudioRetentionSweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never deletes the audio of a meeting left open, however old', async () => {
    const store = new InMemoryTranscriptStore();
    const meetingId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    store.createMeeting({ id: meetingId, title: 'T', startedAt: '2026-08-01T09:00:00.000Z' });
    store.addAudioFile({
      id: '2f6a8c1d-5e3b-4a7f-9c2d-8e1f0a3b4c5d',
      meetingId,
      source: 'mic',
      startMs: 0,
      path: `audio/${meetingId}/mic.wav`,
      format: 'wav',
      createdAt: '2026-08-01T09:00:00.000Z',
    });
    const deleteMeetingAudio = vi.fn(() => Promise.resolve());
    const sweeper = new AudioRetentionSweeper({
      store,
      retentionDays: 0,
      logger,
      clock: () => Date.parse('2026-10-07T09:00:00.000Z'),
      deleteMeetingAudio,
    });

    expect(await sweeper.sweep()).toEqual([]);
    expect(deleteMeetingAudio).not.toHaveBeenCalled();
  });

  it('sweeps every hour once started, and stops at quit', async () => {
    vi.useFakeTimers();
    const store = new InMemoryTranscriptStore();
    const listed = vi.spyOn(store, 'listMeetingIdsWithAudio');
    const sweeper = new AudioRetentionSweeper({
      store,
      retentionDays: 7,
      logger,
      deleteMeetingAudio: () => Promise.resolve(),
    });

    sweeper.start();
    expect(listed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETENTION_SWEEP_INTERVAL_MS);
    expect(listed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETENTION_SWEEP_INTERVAL_MS);
    expect(listed).toHaveBeenCalledTimes(2);

    sweeper.stop();
    await vi.advanceTimersByTimeAsync(3 * RETENTION_SWEEP_INTERVAL_MS);
    expect(listed).toHaveBeenCalledTimes(2);
  });
});
