import { describe, expect, it } from 'vitest';
import {
  elapsedInWords,
  fallbackMeetingTitle,
  formatClockTime,
  formatElapsed,
  meetingDayLabel,
  windowTitle,
} from './labels';

// Every case builds its dates from local parts, so it reads the same in any zone.
const local = (day: number, hour = 9, minute = 0, month = 9, year = 2026): Date =>
  new Date(year, month, day, hour, minute);
const NOW = local(7, 17, 30);

describe('formatClockTime', () => {
  it('is the 12-hour clock whatever the Mac is set to', () => {
    expect(formatClockTime(local(7, 9, 14).toISOString())).toBe('9:14 am');
    expect(formatClockTime(local(7, 17, 1).toISOString())).toBe('5:01 pm');
  });
});

describe('fallbackMeetingTitle', () => {
  it('names a meeting by its start, the way main names a new one', () => {
    expect(fallbackMeetingTitle(local(7, 17, 1).toISOString())).toBe('Meeting at 5:01 pm');
  });
});

describe('formatElapsed', () => {
  const since = local(7, 9, 0).getTime();
  const after = (minutes: number): number => since + minutes * 60_000;

  it('counts minutes under an hour, rounding down', () => {
    expect(formatElapsed(since, after(0))).toBe('0m');
    expect(formatElapsed(since, after(12) + 59_000)).toBe('12m');
    expect(formatElapsed(since, after(59))).toBe('59m');
  });

  it('adds hours from the first, as "1h 23m"', () => {
    expect(formatElapsed(since, after(60))).toBe('1h 0m');
    expect(formatElapsed(since, after(83))).toBe('1h 23m');
  });

  it('never goes negative when the clock is a little behind the start', () => {
    expect(formatElapsed(since, since - 5_000)).toBe('0m');
  });
});

describe('elapsedInWords', () => {
  const since = local(7, 9, 0).getTime();
  const after = (minutes: number): number => since + minutes * 60_000;

  it('says it in words for a screen reader, singular and plural', () => {
    expect(elapsedInWords(since, after(0))).toBe('less than a minute');
    expect(elapsedInWords(since, after(1))).toBe('1 minute');
    expect(elapsedInWords(since, after(12))).toBe('12 minutes');
    expect(elapsedInWords(since, after(60))).toBe('1 hour');
    expect(elapsedInWords(since, after(83))).toBe('1 hour 23 minutes');
    expect(elapsedInWords(since, after(121))).toBe('2 hours 1 minute');
  });
});

describe('meetingDayLabel', () => {
  it('says Today and Yesterday, by the local calendar day', () => {
    expect(meetingDayLabel(local(7, 0, 5).toISOString(), NOW)).toBe('Today');
    expect(meetingDayLabel(local(6, 23, 50).toISOString(), NOW)).toBe('Yesterday');
  });

  it('writes an older day as "Mon 5 Oct", with the year only for another year', () => {
    expect(meetingDayLabel(local(5, 9, 5).toISOString(), NOW)).toBe('Mon 5 Oct');
    expect(meetingDayLabel(local(2, 9, 5, 9, 2025).toISOString(), NOW)).toBe('Thu 2 Oct 2025');
  });
});

describe('windowTitle', () => {
  it('names each page, and a meeting by its own title', () => {
    expect(windowTitle({ name: 'home' }, '')).toBe('Roger');
    expect(windowTitle({ name: 'settings' }, '')).toBe('Settings');
    expect(windowTitle({ name: 'setup' }, '')).toBe('Set up Roger');
    const meeting = { name: 'meeting', meetingId: 'x' } as const;
    expect(windowTitle(meeting, ' Northwind renewal ')).toBe('Northwind renewal');
    expect(windowTitle(meeting, '')).toBe('Roger');
  });
});
