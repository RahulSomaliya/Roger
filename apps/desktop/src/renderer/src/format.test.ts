import { describe, expect, it } from 'vitest';
import type { UploadStatus } from '../../shared/capture';
import { describeHealth, describeSaved, describeUpload, formatOffset } from './format';

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
