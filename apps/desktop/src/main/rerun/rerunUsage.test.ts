import { describe, expect, it } from 'vitest';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { MeetingSttUsage } from '../store/TranscriptStore';
import type { SttUsage } from '../stt/usage';
import { addRerunUsage } from './rerunUsage';

const MEETING = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const AT = '2026-10-07T12:00:00.000Z';

function usage(sessionsOpened: number, connectedMs: number, cost: number | null): SttUsage {
  return {
    sessionsOpened,
    connectedMs,
    audioSentMs: connectedMs - 100,
    droppedChunks: 0,
    estimatedCostUsd: cost,
  };
}

describe('addRerunUsage', () => {
  it("adds a re-run session to the meeting's row and its source, keeping what the row held", () => {
    const store = new InMemoryTranscriptStore();
    const saved: MeetingSttUsage = {
      meetingId: MEETING,
      provider: 'assemblyai',
      total: usage(4, 60_000, 0.0025),
      bySource: {
        mic: { ...usage(2, 30_000, 0.0013), gatedMs: 5_000 },
        system: { ...usage(2, 30_000, 0.0012), gatedMs: 7_000 },
      },
      gatedMs: 12_000,
      stopReason: 'user',
      updatedAt: '2026-10-07T11:00:00.000Z',
    };
    store.saveSttUsage(saved);

    addRerunUsage(store, {
      meetingId: MEETING,
      provider: 'assemblyai',
      source: 'system',
      usage: usage(1, 12_000, 0.0005),
      updatedAt: AT,
    });

    expect(store.getSttUsage(MEETING)).toEqual({
      ...saved,
      total: { ...usage(5, 72_000, 0.003), audioSentMs: 71_800 },
      bySource: {
        mic: saved.bySource.mic,
        system: { ...usage(3, 42_000, 0.0017), audioSentMs: 41_800, gatedMs: 7_000 },
      },
      updatedAt: AT,
    });
  });

  it('starts a row for a meeting that has none, and keeps an unknown cost unknown', () => {
    const store = new InMemoryTranscriptStore();
    store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-07T10:00:00.000Z' });
    store.setMeetingStopReason(MEETING, 'crash');

    addRerunUsage(store, {
      meetingId: MEETING,
      provider: 'deepgram',
      source: 'mic',
      usage: usage(1, 9_000, null),
      updatedAt: AT,
    });

    const zero = usage(0, 0, 0);
    expect(store.getSttUsage(MEETING)).toMatchObject({
      provider: 'deepgram',
      total: usage(1, 9_000, null),
      bySource: { mic: usage(1, 9_000, null), system: { ...zero, audioSentMs: 0 } },
      stopReason: 'crash',
      updatedAt: AT,
    });
  });
});
