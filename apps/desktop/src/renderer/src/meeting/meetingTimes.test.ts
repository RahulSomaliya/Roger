import { describe, expect, it } from 'vitest';
import { meetingTimeLabel } from './meetingTimes';

// Built from local clock readings, so the day boundaries hold in any time zone the suite runs in.
const at = (day: number, hour: number, minute: number, year = 2026): string =>
  new Date(year, 9, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 6, 15, 0);
// The clock never follows the locale (formatClock: 12-hour, lowercase, whatever the Mac says); the
// locale only orders the dates.
const LOCALE = 'en-GB';

describe('meetingTimeLabel', () => {
  it('says when a meeting that is still recording started', () => {
    expect(meetingTimeLabel({ startedAt: at(6, 9, 5), endedAt: null }, true, NOW, LOCALE)).toBe(
      'Started 9:05 am',
    );
    expect(meetingTimeLabel({ startedAt: at(5, 23, 50), endedAt: null }, true, NOW, LOCALE)).toBe(
      'Started yesterday, 11:50 pm',
    );
  });

  it('gives an ended meeting its day and its span', () => {
    expect(
      meetingTimeLabel({ startedAt: at(6, 9, 30), endedAt: at(6, 9, 41) }, false, NOW, LOCALE),
    ).toBe('Today, 9:30 am to 9:41 am');
    expect(
      meetingTimeLabel({ startedAt: at(5, 14, 0), endedAt: at(5, 14, 45) }, false, NOW, LOCALE),
    ).toBe('Yesterday, 2:00 pm to 2:45 pm');
    expect(
      meetingTimeLabel({ startedAt: at(2, 9, 30), endedAt: at(2, 9, 33) }, false, NOW, LOCALE),
    ).toBe('Fri 2 Oct, 9:30 am to 9:33 am');
    expect(
      meetingTimeLabel(
        { startedAt: at(2, 9, 30, 2025), endedAt: at(2, 10, 0, 2025) },
        false,
        NOW,
        LOCALE,
      ),
    ).toBe('2 Oct 2025, 9:30 am to 10:00 am');
  });

  it('names both days when a meeting ran past midnight', () => {
    expect(
      meetingTimeLabel({ startedAt: at(4, 23, 30), endedAt: at(5, 0, 15) }, false, NOW, LOCALE),
    ).toBe('Sun 4 Oct, 11:30 pm to yesterday, 12:15 am');
  });

  it('gives only the start when a meeting has no end and is not recording', () => {
    // A crash left it open (main closes those at the next start), or main has not answered yet.
    expect(meetingTimeLabel({ startedAt: at(6, 9, 5), endedAt: null }, false, NOW, LOCALE)).toBe(
      'Today, 9:05 am',
    );
  });
});
