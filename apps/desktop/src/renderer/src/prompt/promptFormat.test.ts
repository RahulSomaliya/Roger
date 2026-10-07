import { describe, expect, it } from 'vitest';
import type { CalendarAttendee } from '../../../shared/calendar';
import {
  attendeeSummary,
  callDetectedTitle,
  eventTitle,
  staleLabel,
  startLabel,
  timeRange,
} from './promptFormat';

const START = '2026-10-07T10:00:00.000Z';
const at = (offsetMs: number): number => Date.parse(START) + offsetMs;
const MIN = 60_000;

const person = (name: string | null, email: string, isSelf = false): CalendarAttendee => ({
  email,
  displayName: name,
  responseStatus: 'accepted',
  isSelf,
  isOrganizer: false,
});

const ME = person('Rahul Somaliya', 'rahul@linkt.ai', true);
const names = ['Jane Doe', 'Ali Khan', 'Sam Lee', 'Priya Rao', 'Tom Hill'];
const others = (count: number): CalendarAttendee[] =>
  names.slice(0, count).map((name) => person(name, `${name.split(' ')[0]?.toLowerCase()}@x.io`));

describe('startLabel', () => {
  it('says how far off the start is, rounding up so it never claims less than the wait', () => {
    expect(startLabel(START, at(-MIN))).toBe('Starting in 1 min');
    expect(startLabel(START, at(-61_000))).toBe('Starting in 2 min');
    expect(startLabel(START, at(-10 * MIN))).toBe('Starting in 10 min');
    expect(startLabel(START, at(-5_000))).toBe('Starting in 1 min');
  });

  it('says how long ago it started, rounding down', () => {
    expect(startLabel(START, at(3 * MIN))).toBe('Started 3 min ago');
    expect(startLabel(START, at(3 * MIN + 59_000))).toBe('Started 3 min ago');
    expect(startLabel(START, at(MIN))).toBe('Started 1 min ago');
  });

  it('says "Starting now" at the start and "Started just now" in its first minute', () => {
    expect(startLabel(START, at(0))).toBe('Starting now');
    expect(startLabel(START, at(30_000))).toBe('Started just now');
  });
});

describe('attendeeSummary', () => {
  it('names the first two others and counts the rest, never counting the user', () => {
    expect(attendeeSummary({ attendees: [ME, ...others(5)], attendeesOmitted: false })).toBe(
      'Jane, Ali and 3 others',
    );
    expect(attendeeSummary({ attendees: [ME, ...others(4)], attendeesOmitted: false })).toBe(
      'Jane, Ali and 2 others',
    );
  });

  it('names up to three in full, and "1 other" is never written for a person we can name', () => {
    expect(attendeeSummary({ attendees: [ME, ...others(3)], attendeesOmitted: false })).toBe(
      'Jane, Ali and Sam',
    );
    expect(attendeeSummary({ attendees: [ME, ...others(2)], attendeesOmitted: false })).toBe(
      'Jane and Ali',
    );
    expect(attendeeSummary({ attendees: [ME, ...others(1)], attendeesOmitted: false })).toBe(
      'Jane',
    );
  });

  it('has no line for a call with nobody else listed', () => {
    expect(attendeeSummary({ attendees: [ME], attendeesOmitted: false })).toBeNull();
    expect(attendeeSummary({ attendees: [], attendeesOmitted: false })).toBeNull();
  });

  it('falls back to the address before the @ when there is no display name', () => {
    const attendees = [person(null, 'ali.khan@x.io'), person('  ', 'sam@x.io')];
    expect(attendeeSummary({ attendees, attendeesOmitted: false })).toBe('ali.khan and sam');
  });

  it('says there are more when Google left attendees out', () => {
    expect(attendeeSummary({ attendees: [ME], attendeesOmitted: true })).toBe('Others');
    expect(attendeeSummary({ attendees: [ME, ...others(2)], attendeesOmitted: true })).toBe(
      'Jane, Ali and others',
    );
    expect(attendeeSummary({ attendees: [ME, ...others(5)], attendeesOmitted: true })).toBe(
      'Jane, Ali and 3+ others',
    );
  });

  it('handles 40 attendees without a long line', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      person(`Guest${index} Surname`, `g${index}@x.io`),
    );
    expect(attendeeSummary({ attendees: many, attendeesOmitted: false })).toBe(
      'Guest0, Guest1 and 38 others',
    );
  });
});

describe('eventTitle and callDetectedTitle', () => {
  it('calls an untitled invite "Untitled meeting", blank text included', () => {
    expect(eventTitle({ title: '' })).toBe('Untitled meeting');
    expect(eventTitle({ title: '   ' })).toBe('Untitled meeting');
    expect(eventTitle({ title: ' Weekly sync ' })).toBe('Weekly sync');
  });

  it('says which app is using the mic', () => {
    expect(callDetectedTitle({ bundleId: 'us.zoom.xos', name: 'Zoom' })).toBe(
      'Zoom is using the mic',
    );
  });
});

describe('timeRange', () => {
  it('writes the start and end in the given zone and locale', () => {
    expect(timeRange('2026-10-07T10:00:00.000Z', '2026-10-07T10:30:00.000Z', 'en-US', 'UTC')).toBe(
      '10:00 – 10:30 AM',
    );
    expect(
      timeRange('2026-10-07T10:00:00.000Z', '2026-10-07T10:30:00.000Z', 'en-US', 'Asia/Kolkata'),
    ).toBe('3:30 – 4:00 PM');
  });

  it('uses ordinary spaces, not the narrow no-break space newer ICU writes', () => {
    expect(
      timeRange('2026-10-07T11:30:00.000Z', '2026-10-07T12:30:00.000Z', 'en-US', 'UTC'),
    ).not.toMatch(/[\u202f\u2009\u00a0]/);
  });
});

describe('staleLabel', () => {
  const now = Date.parse('2026-10-07T18:00:00.000Z');

  it('gives the time when the last success was today', () => {
    expect(staleLabel('2026-10-07T09:41:00.000Z', now, 'en-US', 'UTC')).toBe(
      'Calendar not updated since 9:41 AM',
    );
  });

  it('adds the day when it was not today', () => {
    expect(staleLabel('2026-10-06T21:05:00.000Z', now, 'en-US', 'UTC')).toBe(
      'Calendar not updated since Tue 9:05 PM',
    );
  });

  it('says so when there has been no update at all', () => {
    expect(staleLabel(null, now, 'en-US', 'UTC')).toBe('Calendar has not updated yet');
  });
});
