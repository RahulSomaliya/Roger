import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AllDayCalendarEvent,
  CalendarEvent,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import {
  HERO_LEAD_MS,
  heroMeeting,
  START_NOTES_LEAD_MS,
  startNotesAvailable,
  todayGroups,
} from './todayGroups';

const MINUTE = 60_000;

function timed(
  id: string,
  start: string,
  end: string,
  fields: Partial<TimedCalendarEvent> = {},
): TimedCalendarEvent {
  return {
    provider: 'fake',
    id,
    icalUid: null,
    recurringEventId: null,
    title: id,
    status: 'confirmed',
    selfResponse: 'accepted',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    allDay: false,
    start,
    end,
    startDate: null,
    endDate: null,
    ...fields,
  };
}

function allDay(
  id: string,
  startDate: string,
  endDate: string,
  fields: Partial<AllDayCalendarEvent> = {},
): AllDayCalendarEvent {
  return {
    ...timed(id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    allDay: true,
    start: null,
    end: null,
    startDate,
    endDate,
    ...fields,
  };
}

function ids(entries: { event: CalendarEvent }[]): string[] {
  return entries.map((entry) => entry.event.id);
}

const NO_LINKS = new Map<string, string>();

/**
 * Runs the tests of a describe block in one time zone, and fails them if the switch did nothing (a
 * no-op switch passes any zone test).
 */
function inZone(zone: string, expectedOffsetMinutes: number): void {
  beforeEach(() => {
    vi.stubEnv('TZ', zone);
    expect(new Date('2026-10-06T12:00:00Z').getTimezoneOffset()).toBe(expectedOffsetMinutes);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

describe('todayGroups in Asia/Kolkata (UTC+5:30)', () => {
  inZone('Asia/Kolkata', -330);

  it('still shows the 10:00 standup at 23:30, 13.5 hours after it began', () => {
    const standup = timed('standup', '2026-10-06T04:30:00Z', '2026-10-06T05:00:00Z'); // 10:00 IST
    const nowMs = Date.parse('2026-10-06T18:00:00Z'); // 23:30 IST on 6 Oct
    const { timed: today } = todayGroups({ events: [standup], links: NO_LINKS, nowMs });
    expect(ids(today)).toEqual(['standup']);
  });

  it('keeps tomorrow and yesterday out, by the local date', () => {
    const nowMs = Date.parse('2026-10-06T06:00:00Z'); // 11:30 IST
    const events = [
      timed('last-night', '2026-10-05T17:00:00Z', '2026-10-05T18:00:00Z'), // 22:30 IST on the 5th
      timed('today', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      timed('tomorrow-early', '2026-10-06T18:30:00Z', '2026-10-06T19:00:00Z'), // 00:00 IST on the 7th
    ];
    expect(ids(todayGroups({ events, links: NO_LINKS, nowMs }).timed)).toEqual(['today']);
  });

  it('shows an event over midnight on both days', () => {
    const late = timed('late', '2026-10-06T17:30:00Z', '2026-10-06T19:30:00Z'); // 23:00 to 01:00 IST
    const sixth = Date.parse('2026-10-06T06:00:00Z');
    const seventh = Date.parse('2026-10-07T06:00:00Z');
    expect(ids(todayGroups({ events: [late], links: NO_LINKS, nowMs: sixth }).timed)).toEqual([
      'late',
    ]);
    expect(ids(todayGroups({ events: [late], links: NO_LINKS, nowMs: seventh }).timed)).toEqual([
      'late',
    ]);
    const eighth = Date.parse('2026-10-08T06:00:00Z');
    expect(todayGroups({ events: [late], links: NO_LINKS, nowMs: eighth }).timed).toEqual([]);
  });

  it('orders by start', () => {
    const nowMs = Date.parse('2026-10-06T04:00:00Z');
    const events = [
      timed('late', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      timed('early', '2026-10-06T05:00:00Z', '2026-10-06T05:30:00Z'),
    ];
    expect(ids(todayGroups({ events, links: NO_LINKS, nowMs }).timed)).toEqual(['early', 'late']);
  });

  it('leaves out a meeting the user declined: they are not going', () => {
    const nowMs = Date.parse('2026-10-06T04:00:00Z');
    const events = [
      timed('declined', '2026-10-06T04:30:00Z', '2026-10-06T05:00:00Z', {
        selfResponse: 'declined',
      }),
      timed('kept', '2026-10-06T05:00:00Z', '2026-10-06T05:30:00Z'),
    ];
    expect(ids(todayGroups({ events, links: NO_LINKS, nowMs }).timed)).toEqual(['kept']);
  });

  it('leaves out all-day events: nobody starts notes on one', () => {
    const nowMs = Date.parse('2026-10-06T06:00:00Z');
    const events = [
      timed('call', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      allDay('holiday', '2026-10-06', '2026-10-07'),
      allDay('offsite', '2026-10-05', '2026-10-08'),
    ];
    expect(ids(todayGroups({ events, links: NO_LINKS, nowMs }).timed)).toEqual(['call']);
  });
});

describe('Start notes and Open note', () => {
  inZone('Asia/Kolkata', -330);

  const start = Date.parse('2026-10-06T09:00:00Z');
  const call = timed('call', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z');

  it('offers Start notes from 15 minutes before the start until the end', () => {
    expect(START_NOTES_LEAD_MS).toBe(15 * MINUTE);
    expect(startNotesAvailable(call, start - 15 * MINUTE - 1)).toBe(false);
    expect(startNotesAvailable(call, start - 15 * MINUTE)).toBe(true);
    expect(startNotesAvailable(call, start)).toBe(true);
    expect(startNotesAvailable(call, start + 30 * MINUTE - 1)).toBe(true);
    expect(startNotesAvailable(call, start + 30 * MINUTE)).toBe(false);
  });

  it('sets startNotes on the entry from the clock', () => {
    const early = todayGroups({ events: [call], links: NO_LINKS, nowMs: start - 20 * MINUTE });
    const near = todayGroups({ events: [call], links: NO_LINKS, nowMs: start - 10 * MINUTE });
    expect(early.timed.map((entry) => entry.startNotes)).toEqual([false]);
    expect(near.timed.map((entry) => entry.startNotes)).toEqual([true]);
  });

  it('carries the meeting a local meeting already has for the event, whatever the clock says', () => {
    const links = new Map([['call', 'meeting-7']]);
    const { timed: today } = todayGroups({ events: [call], links, nowMs: start - 3 * 60 * MINUTE });
    expect(today[0]?.meetingId).toBe('meeting-7');
    const unlinked = todayGroups({ events: [call], links: NO_LINKS, nowMs: start });
    expect(unlinked.timed[0]?.meetingId).toBeNull();
  });
});

describe('the next meeting', () => {
  inZone('Asia/Kolkata', -330);

  const events = [
    timed('done', '2026-10-06T04:00:00Z', '2026-10-06T04:30:00Z'),
    timed('running', '2026-10-06T05:00:00Z', '2026-10-06T06:00:00Z'),
    timed('declined', '2026-10-06T06:00:00Z', '2026-10-06T07:00:00Z', {
      selfResponse: 'declined',
    }),
    timed('later', '2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z'),
  ];

  it('is the meeting under way, else the next to start, and never a declined one', () => {
    const at = (iso: string) =>
      todayGroups({ events, links: NO_LINKS, nowMs: Date.parse(iso) }).next?.event.id;
    expect(at('2026-10-06T04:45:00Z')).toBe('running');
    expect(at('2026-10-06T05:30:00Z')).toBe('running');
    expect(at('2026-10-06T06:00:00Z')).toBe('later');
  });

  it('is null once nothing is left today', () => {
    const groups = todayGroups({
      events,
      links: NO_LINKS,
      nowMs: Date.parse('2026-10-06T10:00:00Z'),
    });
    expect(groups.next).toBeNull();
    expect(ids(groups.timed)).toEqual(['done', 'running', 'later']);
  });
});

describe("the hero meeting (Home's Start notes is for it)", () => {
  inZone('Asia/Kolkata', -330);

  const start = Date.parse('2026-10-06T09:00:00Z');
  const call = timed('call', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z');
  const hero = (nowMs: number, links = NO_LINKS) =>
    heroMeeting(todayGroups({ events: [call], links, nowMs }), nowMs);

  it('is the next meeting from 10 minutes before it starts', () => {
    expect(HERO_LEAD_MS).toBe(10 * MINUTE);
    expect(hero(start - 10 * MINUTE - 1)).toBeNull();
    expect(hero(start - 10 * MINUTE)?.event.id).toBe('call');
    expect(hero(start - 2 * MINUTE)?.event.id).toBe('call');
  });

  it('stays while the meeting is on, and goes when it ends', () => {
    expect(hero(start + 29 * MINUTE)?.event.id).toBe('call');
    expect(hero(start + 30 * MINUTE)).toBeNull();
  });

  it('is nothing when the meeting already has its notes: a second Start would make a second note', () => {
    expect(hero(start, new Map([['call', 'meeting-7']]))).toBeNull();
  });
});
