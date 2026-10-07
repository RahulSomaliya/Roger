import { describe, expect, it } from 'vitest';
import type { AudioSource } from '../../shared/transcript';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { recordCrashTails } from './crashTails';

const MEETING = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const STARTED_AT = '2026-10-07T09:00:00.000Z';
const NOW = '2026-10-07T10:00:00.000Z';
let ids = 0;

function uuid(): string {
  ids += 1;
  return `0000000${ids}-0000-4000-8000-000000000000`.slice(-36);
}

/** A meeting with closed backup files per source (meeting offsets), as the launch repair leaves. */
function meeting(stopReason: 'crash' | 'user', audio: Record<AudioSource, [number, number][]>) {
  const store = new InMemoryTranscriptStore();
  store.createMeeting({ id: MEETING, title: 'T', startedAt: STARTED_AT });
  for (const [source, files] of Object.entries(audio) as [AudioSource, [number, number][]][]) {
    for (const [startMs, endMs] of files) {
      const id = uuid();
      store.addAudioFile({
        id,
        meetingId: MEETING,
        source,
        startMs,
        path: `audio/${MEETING}/${source}-${startMs}.wav`,
        format: 'wav',
        createdAt: STARTED_AT,
      });
      store.closeAudioFile(id, { endMs, bytes: 1_000, closedAt: STARTED_AT });
    }
  }
  store.setMeetingStopReason(MEETING, stopReason);
  store.markMeetingEnded(MEETING, '2026-10-07T09:10:00.000Z');
  return store;
}

function line(store: InMemoryTranscriptStore, source: AudioSource, startMs: number, endMs: number) {
  store.appendSegment({
    id: uuid(),
    meetingId: MEETING,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs,
    endMs,
    text: 'said',
    confidence: null,
    words: null,
    createdAt: STARTED_AT,
  });
}

describe('recordCrashTails', () => {
  it("makes each source's audio after its last line a crash gap, for a meeting a crash ended", () => {
    const store = meeting('crash', {
      mic: [[0, 60_000]],
      system: [
        [0, 60_000],
        [60_000, 95_000],
      ],
    });
    line(store, 'system', 1_000, 40_000);
    line(store, 'system', 41_000, 52_500);
    // Hidden echo lines count: the vendor heard that far.
    line(store, 'mic', 2_000, 58_000);

    expect(recordCrashTails(store, NOW)).toBe(2);
    expect(
      store.listGaps(MEETING).map(({ source, startMs, endMs, reason, createdAt }) => ({
        source,
        startMs,
        endMs,
        reason,
        createdAt,
      })),
    ).toEqual([
      // In start order, as listGaps answers.
      { source: 'system', startMs: 52_500, endMs: 95_000, reason: 'crash', createdAt: NOW },
      { source: 'mic', startMs: 58_000, endMs: 60_000, reason: 'crash', createdAt: NOW },
    ]);
    // The next launch finds the same meeting: its tails are not recorded twice.
    expect(recordCrashTails(store, NOW)).toBe(0);
    expect(store.listGaps(MEETING)).toHaveLength(2);
  });

  it('starts a source with no line at its first audio, and skips a tail too short for a word', () => {
    const store = meeting('crash', { mic: [[1_000, 30_000]], system: [[0, 30_000]] });
    line(store, 'system', 0, 29_800);
    expect(recordCrashTails(store, NOW)).toBe(1);
    expect(store.listGaps(MEETING).map((gap) => [gap.source, gap.startMs, gap.endMs])).toEqual([
      ['mic', 1_000, 30_000],
    ]);
  });

  it('leaves a meeting a stop ended, and one still open (being recorded, or to be resumed)', () => {
    const stopped = meeting('user', { mic: [[0, 10_000]], system: [] });
    expect(recordCrashTails(stopped, NOW)).toBe(0);

    const open = new InMemoryTranscriptStore();
    open.createMeeting({ id: MEETING, title: 'T', startedAt: STARTED_AT });
    open.addAudioFile({
      id: uuid(),
      meetingId: MEETING,
      source: 'mic',
      startMs: 0,
      path: `audio/${MEETING}/mic-0.wav`,
      format: 'wav',
      createdAt: STARTED_AT,
    });
    open.setMeetingStopReason(MEETING, 'crash');
    expect(recordCrashTails(open, NOW)).toBe(0);
    expect(open.listGaps(MEETING)).toEqual([]);
  });
});
