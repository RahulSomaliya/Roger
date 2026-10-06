import { describe, expect, it } from 'vitest';
import {
  MAX_MEETING_ATTENDEES,
  parseInstant,
  promptKey,
  toMeetingCalendarEvent,
  toUtcInstant,
  type CalendarAttendee,
  type TimedCalendarEvent,
} from './calendar';

function attendee(n: number): CalendarAttendee {
  return {
    email: `person${n}@example.com`,
    displayName: `Person ${n}`,
    responseStatus: 'accepted',
    isSelf: n === 0,
    isOrganizer: n === 1,
  };
}

function timedEvent(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'google',
    id: 'evt_1',
    icalUid: 'uid_1@google.com',
    recurringEventId: null,
    title: 'Weekly sync',
    status: 'confirmed',
    allDay: false,
    start: '2026-10-06T09:00:00Z',
    end: '2026-10-06T09:30:00Z',
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [attendee(0), attendee(1)],
    attendeesOmitted: false,
    videoLink: 'https://meet.google.com/abc-defg-hij',
    videoLinkSource: 'conference',
    htmlLink: null,
    ...overrides,
  };
}

describe('parseInstant', () => {
  it('reads an instant in UTC or with an offset as epoch ms', () => {
    expect(parseInstant('2026-10-06T09:00:00Z')).toBe(Date.UTC(2026, 9, 6, 9));
    expect(parseInstant('2026-10-06T09:00:00.250Z')).toBe(Date.UTC(2026, 9, 6, 9, 0, 0, 250));
    expect(parseInstant('2026-10-06T14:30:00+05:30')).toBe(Date.UTC(2026, 9, 6, 9));
    expect(parseInstant('2026-10-06T02:00:00-07:00')).toBe(Date.UTC(2026, 9, 6, 9));
  });

  it('reads 29 February in a leap year', () => {
    expect(parseInstant('2028-02-29T10:00:00Z')).toBe(Date.UTC(2028, 1, 29, 10));
  });

  it.each([
    ['2026-10-06T09:00:00', 'no zone: it would be read in this Mac’s zone'],
    ['2026-10-06', 'a plain date'],
    ['Tue Oct 06 2026 09:00:00 GMT+0000', 'not ISO 8601'],
    ['2026-13-01T09:00:00Z', 'no such month'],
    ['2026-02-30T10:00:00Z', 'no such day: Date.parse alone reads 2 March'],
    ['2026-02-29T10:00:00Z', 'no such day: 2026 is not a leap year'],
    ['2026-04-31T10:00:00+02:00', 'no such day: April has 30'],
    ['', 'empty'],
  ])('refuses %s (%s) and names the value', (value) => {
    expect(() => parseInstant(value)).toThrow(`"${value}"`);
  });
});

describe('toUtcInstant', () => {
  it('writes the stored form, which sorts as text', () => {
    expect(toUtcInstant('2026-10-06T14:30:00+05:30')).toBe('2026-10-06T09:00:00.000Z');
  });
});

describe('promptKey', () => {
  it('is the event id at its start instant', () => {
    expect(promptKey(timedEvent())).toBe('evt_1@2026-10-06T09:00:00.000Z');
  });

  it('is the same for one instant written with another offset', () => {
    const utc = timedEvent({ start: '2026-10-06T09:00:00Z' });
    const ist = timedEvent({ start: '2026-10-06T14:30:00+05:30' });
    expect(promptKey(ist)).toBe(promptKey(utc));
  });

  it('changes when an instance moves, so the moved instance prompts again', () => {
    const moved = timedEvent({ start: '2026-10-06T10:00:00Z', end: '2026-10-06T10:30:00Z' });
    expect(promptKey(moved)).not.toBe(promptKey(timedEvent()));
  });
});

describe('toMeetingCalendarEvent', () => {
  it('carries the ids, the scheduled times and the attendees in invite order', () => {
    const event = timedEvent({
      id: 'evt_9_20261006T090000Z',
      recurringEventId: 'evt_9',
      start: '2026-10-06T14:30:00+05:30',
    });
    expect(toMeetingCalendarEvent(event)).toEqual({
      provider: 'google',
      eventId: 'evt_9_20261006T090000Z',
      icalUid: 'uid_1@google.com',
      recurringEventId: 'evt_9',
      scheduledStart: '2026-10-06T09:00:00.000Z',
      scheduledEnd: '2026-10-06T09:30:00.000Z',
      attendees: [attendee(0), attendee(1)],
    });
  });

  it('keeps the first 200 attendees, the most the API stores', () => {
    const many = Array.from({ length: MAX_MEETING_ATTENDEES + 5 }, (_, n) => attendee(n));
    const link = toMeetingCalendarEvent(timedEvent({ attendees: many }));
    expect(link.attendees).toHaveLength(MAX_MEETING_ATTENDEES);
    expect(link.attendees.at(-1)).toEqual(attendee(MAX_MEETING_ATTENDEES - 1));
  });
});
