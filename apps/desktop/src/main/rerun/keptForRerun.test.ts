import { describe, expect, it } from 'vitest';
import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS } from '../../shared/capture';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { TranscriptStore } from '../store/TranscriptStore';
import { listMeetingsKeptForRerun } from './keptForRerun';

const DAY_MS = 86_400_000;
const OLDER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NEWER = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const NO_GAP = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
const AUDIO_GONE = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80';
const RECORDING = '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8091';

let next = 0;
function uuid(): string {
  next += 1;
  return `${String(next).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function meetingWith(
  store: TranscriptStore,
  id: string,
  startedAt: string,
  options: { endedAt: string | null; gaps: number; audio: boolean },
): void {
  store.createMeeting({ id, title: `Call ${id.slice(0, 4)}`, startedAt });
  if (options.audio) {
    store.addAudioFile({
      id: uuid(),
      meetingId: id,
      source: 'system',
      startMs: 0,
      path: `audio/${id}/system-0.wav`,
      format: 'wav',
      createdAt: startedAt,
    });
  }
  for (let gap = 0; gap < options.gaps; gap += 1) {
    store.addGap({
      id: uuid(),
      meetingId: id,
      source: 'system',
      startMs: gap * 10_000,
      endMs: gap * 10_000 + 5_000,
      reason: 'offline',
      createdAt: startedAt,
    });
  }
  if (options.endedAt !== null) store.markMeetingEnded(id, options.endedAt);
}

describe('listMeetingsKeptForRerun', () => {
  it('lists each meeting whose audio waits for a re-run, newest first, with its keep date', () => {
    const store = new InMemoryTranscriptStore();
    meetingWith(store, OLDER, '2026-10-01T09:00:00.000Z', {
      endedAt: '2026-10-01T10:00:00.000Z',
      gaps: 2,
      audio: true,
    });
    meetingWith(store, NEWER, '2026-10-05T09:00:00.000Z', {
      endedAt: '2026-10-05T09:30:00.000Z',
      gaps: 1,
      audio: true,
    });
    meetingWith(store, NO_GAP, '2026-10-06T09:00:00.000Z', {
      endedAt: '2026-10-06T09:30:00.000Z',
      gaps: 0,
      audio: true,
    });
    // Its gap can never be re-run: no audio is left to re-run it from.
    meetingWith(store, AUDIO_GONE, '2026-10-04T09:00:00.000Z', {
      endedAt: '2026-10-04T09:30:00.000Z',
      gaps: 1,
      audio: false,
    });
    // Recording now, a gap already recorded: its audio is never deleted while it is open.
    meetingWith(store, RECORDING, '2026-10-07T09:00:00.000Z', {
      endedAt: null,
      gaps: 1,
      audio: true,
    });

    // The same rule as the report's (audioKeep): the 30-day keep, longer than a 7-day retention.
    const keep = (endedAt: string): string =>
      new Date(Date.parse(endedAt) + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS).toISOString();
    expect(listMeetingsKeptForRerun(store, 7)).toEqual([
      { meetingId: RECORDING, title: 'Call 5e6f', keepUntil: null },
      { meetingId: NEWER, title: 'Call 2b3c', keepUntil: keep('2026-10-05T09:30:00.000Z') },
      { meetingId: OLDER, title: 'Call 1a2b', keepUntil: keep('2026-10-01T10:00:00.000Z') },
    ]);
  });

  it('reads the gaps once for every meeting, never a report per meeting', () => {
    const store = new InMemoryTranscriptStore();
    meetingWith(store, OLDER, '2026-10-01T09:00:00.000Z', {
      endedAt: '2026-10-01T10:00:00.000Z',
      gaps: 1,
      audio: true,
    });
    const reads: (string | undefined)[] = [];
    const counting: TranscriptStore = Object.create(store) as TranscriptStore;
    counting.listUnrecoveredGaps = (meetingId?: string) => {
      reads.push(meetingId);
      return store.listUnrecoveredGaps(meetingId);
    };
    counting.listAudioFiles = () => {
      throw new Error('the list never reads files');
    };
    expect(listMeetingsKeptForRerun(counting, 7)).toHaveLength(1);
    expect(reads).toEqual([undefined]);
  });
});
