import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../../shared/transcript';
import { InMemoryTranscriptStore } from './InMemoryTranscriptStore';
import { SqliteTranscriptStore } from './SqliteTranscriptStore';
import type {
  MeetingSttUsage,
  NewAudioFile,
  NewTranscriptGap,
  TranscriptStore,
} from './TranscriptStore';

function segment(n: number, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: `seg-${n}`,
    meetingId: 'm1',
    source: 'mic',
    speaker: 'me',
    startMs: n * 1000,
    endMs: n * 1000 + 800,
    text: `line ${n}`,
    confidence: 0.5,
    words: [{ text: `line`, startMs: n * 1000, endMs: n * 1000 + 400, confidence: null }],
    createdAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  };
}

/** Undo migration 4 on a file, leaving it as the cost-guard build (schema 3) wrote it. */
function windBackToSchema3(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TABLE app_state;
    DROP TABLE capture_events;
    DROP TABLE audio_files;
    DROP TABLE transcript_gaps;
    DROP INDEX segments_held;
    ALTER TABLE segments DROP COLUMN suppressed_reason;
    ALTER TABLE segments DROP COLUMN echo_of;
    ALTER TABLE segments DROP COLUMN original_text;
    ALTER TABLE segments DROP COLUMN original_words_json;
    ALTER TABLE segments DROP COLUMN upload_after;
    ALTER TABLE segments DROP COLUMN origin;
    ALTER TABLE meetings DROP COLUMN stop_reason;
    PRAGMA user_version = 3;
  `);
  raw.close();
}

describe('SqliteTranscriptStore', () => {
  it('stores meetings and segments, lists unsynced lines in order and marks them synced', () => {
    const store = new SqliteTranscriptStore(':memory:');
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment(2));
    store.appendSegment(segment(1, { id: 'seg-1-system', source: 'system', speaker: 'them' }));
    store.appendSegment(segment(1));
    store.appendSegment(segment(1)); // duplicate id is ignored

    expect(store.countSegments('m1')).toBe(3);
    expect(store.listUnsyncedSegments('m1', 10).map((s) => [s.id, s.source])).toEqual([
      ['seg-1', 'mic'],
      ['seg-1-system', 'system'],
      ['seg-2', 'mic'],
    ]);
    expect(store.listUnsyncedSegments('m1', 10)[0]).toEqual(segment(1));

    store.markSegmentsSynced(['seg-1', 'seg-2'], '2026-10-05T10:01:00Z');
    expect(store.countUnsyncedSegments()).toBe(1);
    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual(['seg-1-system']);
    store.close();
  });

  it('tracks meeting sync state and ends a meeting only once', () => {
    const store = new SqliteTranscriptStore(':memory:');
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.createMeeting({ id: 'm1', title: 'again', startedAt: '2026-10-05T11:00:00Z' }); // idempotent
    expect(store.getMeeting('m1')).toEqual({
      id: 'm1',
      title: 'T',
      startedAt: '2026-10-05T10:00:00Z',
      endedAt: null,
      remoteState: 'pending',
    });

    store.markMeetingEnded('m1', '2026-10-05T10:30:00Z');
    store.markMeetingEnded('m1', '2026-10-05T10:45:00Z');
    expect(store.getMeeting('m1')?.endedAt).toBe('2026-10-05T10:30:00Z');

    expect(store.listMeetingsNeedingSync().map((m) => m.id)).toEqual(['m1']);
    store.setMeetingRemoteState('m1', 'ended');
    expect(store.listMeetingsNeedingSync()).toEqual([]);
    store.close();
  });

  it('excludes rejected lines from the upload queue and counts them', () => {
    const store = new SqliteTranscriptStore(':memory:');
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment(1));
    store.appendSegment(segment(2));
    store.markSegmentRejected('seg-1', 'text too short', '2026-10-05T10:01:00Z');
    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual(['seg-2']);
    expect(store.countUnsyncedSegments()).toBe(1);
    expect(store.countRejectedSegments()).toBe(1);
    expect(store.countSegments('m1')).toBe(2);
    store.close();
  });

  it('ends meetings a crash left open at their last line, and can forget uploads for a lost meeting', () => {
    const store = new SqliteTranscriptStore(':memory:');
    store.createMeeting({ id: 'with-lines', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(
      segment(1, { meetingId: 'with-lines', createdAt: '2026-10-05T10:05:00.000Z' }),
    );
    store.appendSegment(
      segment(2, { meetingId: 'with-lines', createdAt: '2026-10-05T10:09:00.000Z' }),
    );
    store.createMeeting({ id: 'silent', title: 'T', startedAt: '2026-10-05T11:00:00Z' });
    store.createMeeting({ id: 'done', title: 'T', startedAt: '2026-10-05T09:00:00Z' });
    store.markMeetingEnded('done', '2026-10-05T09:30:00Z');

    expect(store.endMeetingsLeftOpen('2026-10-05T12:00:00Z')).toBe(2);
    expect(store.getMeeting('with-lines')?.endedAt).toBe('2026-10-05T10:09:00.000Z');
    expect(store.getMeeting('silent')?.endedAt).toBe('2026-10-05T11:00:00Z');
    expect(store.getMeeting('done')?.endedAt).toBe('2026-10-05T09:30:00Z');

    store.markSegmentsSynced(['seg-1', 'seg-2'], '2026-10-05T10:10:00Z');
    store.markSegmentRejected('seg-2', 'bad', '2026-10-05T10:11:00Z'); // no-op: already synced
    expect(store.countUnsyncedSegments()).toBe(0);
    store.resetSyncForMeeting('with-lines');
    expect(store.listUnsyncedSegments('with-lines', 10).map((s) => s.id)).toEqual([
      'seg-1',
      'seg-2',
    ]);
    store.close();
  });

  it('deletes only meetings with no lines', () => {
    const store = new SqliteTranscriptStore(':memory:');
    store.createMeeting({ id: 'empty', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment(1));
    expect(store.deleteMeetingIfEmpty('empty')).toBe(true);
    expect(store.deleteMeetingIfEmpty('m1')).toBe(false);
    expect(store.getMeeting('m1')).not.toBeNull();
    store.close();
  });

  it('keeps data across restarts and does not re-run migrations', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-store-')), 'roger.sqlite');
    const first = new SqliteTranscriptStore(path);
    first.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    first.appendSegment(segment(1));
    first.close();

    const second = new SqliteTranscriptStore(path);
    expect(second.getMeeting('m1')?.title).toBe('T');
    expect(second.countUnsyncedSegments()).toBe(1);
    second.close();
  });

  it('adds the usage table to a store written before it, keeping its data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-store-')), 'roger.sqlite');
    const first = new SqliteTranscriptStore(path);
    first.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    first.close();
    // Wind the file back to schema 2, as a Mac that ran the app before this change has it.
    windBackToSchema3(path);
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE stt_usage; PRAGMA user_version = 2');
    raw.close();

    const second = new SqliteTranscriptStore(path);
    second.saveSttUsage(usage('m1'));
    second.close();
    const third = new SqliteTranscriptStore(path); // the migration does not run twice
    expect(third.getSttUsage('m1')).toEqual(usage('m1'));
    expect(third.getMeeting('m1')?.title).toBe('T');
    third.close();
  });
});

function usage(meetingId: string, overrides: Partial<MeetingSttUsage> = {}): MeetingSttUsage {
  const source = (connectedMs: number) => ({
    sessionsOpened: 1,
    connectedMs,
    audioSentMs: connectedMs - 1_000,
    droppedChunks: 0,
    estimatedCostUsd: 0.0025,
  });
  return {
    meetingId,
    provider: 'assemblyai',
    total: {
      sessionsOpened: 2,
      connectedMs: 120_000,
      audioSentMs: 118_000,
      droppedChunks: 0,
      estimatedCostUsd: 0.005,
    },
    bySource: { mic: source(60_000), system: source(60_000) },
    stopReason: null,
    updatedAt: '2026-10-06T10:02:00.000Z',
    ...overrides,
  };
}

describe.each([
  ['SqliteTranscriptStore', () => new SqliteTranscriptStore(':memory:')],
  ['InMemoryTranscriptStore', () => new InMemoryTranscriptStore()],
])('%s speech-to-text usage', (_name, open: () => TranscriptStore) => {
  it('keeps one usage row per meeting, the latest one winning', () => {
    const store = open();
    expect(store.getSttUsage('m1')).toBeNull();
    store.saveSttUsage(usage('m1'));
    const final = usage('m1', {
      total: { ...usage('m1').total, connectedMs: 300_000, estimatedCostUsd: null },
      stopReason: 'no-speech',
    });
    store.saveSttUsage(final);
    expect(store.getSttUsage('m1')).toEqual(final);
    store.close();
  });

  it('keeps the usage of a meeting deleted for having no lines: its sessions were still billed', () => {
    const store = open();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.saveSttUsage(usage('m1'));
    expect(store.deleteMeetingIfEmpty('m1')).toBe(true);
    expect(store.getSttUsage('m1')).toEqual(usage('m1'));
    store.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Migration 4 (M2-T3): echo state, holds and origin on lines, the meeting's stop reason, gaps,
// audio files, capture events and device state.

const T0 = '2026-10-06T10:00:00.000Z';

function manualClock(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = new Date(iso);
  return {
    now: () => current,
    set: (next) => {
      current = new Date(next);
    },
  };
}

function gap(id: string, overrides: Partial<NewTranscriptGap> = {}): NewTranscriptGap {
  return {
    id,
    meetingId: 'm1',
    source: 'system',
    startMs: 10_000,
    endMs: 14_000,
    reason: 'stt_failed',
    createdAt: T0,
    ...overrides,
  };
}

function audioFile(id: string, overrides: Partial<NewAudioFile> = {}): NewAudioFile {
  return {
    id,
    meetingId: 'm1',
    source: 'mic',
    startMs: 0,
    path: `audio/m1/${id}.wav`,
    format: 'wav',
    createdAt: T0,
    ...overrides,
  };
}

describe.each([
  [
    'SqliteTranscriptStore',
    (clock: () => Date): TranscriptStore => new SqliteTranscriptStore(':memory:', clock),
  ],
  [
    'InMemoryTranscriptStore',
    (clock: () => Date): TranscriptStore => new InMemoryTranscriptStore(clock),
  ],
])('%s capture state (migration 4)', (_name, open: (clock: () => Date) => TranscriptStore) => {
  function openWithMeeting(at = T0): {
    store: TranscriptStore;
    clock: ReturnType<typeof manualClock>;
  } {
    const clock = manualClock(at);
    const store = open(clock.now);
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    return { store, clock };
  }

  it('does not count hidden or held lines as waiting; a held line waits for its release or its cap', () => {
    const { store, clock } = openWithMeeting('2026-10-06T10:01:59.999Z');
    store.appendSegment(segment(1));
    store.appendSegment(segment(2));
    store.appendSegment(segment(3));
    store.appendSegment(segment(4, { id: 'seg-4-system', source: 'system', speaker: 'them' }));
    expect(store.suppressSegment('seg-1', 'echo', 'seg-4-system')).toBe(true);
    // Written without milliseconds on purpose: the cap must compare as an instant, not as text
    // ("...02:00Z" sorts after "...02:00.000Z").
    expect(store.holdSegment('seg-2', '2026-10-06T10:02:00Z')).toBe(true);
    expect(store.holdSegment('seg-3', '2026-10-06T10:00:00.000Z')).toBe(true); // cap already past

    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual([
      'seg-3',
      'seg-4-system',
    ]);
    expect(store.countUnsyncedSegments()).toBe(2);

    clock.set('2026-10-06T10:02:00.000Z');
    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual([
      'seg-2',
      'seg-3',
      'seg-4-system',
    ]);
    expect(store.countUnsyncedSegments()).toBe(3);
    store.close();
  });

  it('lists held lines for the settle and releases them on a decision', () => {
    const { store } = openWithMeeting();
    store.createMeeting({ id: 'm2', title: 'T', startedAt: '2026-10-06T09:30:00.000Z' });
    store.appendSegment(segment(2));
    store.appendSegment(segment(1));
    store.appendSegment(segment(3, { meetingId: 'm2' }));
    store.appendSegment(segment(4)); // never held
    for (const id of ['seg-1', 'seg-2', 'seg-3']) {
      expect(store.holdSegment(id, '2026-10-06T10:02:00.000Z')).toBe(true);
    }

    expect(store.listHeldSegments('m1').map((s) => s.id)).toEqual(['seg-1', 'seg-2']);
    expect(store.listHeldSegments().map((s) => s.id)).toEqual(['seg-1', 'seg-2', 'seg-3']);
    expect(store.listHeldSegments('m1')[0]).toEqual({
      ...segment(1),
      origin: 'live',
      suppressedReason: null,
      echoOf: null,
      originalText: null,
      originalWords: null,
      uploadAfter: '2026-10-06T10:02:00.000Z',
      syncedAt: null,
    });

    store.releaseSegments(['seg-1', 'seg-3']);
    expect(store.listHeldSegments().map((s) => s.id)).toEqual(['seg-2']);
    expect(store.getSegment('seg-1')?.uploadAfter).toBeNull();
    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual(['seg-1', 'seg-4']);
    store.close();
  });

  it('never holds, hides or trims a line already uploaded: Postgres keeps it as it was sent', () => {
    const { store } = openWithMeeting();
    store.appendSegment(segment(1));
    store.markSegmentsSynced(['seg-1'], T0);

    expect(store.holdSegment('seg-1', '2026-10-06T10:02:00.000Z')).toBe(false);
    expect(store.suppressSegment('seg-1', 'echo', 'sys-1')).toBe(false);
    expect(store.trimSegment('seg-1', { text: 'line', words: null, echoOf: 'sys-1' })).toBe(false);
    expect(store.getSegment('seg-1')).toMatchObject({
      text: 'line 1',
      suppressedReason: null,
      echoOf: null,
      originalText: null,
      uploadAfter: null,
      syncedAt: T0,
    });
    expect(store.holdSegment('missing', '2026-10-06T10:02:00.000Z')).toBe(false);
    expect(store.getSegment('missing')).toBeNull();
    store.close();
  });

  it('hides a line with its reason and twin, ends its hold, and unhides it for upload', () => {
    const { store } = openWithMeeting();
    store.appendSegment(segment(1));
    store.holdSegment('seg-1', '2026-10-06T10:02:00.000Z');

    expect(store.suppressSegment('seg-1', 'echo', 'sys-9')).toBe(true);
    expect(store.getSegment('seg-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'sys-9',
      uploadAfter: null,
    });
    expect(store.listHeldSegments()).toEqual([]);
    expect(store.listUnsyncedSegments('m1', 10)).toEqual([]);

    expect(store.unhideSegment('seg-1')).toBe(true);
    expect(store.getSegment('seg-1')).toMatchObject({ suppressedReason: null, echoOf: null });
    expect(store.listUnsyncedSegments('m1', 10)).toEqual([segment(1)]);
    expect(store.unhideSegment('seg-1')).toBe(false); // not hidden any more
    expect(store.unhideSegment('missing')).toBe(false);
    store.close();
  });

  it('trims echo words, keeping the line as the vendor wrote it; a second trim keeps that original', () => {
    const { store } = openWithMeeting();
    const words = ['so', 'the', 'plan', 'is', 'ship', 'it'].map((text, index) => ({
      text,
      startMs: 1000 + index * 100,
      endMs: 1080 + index * 100,
      confidence: 0.9,
    }));
    store.appendSegment(segment(1, { text: 'so the plan is ship it', words }));
    store.holdSegment('seg-1', '2026-10-06T10:02:00.000Z');
    const kept = [words[0]!, words[4]!, words[5]!];

    expect(store.trimSegment('seg-1', { text: 'so ship it', words: kept, echoOf: 'sys-1' })).toBe(
      true,
    );
    expect(store.getSegment('seg-1')).toMatchObject({
      text: 'so ship it',
      words: kept,
      echoOf: 'sys-1',
      originalText: 'so the plan is ship it',
      originalWords: words,
      suppressedReason: null,
      // A trim decides the words, not when the line may go: the echo sink releases it.
      uploadAfter: '2026-10-06T10:02:00.000Z',
    });

    store.releaseSegments(['seg-1']);
    expect(store.listUnsyncedSegments('m1', 10)).toEqual([
      { ...segment(1), text: 'so ship it', words: kept },
    ]);

    expect(
      store.trimSegment('seg-1', { text: 'ship it', words: kept.slice(1), echoOf: 'sys-2' }),
    ).toBe(true);
    expect(store.getSegment('seg-1')).toMatchObject({
      text: 'ship it',
      echoOf: 'sys-2',
      originalText: 'so the plan is ship it',
      originalWords: words,
    });
    expect(() => store.trimSegment('seg-1', { text: '  ', words: [], echoOf: 'sys-2' })).toThrow(
      /trimmed to nothing/,
    );
    store.close();
  });

  it('stores re-run lines with their origin; a live line is the default', () => {
    const { store } = openWithMeeting();
    store.appendSegment(segment(1));
    store.appendSegment(segment(2), 'rerun');
    expect(store.getSegment('seg-1')?.origin).toBe('live');
    expect(store.getSegment('seg-2')?.origin).toBe('rerun');
    // A re-run line uploads like any other.
    expect(store.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual(['seg-1', 'seg-2']);
    store.close();
  });

  it('lists the stored lines of one source that touch a window, hidden ones included', () => {
    const { store } = openWithMeeting();
    store.appendSegment(segment(1)); // 1000 to 1800
    store.appendSegment(segment(2)); // 2000 to 2800
    store.appendSegment(segment(5)); // 5000 to 5800
    store.appendSegment(segment(2, { id: 'seg-2-system', source: 'system', speaker: 'them' }));
    store.suppressSegment('seg-2', 'echo', 'seg-2-system');

    expect(store.listSegmentsOverlapping('m1', 'mic', 1900, 2100).map((s) => s.id)).toEqual([
      'seg-2',
    ]);
    expect(store.listSegmentsOverlapping('m1', 'mic', 1800, 5000).map((s) => s.id)).toEqual([
      'seg-1',
      'seg-2',
      'seg-5',
    ]);
    expect(store.listSegmentsOverlapping('m1', 'system', 0, 10_000).map((s) => s.id)).toEqual([
      'seg-2-system',
    ]);
    expect(store.listSegmentsOverlapping('m2', 'mic', 0, 10_000)).toEqual([]);
    store.close();
  });

  it('records each gap once and marks it recovered, or why it was not', () => {
    const { store } = openWithMeeting();
    store.addGap(gap('g2', { startMs: 30_000, endMs: 31_000, reason: 'offline' }));
    store.addGap(gap('g1'));
    store.addGap(gap('g1', { endMs: 99_000 })); // a re-sent gap is ignored
    store.addGap(gap('g3', { source: 'mic', startMs: 5_000, endMs: 6_000, reason: 'budget' }));

    expect(store.listGaps('m1').map((g) => [g.id, g.startMs, g.endMs])).toEqual([
      ['g3', 5_000, 6_000],
      ['g1', 10_000, 14_000],
      ['g2', 30_000, 31_000],
    ]);
    expect(store.listGaps('m1')[1]).toEqual({
      ...gap('g1'),
      recoveredAt: null,
      recoverError: null,
    });

    store.setGapRecoverError('g1', 'no audio kept for this window');
    expect(store.listUnrecoveredGaps('m1').find((g) => g.id === 'g1')?.recoverError).toBe(
      'no audio kept for this window',
    );
    store.markGapRecovered('g1', '2026-10-06T10:05:00.000Z');
    expect(store.listGaps('m1')[1]).toMatchObject({
      recoveredAt: '2026-10-06T10:05:00.000Z',
      recoverError: null,
    });
    expect(store.listUnrecoveredGaps().map((g) => g.id)).toEqual(['g3', 'g2']);
    expect(store.listUnrecoveredGaps('m2')).toEqual([]);

    expect(() => {
      store.addGap(gap('g4', { startMs: 5_000, endMs: 5_000 }));
    }).toThrow(/must end after it starts/);
    expect(() => {
      store.addGap(gap('g5', { meetingId: 'no-such-meeting' }));
    }).toThrow(/gap g5 of meeting no-such-meeting/);
    store.close();
  });

  it('tracks an audio file from open to closed, encoded and deleted', () => {
    const { store } = openWithMeeting();
    store.addAudioFile(audioFile('mic-1', { startMs: 60_000 }));
    store.addAudioFile(audioFile('mic-0'));
    store.addAudioFile(audioFile('mic-0', { startMs: 5 })); // a re-sent file is ignored
    store.addAudioFile(audioFile('sys-0', { source: 'system' }));

    expect(store.listOpenAudioFiles().map((f) => f.id)).toEqual(['mic-0', 'sys-0', 'mic-1']);
    store.closeAudioFile('mic-0', { endMs: 60_000, bytes: 1_920_044, closedAt: T0 });
    store.closeAudioFile('sys-0', { endMs: 60_000, bytes: 1_920_044, closedAt: T0 });
    store.markAudioFileEncoded('mic-0', {
      path: 'audio/m1/mic-0.m4a',
      format: 'm4a',
      bytes: 360_000,
    });

    expect(store.listOpenAudioFiles().map((f) => f.id)).toEqual(['mic-1']);
    expect(store.listAudioFiles('m1')).toEqual([
      {
        ...audioFile('mic-0'),
        path: 'audio/m1/mic-0.m4a',
        format: 'm4a',
        endMs: 60_000,
        bytes: 360_000,
        closedAt: T0,
        deletedAt: null,
      },
      expect.objectContaining({ id: 'sys-0', source: 'system', endMs: 60_000 }),
      expect.objectContaining({ id: 'mic-1', endMs: null, bytes: 0, closedAt: null }),
    ]);
    expect(store.listMeetingIdsWithAudio()).toEqual(['m1']);

    expect(store.markMeetingAudioDeleted('m1', '2026-10-13T10:00:00.000Z')).toBe(3);
    expect(store.listAudioFiles('m1')).toEqual([]);
    expect(store.listOpenAudioFiles()).toEqual([]);
    expect(store.listMeetingIdsWithAudio()).toEqual([]);
    expect(store.markMeetingAudioDeleted('m1', '2026-10-14T10:00:00.000Z')).toBe(0);
    store.close();
  });

  it('refuses an audio path that is absolute or climbs out of the user data folder', () => {
    const { store } = openWithMeeting();
    expect(() => {
      store.addAudioFile(audioFile('a', { path: '/Users/x/audio/m1/a.wav' }));
    }).toThrow(/relative/);
    expect(() => {
      store.addAudioFile(audioFile('b', { path: 'audio/../../b.wav' }));
    }).toThrow(/relative/);
    store.addAudioFile(audioFile('c'));
    expect(() => {
      store.markAudioFileEncoded('c', { path: '../c.m4a', format: 'm4a', bytes: 1 });
    }).toThrow(/relative/);
    expect(store.listAudioFiles('m1').map((f) => f.path)).toEqual(['audio/m1/c.wav']);
    store.close();
  });

  it('appends capture events in order with their details', () => {
    const { store } = openWithMeeting();
    const first = store.addCaptureEvent({
      meetingId: 'm1',
      at: T0,
      offsetMs: 61_000,
      source: 'system',
      kind: 'stt_failed',
      detail: { code: 3005, retryInMs: 2000, fatal: true, cause: null },
    });
    const second = store.addCaptureEvent({
      meetingId: 'm1',
      at: '2026-10-06T10:00:05.000Z',
      offsetMs: 66_000,
      source: null,
      kind: 'offline',
    });
    expect(second).toBeGreaterThan(first);
    expect(store.listCaptureEvents('m1')).toEqual([
      {
        id: first,
        meetingId: 'm1',
        at: T0,
        offsetMs: 61_000,
        source: 'system',
        kind: 'stt_failed',
        detail: { code: 3005, retryInMs: 2000, fatal: true, cause: null },
      },
      {
        id: second,
        meetingId: 'm1',
        at: '2026-10-06T10:00:05.000Z',
        offsetMs: 66_000,
        source: null,
        kind: 'offline',
        detail: {},
      },
    ]);
    expect(store.listCaptureEvents('m2')).toEqual([]);
    store.close();
  });

  it('keeps device state by key', () => {
    const { store } = openWithMeeting();
    expect(store.getAppState('systemAudio.verified')).toBeNull();
    store.setAppState('systemAudio.verified', 'hash-a', T0);
    store.setAppState('systemAudio.verified', 'hash-b', '2026-10-06T10:01:00.000Z');
    expect(store.getAppState('systemAudio.verified')).toEqual({
      value: 'hash-b',
      updatedAt: '2026-10-06T10:01:00.000Z',
    });
    store.deleteAppState('systemAudio.verified');
    expect(store.getAppState('systemAudio.verified')).toBeNull();
    store.close();
  });

  it('records why a meeting stopped; a meeting a crash left open is ended with crash', () => {
    const { store } = openWithMeeting();
    expect(store.getMeetingStopReason('m1')).toBeNull();
    store.setMeetingStopReason('m1', 'user');
    store.markMeetingEnded('m1', T0);
    expect(store.getMeetingStopReason('m1')).toBe('user');
    expect(store.getMeetingStopReason('missing')).toBeNull();

    store.createMeeting({ id: 'crashed', title: 'T', startedAt: '2026-10-06T08:00:00.000Z' });
    // A quit whose stop outran its bound: the stop wrote its reason, then the app exited.
    store.createMeeting({ id: 'quit', title: 'T', startedAt: '2026-10-06T08:30:00.000Z' });
    store.setMeetingStopReason('quit', 'quit');
    store.createMeeting({ id: 'resumed', title: 'T', startedAt: '2026-10-06T09:30:00.000Z' });

    expect(store.listOpenMeetings().map((m) => m.id)).toEqual(['crashed', 'quit', 'resumed']);
    expect(store.endMeetingsLeftOpen(T0, 'resumed')).toBe(2);
    expect(store.getMeetingStopReason('crashed')).toBe('crash');
    expect(store.getMeetingStopReason('quit')).toBe('quit');
    expect(store.getMeetingStopReason('m1')).toBe('user');
    expect(store.listOpenMeetings().map((m) => m.id)).toEqual(['resumed']);
    expect(store.getMeetingStopReason('resumed')).toBeNull();
    store.close();
  });

  it('keeps a meeting with no lines while it holds an unrecovered gap or kept audio', () => {
    const { store } = openWithMeeting();
    store.addGap(gap('g1'));
    // Deleting it would cascade the gap away and the re-run could never fill it.
    expect(store.deleteMeetingIfEmpty('m1')).toBe(false);
    store.markGapRecovered('g1', T0);
    expect(store.deleteMeetingIfEmpty('m1')).toBe(true);

    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    store.addAudioFile(audioFile('mic-0'));
    // Deleting it would cascade the row away and leave the file on disk for no sweeper to find.
    expect(store.deleteMeetingIfEmpty('m1')).toBe(false);
    store.markMeetingAudioDeleted('m1', T0);
    store.addCaptureEvent({ meetingId: 'm1', at: T0, offsetMs: 0, source: null, kind: 'stall' });
    expect(store.deleteMeetingIfEmpty('m1')).toBe(true);
    expect(store.listCaptureEvents('m1')).toEqual([]);
    expect(store.listAudioFiles('m1')).toEqual([]);
    store.close();
  });
});

describe('SqliteTranscriptStore migration 4 and crash reopen', () => {
  it('upgrades a store at schema 3 (M1 plus stt_usage) to 4, keeping every row', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-store-')), 'roger.sqlite');
    const first = new SqliteTranscriptStore(path);
    first.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    first.appendSegment(segment(1, { id: 'synced' }));
    first.appendSegment(segment(2, { id: 'waiting', source: 'system', speaker: 'them' }));
    first.appendSegment(segment(3, { id: 'rejected' }));
    first.markSegmentsSynced(['synced'], '2026-10-05T10:01:00.000Z');
    first.markSegmentRejected('rejected', 'bad', '2026-10-05T10:01:00.000Z');
    first.markMeetingEnded('m1', '2026-10-05T10:30:00Z');
    first.setMeetingRemoteState('m1', 'ended');
    first.saveSttUsage(usage('m1', { stopReason: 'no-speech' }));
    first.close();
    windBackToSchema3(path);

    const store = new SqliteTranscriptStore(path, () => new Date(T0));
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    raw.close();
    expect(store.getMeeting('m1')).toMatchObject({
      endedAt: '2026-10-05T10:30:00Z',
      remoteState: 'ended',
    });
    expect(store.getMeetingStopReason('m1')).toBeNull();
    expect(store.countSegments('m1')).toBe(3);
    expect(store.countRejectedSegments()).toBe(1);
    expect(store.listUnsyncedSegments('m1', 10)).toEqual([
      segment(2, { id: 'waiting', source: 'system', speaker: 'them' }),
    ]);
    expect(store.getSegment('synced')).toEqual({
      ...segment(1, { id: 'synced' }),
      origin: 'live',
      suppressedReason: null,
      echoOf: null,
      originalText: null,
      originalWords: null,
      uploadAfter: null,
      syncedAt: '2026-10-05T10:01:00.000Z',
    });
    expect(store.getSttUsage('m1')).toEqual(usage('m1', { stopReason: 'no-speech' }));
    store.addGap(gap('g1'));
    store.close();

    const again = new SqliteTranscriptStore(path); // migration 4 does not run twice
    expect(again.listGaps('m1').map((g) => g.id)).toEqual(['g1']);
    again.close();
  });

  it('crash reopen: a store that was never closed leaves every hold, gap and open file to the next launch', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-store-')), 'roger.sqlite');
    const crashed = new SqliteTranscriptStore(path, () => new Date(T0));
    crashed.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-06T09:59:00.000Z' });
    crashed.appendSegment(segment(1));
    crashed.appendSegment(segment(2));
    crashed.appendSegment(segment(2, { id: 'seg-2-system', source: 'system', speaker: 'them' }));
    crashed.holdSegment('seg-1', '2026-10-06T10:02:00.000Z');
    crashed.suppressSegment('seg-2', 'echo', 'seg-2-system');
    crashed.addAudioFile(audioFile('mic-0'));
    crashed.addGap(gap('g1'));
    crashed.setAppState('recording.heartbeat', '{"meetingId":"m1"}', T0);
    // No close(): kill -9 never runs it. Committed writes are in the WAL file.

    const next = new SqliteTranscriptStore(path, () => new Date('2026-10-06T10:00:06.000Z'));
    expect(next.listOpenMeetings().map((m) => m.id)).toEqual(['m1']);
    expect(next.listHeldSegments().map((s) => s.id)).toEqual(['seg-1']);
    expect(next.listUnsyncedSegments('m1', 10).map((s) => s.id)).toEqual(['seg-2-system']);
    expect(next.getSegment('seg-2')).toMatchObject({ suppressedReason: 'echo' });
    expect(next.listOpenAudioFiles().map((f) => f.id)).toEqual(['mic-0']);
    expect(next.listUnrecoveredGaps().map((g) => g.id)).toEqual(['g1']);
    expect(next.getAppState('recording.heartbeat')?.value).toBe('{"meetingId":"m1"}');
    // A resume keeps the meeting open; everything else ends as in M1.
    expect(next.endMeetingsLeftOpen('2026-10-06T10:00:06.000Z', 'm1')).toBe(0);
    expect(next.getMeeting('m1')?.endedAt).toBeNull();
    next.close();
    crashed.close();
  });
});
