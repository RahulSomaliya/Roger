import { describe, expect, it } from 'vitest';
import { formatClock } from './clock';

/** The renderer's own cases (src/renderer/src/clock.test.ts) cover the Mac's zone; this one the zone argument main passes. */
describe('formatClock in a given time zone', () => {
  const instant = Date.UTC(2026, 9, 6, 9, 0);

  it('writes the clock of that zone, 12-hour and lowercase, with a plain space', () => {
    expect(formatClock(instant, 'Asia/Kolkata')).toBe('2:30 pm');
    expect(formatClock(instant, 'America/Los_Angeles')).toBe('2:00 am');
    expect(formatClock(instant, 'Asia/Kolkata')).not.toMatch(/[^\x20-\x7E]/);
  });
});
