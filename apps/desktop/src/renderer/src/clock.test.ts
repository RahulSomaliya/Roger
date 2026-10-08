import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock } from './clock';

/**
 * docs/design.md, Copy: clock times are 12-hour and lowercase ("9:14 am"), never "09:14" or
 * "9:14 AM". Each case builds its Date from local parts so the test reads the same in any zone.
 */

const at = (hour: number, minute: number): Date => new Date(2026, 9, 7, hour, minute);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('formatClock', () => {
  it('writes 12-hour lowercase times with no leading zero', () => {
    expect(formatClock(at(9, 14))).toBe('9:14 am');
    expect(formatClock(at(17, 1))).toBe('5:01 pm');
    expect(formatClock(at(23, 59))).toBe('11:59 pm');
  });

  it('reads noon as 12 pm and midnight as 12 am, never 0 or 24', () => {
    expect(formatClock(at(12, 0))).toBe('12:00 pm');
    expect(formatClock(at(0, 5))).toBe('12:05 am');
  });

  it('uses a plain space, not the narrow no-break space newer ICU puts before am and pm', () => {
    expect(formatClock(at(9, 14))).not.toMatch(/[^\x20-\x7E]/);
  });

  it('takes an instant as a number of milliseconds too', () => {
    expect(formatClock(at(9, 14).getTime())).toBe('9:14 am');
  });

  it('can write another zone, for the calendar helper whose tests pin one', () => {
    const instant = Date.UTC(2026, 9, 6, 3, 42);
    expect(formatClock(instant, 'Asia/Kolkata')).toBe('9:12 am');
    expect(formatClock(instant, 'UTC')).toBe('3:42 am');
  });

  it('follows the Mac when its time zone changes, because each call builds its own formatter', () => {
    const instant = Date.UTC(2026, 9, 7, 14, 30);

    vi.stubEnv('TZ', 'UTC');
    // Without this a TZ test passes when the switch did nothing (apps/desktop/CLAUDE.md, M5-T8).
    expect(new Date(instant).getTimezoneOffset()).toBe(0);
    expect(formatClock(instant)).toBe('2:30 pm');

    vi.stubEnv('TZ', 'Asia/Kolkata');
    expect(new Date(instant).getTimezoneOffset()).toBe(-330);
    expect(formatClock(instant)).toBe('8:00 pm');

    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(new Date(instant).getTimezoneOffset()).toBe(420);
    expect(formatClock(instant)).toBe('7:30 am');
  });
});
