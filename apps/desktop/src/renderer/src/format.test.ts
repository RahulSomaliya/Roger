import { describe, expect, it } from 'vitest';
import type { SttMeter, SttMeterStatus, UploadStatus } from '../../shared/capture';
import {
  describeCost,
  describeHealth,
  describeMeter,
  formatDuration,
  meterDetails,
  describeSaved,
  describeStream,
  describeUpload,
  formatOffset,
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
    expect(describeHealth('active', 25)).toBe('3s captured');
    expect(describeHealth('ended', 25)).toBe('stopped');
  });
});

describe('describeStream', () => {
  it('says transcribing only for an open session, and not connected for a closed one', () => {
    expect(describeStream('open', 'active')).toBe('transcribing');
    expect(describeStream('closed', 'error')).toBe('not connected');
    expect(describeStream('connecting', 'active')).toBe('connecting');
  });

  it('never says transcribing while its source sends no audio', () => {
    expect(describeStream('open', 'pending')).toBe('connected, no audio yet');
    expect(describeStream('open', 'stalled')).toBe('connected, no audio');
  });

  it('says reconnecting only while the source sends the audio a reopen waits for', () => {
    expect(describeStream('retrying', 'active')).toBe('reconnecting');
    expect(describeStream('retrying', 'stalled')).toBe('not connected, reconnects with audio');
    expect(describeStream('retrying', 'pending')).toBe('not connected, reconnects with audio');
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
});
