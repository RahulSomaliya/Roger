import { describe, expect, it } from 'vitest';
import {
  compareTranscriptOrder,
  MAX_MEETINGS_LIST_LIMIT,
  mergeTranscriptLines,
  parseGetMeetingRequest,
  parseListMeetingsRequest,
} from './meetings';
import type { AudioSource, TranscriptSegment } from './transcript';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

function line(id: string, startMs: number, source: AudioSource = 'mic'): TranscriptSegment {
  return {
    id,
    meetingId: MEETING,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs,
    endMs: startMs + 900,
    text: `line ${id}`,
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-06T09:30:00.000Z',
  };
}

describe('parseListMeetingsRequest', () => {
  it('takes a whole positive limit and caps it at the most main lists', () => {
    expect(parseListMeetingsRequest({ limit: 30 })).toEqual({ limit: 30 });
    expect(parseListMeetingsRequest({ limit: 10_000 })).toEqual({
      limit: MAX_MEETINGS_LIST_LIMIT,
    });
  });

  it('refuses anything else, and keeps no other field', () => {
    for (const payload of [
      null,
      undefined,
      30,
      {},
      { limit: 0 },
      { limit: -1 },
      { limit: 2.5 },
      { limit: Number.NaN },
      { limit: Number.POSITIVE_INFINITY },
      { limit: '30' },
    ]) {
      expect(parseListMeetingsRequest(payload)).toBeNull();
    }
    expect(parseListMeetingsRequest({ limit: 5, extra: true })).toEqual({ limit: 5 });
  });
});

describe('parseGetMeetingRequest', () => {
  it('takes a lowercase meeting id, as the desktop makes them', () => {
    expect(parseGetMeetingRequest({ meetingId: MEETING })).toEqual({ meetingId: MEETING });
  });

  it('refuses a payload without one: a wrong case, a path or no id at all', () => {
    for (const payload of [
      null,
      MEETING,
      {},
      { meetingId: MEETING.toUpperCase() },
      { meetingId: '../roger.sqlite' },
      { meetingId: `${MEETING}/x` },
      { meetingId: 42 },
    ]) {
      expect(parseGetMeetingRequest(payload)).toBeNull();
    }
  });
});

describe('transcript order', () => {
  it('goes by start, then mic before system, then id', () => {
    const lines = [
      line('c', 2000, 'system'),
      line('b', 2000, 'mic'),
      line('d', 1000, 'system'),
      line('a', 2000, 'mic'),
    ];
    expect([...lines].sort(compareTranscriptOrder).map((l) => l.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('merges stored and live lines once each, in transcript order', () => {
    const stored = [line('a', 1000), line('b', 3000)];
    const live = [line('b', 3000), line('c', 2000, 'system'), line('d', 4000)];
    expect(mergeTranscriptLines(stored, live).map((l) => l.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('keeps the stored copy of a line both lists hold', () => {
    const stored = [{ ...line('a', 1000), text: 'as main stored it' }];
    const live = [{ ...line('a', 1000), text: 'as it arrived' }];
    expect(mergeTranscriptLines(stored, live).map((l) => l.text)).toEqual(['as main stored it']);
  });

  it('answers the stored list itself when no live line is new, so React sees no change', () => {
    const stored = [line('a', 1000), line('b', 3000)];
    expect(mergeTranscriptLines(stored, [])).toBe(stored);
    expect(mergeTranscriptLines(stored, [line('b', 3000)])).toBe(stored);
  });
});
