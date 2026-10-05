import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../../shared/transcript';
import { SqliteTranscriptStore } from './SqliteTranscriptStore';

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
});
