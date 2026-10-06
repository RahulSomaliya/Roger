import { describe, expect, it } from 'vitest';
import { meetingTimeLabel, recentMeetingLabel } from './meetingTimes';

// Built from local clock readings, so the day boundaries hold in any time zone the suite runs in.
const at = (day: number, hour: number, minute: number, year = 2026): string =>
  new Date(year, 9, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 6, 15, 0);
const LOCALE = 'en-GB';

describe('recentMeetingLabel', () => {
  it('is the start time for a meeting today, else its day', () => {
    expect(recentMeetingLabel(at(6, 9, 5), NOW, LOCALE)).toBe('9:05');
    expect(recentMeetingLabel(at(5, 23, 50), NOW, LOCALE)).toBe('Yesterday');
    expect(recentMeetingLabel(at(2, 9, 5), NOW, LOCALE)).toBe('2 Oct');
    expect(recentMeetingLabel(at(2, 9, 5, 2025), NOW, LOCALE)).toBe('2 Oct 2025');
  });
});

describe('meetingTimeLabel', () => {
  it('says when a meeting that is still recording started', () => {
    expect(meetingTimeLabel({ startedAt: at(6, 9, 5), endedAt: null }, true, NOW, LOCALE)).toBe(
      'Started 9:05',
    );
    expect(meetingTimeLabel({ startedAt: at(5, 23, 50), endedAt: null }, true, NOW, LOCALE)).toBe(
      'Started yesterday, 23:50',
    );
  });

  it('gives an ended meeting its day and its span', () => {
    expect(
      meetingTimeLabel({ startedAt: at(6, 9, 30), endedAt: at(6, 9, 41) }, false, NOW, LOCALE),
    ).toBe('Today, 9:30 to 9:41');
    expect(
      meetingTimeLabel({ startedAt: at(5, 14, 0), endedAt: at(5, 14, 45) }, false, NOW, LOCALE),
    ).toBe('Yesterday, 14:00 to 14:45');
    expect(
      meetingTimeLabel({ startedAt: at(2, 9, 30), endedAt: at(2, 9, 33) }, false, NOW, LOCALE),
    ).toBe('Fri 2 Oct, 9:30 to 9:33');
    expect(
      meetingTimeLabel(
        { startedAt: at(2, 9, 30, 2025), endedAt: at(2, 10, 0, 2025) },
        false,
        NOW,
        LOCALE,
      ),
    ).toBe('2 Oct 2025, 9:30 to 10:00');
  });

  it('names both days when a meeting ran past midnight', () => {
    expect(
      meetingTimeLabel({ startedAt: at(4, 23, 30), endedAt: at(5, 0, 15) }, false, NOW, LOCALE),
    ).toBe('Sun 4 Oct, 23:30 to yesterday, 0:15');
  });

  it('gives only the start when a meeting has no end and is not recording', () => {
    // A crash left it open (main closes those at the next start), or main has not answered yet.
    expect(meetingTimeLabel({ startedAt: at(6, 9, 5), endedAt: null }, false, NOW, LOCALE)).toBe(
      'Today, 9:05',
    );
  });
});
