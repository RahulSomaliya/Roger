import { describe, expect, it } from 'vitest';
import { describeUpload, formatOffset } from './format';

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

describe('describeUpload', () => {
  it('explains a backoff with the pending count and reason', () => {
    expect(
      describeUpload({ state: 'backoff', pending: 3, lastError: 'down', nextAttemptAt: 1 }),
    ).toBe('3 lines waiting, retrying (down)');
    expect(
      describeUpload({ state: 'idle', pending: 0, lastError: null, nextAttemptAt: null }),
    ).toBe('all lines uploaded');
  });
});
