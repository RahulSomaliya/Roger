import { describe, expect, it } from 'vitest';
import { formatClock, meetingHours } from './clock';

/** The renderer's own cases (src/renderer/src/clock.test.ts) cover the Mac's zone; this one the zone argument main passes. */
describe('formatClock in a given time zone', () => {
  const instant = Date.UTC(2026, 9, 6, 9, 0);

  it('writes the clock of that zone, 12-hour and lowercase, with a plain space', () => {
    expect(formatClock(instant, 'Asia/Kolkata')).toBe('2:30 pm');
    expect(formatClock(instant, 'America/Los_Angeles')).toBe('2:00 am');
    expect(formatClock(instant, 'Asia/Kolkata')).not.toMatch(/[^\x20-\x7E]/);
  });
});

describe('meetingHours', () => {
  const start = Date.UTC(2026, 9, 6, 9, 57);

  it('writes both ends with their own am or pm, joined by "to"', () => {
    expect(meetingHours(start, start + 30 * 60_000, 'Asia/Kolkata')).toBe('3:27 pm to 3:57 pm');
  });

  it('keeps both suffixes across noon, and uses a plain space and no dash', () => {
    const hours = meetingHours(Date.UTC(2026, 9, 6, 18, 30), Date.UTC(2026, 9, 6, 19, 15), 'UTC');
    expect(hours).toBe('6:30 pm to 7:15 pm');
    expect(meetingHours(Date.UTC(2026, 9, 6, 11, 30), Date.UTC(2026, 9, 6, 12, 15), 'UTC')).toBe(
      '11:30 am to 12:15 pm',
    );
    expect(hours).not.toMatch(/[^\x20-\x7E]/);
  });
});
