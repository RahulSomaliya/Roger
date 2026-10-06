import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../../shared/transcript';
import { InMemoryTranscriptStore } from './InMemoryTranscriptStore';
import { SqliteTranscriptStore } from './SqliteTranscriptStore';
import type { MeetingSttUsage, TranscriptStore } from './TranscriptStore';

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
