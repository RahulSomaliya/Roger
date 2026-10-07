import { describe, expect, it } from 'vitest';
import type { SttMeter, SttMeterStatus, UploadStatus } from '../../shared/capture';
import {
  describeCost,
  describeHealth,
  describeMeter,
  formatDuration,
  meterDetails,
  describeSaved,
  describeSourceConnected,
  describeStream,
  describeUpload,
  formatOffset,
  streamTone,
} from './format';

const upload = (overrides: Partial<UploadStatus>): UploadStatus => ({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
  ...overrides,
});

describe('formatOffset', () => {
  it('renders hh:mm:ss including past one hour', () => {
    expect(formatOffset(0)).toBe('00:00:00');
    expect(formatOffset(61_500)).toBe('00:01:01');
    expect(formatOffset(3_725_000)).toBe('01:02:05');
  });

  it('never goes negative', () => {
    expect(formatOffset(-5)).toBe('00:00:00');
  });
});

describe('describeHealth', () => {
  it('says how long a stalled source has been without audio', () => {
    expect(describeHealth('stalled', 12)).toBe('no audio for over 5 s');
    expect(describeHealth('ended', 25)).toBe('stopped');
  });

  it('gives what a source captured as the connected time beside it reads, not in seconds', () => {
    // 100 ms chunks: 25 are 2.5 s, floored as formatDuration floors.
    expect(describeHealth('active', 25)).toBe('2s captured');
    // A 40-minute call read "2392s captured".
    expect(describeHealth('active', 23_920)).toBe('39m 52s captured');
    expect(describeHealth('active', 0)).toBe('open, no audio yet');
  });
});

describe('describeStream', () => {
  // The row's label (StreamStatus): short, because the row shows why beside it (streamMessages).
  it('says Transcribing only for an open session, and Not connected for a closed one', () => {
    expect(describeStream('open', 'active')).toBe('Transcribing');
    expect(describeStream('closed', 'error')).toBe('Not connected');
    expect(describeStream('connecting', 'active')).toBe('Connecting');
  });

  it('never says Transcribing while its source sends no audio', () => {
    expect(describeStream('open', 'pending')).toBe('Connected, no audio yet');
    expect(describeStream('open', 'stalled')).toBe('Connected, no audio');
    // A dead track sends nothing either; G1 closes its session at once.
    expect(describeStream('open', 'ended')).toBe('Connected, no audio');
    expect(describeStream('open', 'error')).toBe('Connected, no audio');
  });

  it('says Reconnecting only while the source sends the audio a reopen waits for', () => {
    expect(describeStream('retrying', 'active')).toBe('Reconnecting');
    expect(describeStream('retrying', 'stalled')).toBe('Reconnects with audio');
    expect(describeStream('retrying', 'pending')).toBe('Reconnects with audio');
    // A stopped source never sends the chunk a reopen needs.
    expect(describeStream('retrying', 'ended')).toBe('Not connected');
    expect(describeStream('retrying', 'error')).toBe('Not connected');
  });

  it('says Offline apart from a vendor failure, whatever its source sends', () => {
    expect(describeStream('offline', 'active')).toBe('Offline');
    expect(describeStream('offline', 'stalled')).toBe('Offline');
  });

  it('says Paused for a closed session that reopens with audio, and Failed for one that never will', () => {
    expect(describeStream('paused', 'stalled')).toBe('Paused');
    expect(describeStream('paused', 'pending')).toBe('Paused');
    expect(describeStream('error', 'active')).toBe('Failed');
  });

  it("tells the silence gate's pause from a stall by the audio still arriving", () => {
    // Chunks keep coming and none is speech: the gate closed it (M3-T20), not a broken path.
    expect(describeStream('paused', 'active')).toBe('Closed while silent, reopens on speech');
  });
});

describe('streamTone', () => {
  it('is ok only while a session transcribes audio', () => {
    expect(streamTone('open', 'active')).toBe('ok');
    expect(streamTone('open', 'stalled')).toBe('warn');
    expect(streamTone('open', 'ended')).toBe('warn');
  });

  it('waits quietly while a session starts, and stays off when there is none', () => {
    expect(streamTone('connecting', 'pending')).toBe('pending');
    // Connected a moment before the first chunk: every Start passes through it.
    expect(streamTone('open', 'pending')).toBe('pending');
    expect(streamTone('closed', 'pending')).toBe('off');
  });

  it('stays off while the silence gate keeps a session closed: nothing is being said', () => {
    expect(streamTone('paused', 'active')).toBe('off');
  });

  it('warns while the words are not reaching the vendor, and errs once they never will', () => {
    expect(streamTone('paused', 'stalled')).toBe('warn');
    expect(streamTone('paused', 'pending')).toBe('warn');
    expect(streamTone('retrying', 'active')).toBe('warn');
    expect(streamTone('offline', 'active')).toBe('warn');
    expect(streamTone('error', 'active')).toBe('error');
  });
});

describe('describeSaved', () => {
  it('counts lines that could not be saved next to the saved ones', () => {
    expect(describeSaved(3, 0)).toBe('3 lines');
    expect(describeSaved(3, 2)).toBe('3 lines · 2 could not be saved');
  });
});

describe('describeUpload', () => {
  it('explains a backoff with the pending count and reason', () => {
    expect(
      describeUpload(upload({ state: 'backoff', pending: 3, lastError: 'down', nextAttemptAt: 1 })),
    ).toBe('3 lines waiting, retrying (down)');
    expect(describeUpload(upload({}))).toBe('all lines uploaded');
  });

  it('mentions lines the API rejected so nobody thinks they were uploaded', () => {
    expect(describeUpload(upload({ rejected: 2 }))).toBe(
      'all lines uploaded · 2 rejected by the API',
    );
  });
});

describe('formatDuration', () => {
  it('reads like a stopwatch, coarser past an hour', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_400)).toBe('45s');
    expect(formatDuration(750_000)).toBe('12m 30s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
});

describe('describeSourceConnected', () => {
  it("says a source's connected time without contradicting its state", () => {
    expect(describeSourceConnected('open', 12_000)).toBe('12s connected');
    expect(describeSourceConnected('connecting', 12_000)).toBe('12s connected');
    // Its session closed: the time is what it was connected, not "not connected · 12s connected".
    expect(describeSourceConnected('closed', 12_000)).toBe('was connected 12s');
    expect(describeSourceConnected('paused', 75_000)).toBe('was connected 1m 15s');
    expect(describeSourceConnected('retrying', 12_000)).toBe('was connected 12s');
    // Offline terminates the socket at once: nothing is connected while it lasts.
    expect(describeSourceConnected('offline', 12_000)).toBe('was connected 12s');
  });

  it('shows nothing before any session opened, and never "0s"', () => {
    expect(describeSourceConnected('connecting', 0)).toBeNull();
    expect(describeSourceConnected('open', 400)).toBe('under 1s connected');
  });
});

describe('describeCost', () => {
  it('rounds to cents and never shows a guess as exact', () => {
    expect(describeCost(0.0625)).toBe('about $0.06');
    expect(describeCost(0.004)).toBe('under $0.01');
    expect(describeCost(0)).toBe('no cost');
    expect(describeCost(null)).toBe('cost unknown');
  });
});

describe('describeMeter', () => {
  const meter = (connectedMs: number, estimatedCostUsd: number | null): SttMeter => ({
    sessionsOpened: 1,
    connectedMs,
    audioSentMs: connectedMs - 5_000,
    estimatedCostUsd,
  });
  const status: SttMeterStatus = {
    vendorName: 'AssemblyAI',
    total: { ...meter(750_000, 0.0313), sessionsOpened: 3 },
    sources: { mic: meter(375_000, 0.0156), system: meter(375_000, 0.0156) },
  };

  it('says vendor, connected time and cost in one line', () => {
    expect(describeMeter(status)).toBe('AssemblyAI · 12m 30s connected · about $0.03');
  });

  it('gives sessions, audio and each source in the details', () => {
    expect(meterDetails(status)).toBe(
      '3 sessions opened · 12m 25s of audio sent. Mic (me): 6m 15s connected, about $0.02. ' +
        'Call audio (them): 6m 15s connected, about $0.02.',
    );
  });

  describe('with the silence gate (M3-T20)', () => {
    const gated: SttMeterStatus = {
      ...status,
      total: { ...status.total, gatedMs: 720_000, estimatedSavedUsd: 0.03 },
      sources: {
        mic: { ...status.sources.mic, gatedMs: 720_000, estimatedSavedUsd: 0.03 },
        system: { ...status.sources.system, gatedMs: 0, estimatedSavedUsd: 0 },
      },
      silenceGate: 'on',
    };

    it('adds what the gate saved to the line', () => {
      expect(describeMeter(gated)).toBe(
        'AssemblyAI · 12m 30s connected · about $0.03 · saved about $0.03 in silence',
      );
      const small = { ...gated, total: { ...gated.total, estimatedSavedUsd: 0.001 } };
      expect(describeMeter(small)).toMatch(/ · saved under \$0\.01 in silence$/);
    });

    it('says the time closed when the price is unknown, missing or nothing', () => {
      const { estimatedSavedUsd: _saved, ...withoutSaved } = gated.total;
      for (const total of [
        { ...gated.total, estimatedSavedUsd: null },
        withoutSaved,
        { ...gated.total, estimatedSavedUsd: 0 },
      ] satisfies SttMeter[]) {
        expect(describeMeter({ ...gated, total })).toBe(
          'AssemblyAI · 12m 30s connected · about $0.03 · 12m 00s closed in silence',
        );
      }
    });

    it('reads a meter without the gate fields, as other tasks build it, as before', () => {
      // M2-T20a's tests and shots and M4-S3's fixtures build SttMeter values without them.
      expect(describeMeter({ ...status, silenceGate: 'off' })).toBe(describeMeter(status));
      expect(meterDetails({ ...status, silenceGate: 'on' })).toBe(meterDetails(status));
    });

    it("gives each source's closed time in the details, and says when the gate is spent", () => {
      expect(meterDetails(gated)).toBe(
        '3 sessions opened · 12m 25s of audio sent · 12m 00s closed in silence. ' +
          'Mic (me): 6m 15s connected, about $0.02, 12m 00s closed in silence. ' +
          'Call audio (them): 6m 15s connected, about $0.02.',
      );
      expect(meterDetails({ ...gated, silenceGate: 'spent' })).toBe(
        `${meterDetails(gated)} Silence gate off for this meeting: its reopens are spent.`,
      );
    });
  });
});
