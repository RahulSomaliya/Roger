import { describe, expect, it } from 'vitest';
import {
  BACKUP_MIN_FREE_BYTES,
  type BackupStatus,
  type CaptureGapReason,
  type CaptureReportEvent,
  type CaptureReportGap,
} from '../../../../shared/capture';
import {
  audioNote,
  describeEvent,
  describeGap,
  describeStopReason,
  formatBytes,
  formatKeepDate,
  summarizeGaps,
  WARNING_LABEL,
} from './reportText';

const backup = (fields: Partial<BackupStatus>): BackupStatus => ({
  state: 'kept',
  bytes: 13_002_342,
  keepUntil: '2026-11-04T10:00:00.000Z',
  keptForRerun: false,
  message: null,
  ...fields,
});

const gap = (fields: Partial<CaptureReportGap> = {}): CaptureReportGap => ({
  id: 'g1',
  source: 'system',
  startMs: 61_000,
  endMs: 125_000,
  reason: 'offline',
  recoveredAt: null,
  recoverError: null,
  ...fields,
});

const event = (
  kind: string,
  detail: CaptureReportEvent['detail'] = {},
  source: CaptureReportEvent['source'] = null,
): CaptureReportEvent => ({
  at: '2026-10-07T09:00:00.000Z',
  offsetMs: 0,
  source,
  kind,
  detail,
});

describe('formatBytes', () => {
  it('says what a meeting’s audio takes on disk', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(900)).toBe('900 bytes');
    expect(formatBytes(1_536)).toBe('1.5 KB');
    expect(formatBytes(13_002_342)).toBe('12.4 MB');
    // Binary, as main's own "2 GB" free-space text is (BACKUP_MIN_FREE_BYTES is 2 GiB).
    expect(formatBytes(BACKUP_MIN_FREE_BYTES)).toBe('2 GB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
  });
});

describe('formatKeepDate', () => {
  it('names the day, and the year only when it is not this one', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const day = new Date('2026-11-04T10:00:00.000Z').toLocaleDateString([], {
      day: 'numeric',
      month: 'short',
    });
    expect(formatKeepDate('2026-11-04T10:00:00.000Z', now)).toBe(day);
    expect(formatKeepDate('2027-01-04T10:00:00.000Z', now)).toMatch(/2027$/);
  });
});

describe('audioNote', () => {
  const now = new Date('2026-10-07T12:00:00.000Z');
  const date = formatKeepDate('2026-11-04T10:00:00.000Z', now);

  it('says until when the audio is kept, and offers the delete', () => {
    const note = audioNote(backup({}), 0, now);
    expect(note?.text).toBe(`Audio kept on this Mac until ${date} (12.4 MB).`);
    expect(note?.canDelete).toBe(true);
    expect(note?.canRerun).toBe(false);
  });

  it('says what is not transcribed yet, in the naming list’s words', () => {
    const note = audioNote(backup({ keptForRerun: true }), 2, now);
    expect(note?.text).toBe(
      `Audio kept on this Mac until ${date} (12.4 MB). 2 parts are not transcribed yet.`,
    );
    expect(note?.canRerun).toBe(true);
    expect(note?.canDelete).toBe(true);
  });

  it('reads one part in the singular', () => {
    expect(audioNote(backup({ keptForRerun: true }), 1, now)?.text).toContain(
      '1 part is not transcribed yet',
    );
  });

  it('keeps the audio without a date while main names none', () => {
    expect(audioNote(backup({ keepUntil: null }), 0, now)?.text).toBe(
      'Audio kept on this Mac (12.4 MB).',
    );
  });

  it('offers neither while the audio is still being written: main refuses a delete then', () => {
    const note = audioNote(backup({ state: 'writing', keepUntil: null }), 0, now);
    expect(note?.text).toBe('Roger is keeping this meeting’s audio on this Mac as it records.');
    expect(note?.canDelete).toBe(false);
    expect(note?.canRerun).toBe(false);
  });

  it('says when the backup paused or failed, in main’s words when it has them', () => {
    const paused = audioNote(backup({ state: 'paused', message: 'Disk is nearly full.' }), 0, now);
    expect(paused).toMatchObject({ text: 'Disk is nearly full.' });
    expect(audioNote(backup({ state: 'paused', message: null }), 0, now)?.text).toContain('paused');
    const failed = audioNote(
      backup({ state: 'error', message: 'Roger could not write it' }),
      0,
      now,
    );
    expect(failed).toMatchObject({ text: 'Roger could not write it' });
  });

  it('says the audio is gone, and that its parts can no longer be transcribed again', () => {
    const gone = audioNote(backup({ state: 'deleted', bytes: 0, keepUntil: null }), 0, now);
    expect(gone?.text).toBe('This meeting’s audio is deleted. Its lines stay.');
    expect(gone?.canDelete).toBe(false);
    const withGaps = audioNote(backup({ state: 'deleted', bytes: 0, keepUntil: null }), 3, now);
    expect(withGaps?.text).toBe(
      'This meeting’s audio is deleted. Its lines stay, and its 3 untranscribed parts cannot be transcribed again.',
    );
  });

  it('shows nothing when no audio is kept at all', () => {
    expect(audioNote(backup({ state: 'off', bytes: 0, keepUntil: null }), 0, now)).toBeNull();
  });
});

describe('describeStopReason', () => {
  it('names the stops main records, and says an unknown one as it is', () => {
    expect(describeStopReason(null)).toBeNull();
    expect(describeStopReason('user')).toBe('You pressed Stop.');
    expect(describeStopReason('call-ended')).toBe('Roger stopped because the call ended.');
    expect(describeStopReason('crash')).toBe('Roger closed unexpectedly during this recording.');
    expect(describeStopReason('no-speech')).toBe('Roger stopped: no one spoke for a while.');
    expect(describeStopReason('page-reloaded')).toBe('Stopped: page-reloaded.');
  });
});

describe('describeGap', () => {
  it('gives the span, the stream, why audio was lost, and where transcribing it again stands', () => {
    expect(describeGap(gap())).toEqual({
      span: '00:01:01 to 00:02:05',
      source: 'Call audio',
      reason: 'the Mac was offline',
      status: 'waiting',
      statusText: 'Waiting to be transcribed again',
    });
  });

  it('says a recovered gap was transcribed again, and a failure why, so it can be tried again', () => {
    const recovered = describeGap(gap({ recoveredAt: '2026-10-07T10:30:00.000Z' }));
    expect(recovered.status).toBe('recovered');
    expect(recovered.statusText).toMatch(/^Transcribed again at /);
    const failed = describeGap(gap({ recoverError: 'the audio for it is gone' }));
    expect(failed.status).toBe('failed');
    expect(failed.statusText).toBe('Transcribing again failed: the audio for it is gone');
  });

  it.each<[CaptureGapReason, string]>([
    ['stt_failed', 'speech-to-text failed'],
    ['offline', 'the Mac was offline'],
    ['asleep', 'the Mac was asleep'],
    ['budget', 'the speech-to-text limit for one meeting was reached'],
    ['crash', 'Roger closed unexpectedly'],
  ])('says why for %s', (reason, text) => {
    expect(describeGap(gap({ reason })).reason).toBe(text);
  });
});

describe('summarizeGaps', () => {
  it('counts the gaps, and those transcribed again', () => {
    expect(summarizeGaps([])).toBe('No gaps: Roger recorded no audio it failed to transcribe.');
    expect(summarizeGaps([gap()])).toBe('1 gap, none transcribed again yet.');
    expect(summarizeGaps([gap({ recoveredAt: 'x' }), gap({ id: 'g2' })])).toBe(
      '2 gaps, 1 transcribed again.',
    );
    expect(summarizeGaps([gap({ recoveredAt: 'x' })])).toBe('1 gap, transcribed again.');
    expect(summarizeGaps([gap({ recoveredAt: 'x' }), gap({ id: 'g2', recoveredAt: 'y' })])).toBe(
      '2 gaps, all transcribed again.',
    );
  });
});

describe('describeEvent', () => {
  it('says each warning by its kind, with how long it lasted', () => {
    expect(describeEvent(event('warning', { warning: 'mic-dead', loud: true }, 'mic'))).toBe(
      `Warning: ${WARNING_LABEL['mic-dead']}`,
    );
    expect(describeEvent(event('warning-cleared', { warning: 'offline', lastedMs: 95_000 }))).toBe(
      `Cleared: ${WARNING_LABEL.offline} (lasted 1m 35s)`,
    );
  });

  it('says the audio and helper events', () => {
    expect(describeEvent(event('device-switched', { device: 'AirPods Pro' }, 'mic'))).toBe(
      'Mic switched to AirPods Pro',
    );
    expect(describeEvent(event('helper-restarted', { cause: 'hung', restarts: 1 }, 'system'))).toBe(
      'Call audio helper restarted (it stopped responding)',
    );
    expect(describeEvent(event('helper-restarted', { cause: 'crashed', restarts: 2 }))).toBe(
      'Call audio helper restarted (it crashed)',
    );
    expect(describeEvent(event('tap-rebuilt', { reason: 'output_device_changed' }))).toBe(
      'Call audio followed the new output device',
    );
    expect(describeEvent(event('tap-rebuilt', { reason: 'tap_format_changed' }))).toBe(
      'Call audio followed a change of the output format',
    );
    expect(describeEvent(event('tap-rebuilt', { reason: 'x' }))).toBe('Call audio capture rebuilt');
    expect(describeEvent(event('helper-failed', { detail: 'exit 1' }))).toBe(
      'Call audio helper failed for good: exit 1',
    );
    expect(describeEvent(event('helper-format-refused', { encoding: 'f32' }))).toBe(
      'Call audio helper refused: it sent a format Roger cannot read',
    );
    expect(describeEvent(event('helper-missing', { reason: 'not found' }))).toBe(
      'No call audio helper: not found',
    );
  });

  it('says the backup events', () => {
    expect(
      describeEvent(
        event('backup_paused', {
          freeBytes: 1.5 * 1024 ** 3,
          minFreeBytes: BACKUP_MIN_FREE_BYTES,
        }),
      ),
    ).toBe('Audio backup paused: 1.5 GB free, under 2 GB');
    expect(describeEvent(event('backup_resumed', { freeBytes: 3 * 1024 ** 3 }))).toBe(
      'Audio backup resumed: 3 GB free',
    );
    expect(describeEvent(event('backup_failed', { error: 'ENOSPC' }))).toBe(
      'Audio backup failed (ENOSPC)',
    );
    expect(describeEvent(event('backup_failed', { error: 'unknown' }))).toBe('Audio backup failed');
    expect(describeEvent(event('audio_deleted', { by: 'user', files: 3 }))).toBe(
      'Audio deleted by you (3 files)',
    );
    expect(describeEvent(event('audio_deleted', { by: 'retention', files: 1 }))).toBe(
      'Audio deleted after its retention (1 file)',
    );
  });

  it('says the speech-to-text events', () => {
    expect(describeEvent(event('stt-paused', { silentForMs: 61_000 }, 'system'))).toBe(
      'Speech-to-text paused after 1m 01s with no audio',
    );
    expect(
      describeEvent(
        event('stt-failed', { stage: 'reopen', reason: 'could not reconnect', retryInMs: 4000 }),
      ),
    ).toBe('Speech-to-text failed (reopen): could not reconnect; retrying in 4s');
    expect(
      describeEvent(event('stt-failed', { stage: 'finish', reason: 'x', retryInMs: null })),
    ).toBe('Speech-to-text failed (finish): x');
    expect(
      describeEvent(event('stt-budget-refused', { limit: 'per-minute', retryInMs: 30_000 })),
    ).toBe('Speech-to-text reopen refused (per-minute limit); retrying in 30s');
    expect(
      describeEvent(event('stt-budget-refused', { limit: 'per-meeting', retryInMs: null })),
    ).toBe('Speech-to-text reopen refused (per-meeting limit)');
    expect(describeEvent(event('stt-closed', { reason: 'the vendor closed the stream' }))).toBe(
      'Speech-to-text closed: the vendor closed the stream',
    );
    expect(describeEvent(event('stt-suspended', { reason: 'asleep' }))).toBe(
      'Speech-to-text suspended: the Mac slept',
    );
    expect(describeEvent(event('stt-suspended', { reason: 'offline' }))).toBe(
      'Speech-to-text suspended: the Mac went offline',
    );
    expect(
      describeEvent(event('stt-resumed', { reason: 'offline', suspendedForMs: 125_000 })),
    ).toBe('Speech-to-text resumed after 2m 05s (the Mac went offline)');
    expect(describeEvent(event('stt-reopened', { heldMs: 2_000, droppedChunks: 0 }))).toBe(
      'Speech-to-text reopened, sending the 2s held meanwhile',
    );
    expect(describeEvent(event('stt-reopened', { heldMs: 2_000, droppedChunks: 5 }))).toBe(
      'Speech-to-text reopened, sending the 2s held meanwhile (5 chunks dropped)',
    );
  });

  it('says the crash resume', () => {
    expect(
      describeEvent(
        event('resumed_after_crash', {
          downMs: 130_000,
          trigger: 'relaunch',
          callApp: null,
          gaps: 1,
        }),
      ),
    ).toBe('Roger restarted after 2m 10s and kept taking notes');
    expect(
      describeEvent(
        event('resumed_after_crash', {
          downMs: 5_000,
          trigger: 'call-app',
          callApp: 'Zoom',
          gaps: 0,
        }),
      ),
    ).toBe('Roger restarted after 5s and kept taking notes (Zoom was on the mic)');
  });

  it('shows a kind it has no words for as it is, with its codes and numbers', () => {
    expect(describeEvent(event('stt-gate-closed', { silentForMs: 90_000 }))).toBe(
      'stt-gate-closed (silentForMs 90000)',
    );
    expect(describeEvent(event('something-new'))).toBe('something-new');
  });

  it('survives a detail of the wrong shape: it is stored JSON, not a promise', () => {
    expect(describeEvent(event('warning', { warning: 3 }))).toBe('Warning');
    expect(describeEvent(event('stt-paused', { silentForMs: 'long' }))).toBe(
      'Speech-to-text paused',
    );
    expect(describeEvent(event('device-switched', {}))).toBe('Mic switched device');
  });
});
