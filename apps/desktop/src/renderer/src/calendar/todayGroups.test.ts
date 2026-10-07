import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AllDayCalendarEvent,
  CalendarEvent,
  SelfResponse,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import { START_NOTES_LEAD_MS, startNotesAvailable, todayGroups } from './todayGroups';

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

  it('orders by start, with declined events greyed and last', () => {
    const nowMs = Date.parse('2026-10-06T04:00:00Z');
    const events = [
      timed('declined-early', '2026-10-06T04:30:00Z', '2026-10-06T05:00:00Z', {
        selfResponse: 'declined',
      }),
      timed('late', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      timed('early', '2026-10-06T05:00:00Z', '2026-10-06T05:30:00Z'),
    ];
    const { timed: today } = todayGroups({ events, links: NO_LINKS, nowMs });
    expect(ids(today)).toEqual(['early', 'late', 'declined-early']);
    expect(today.map((entry) => entry.declined)).toEqual([false, false, true]);
  });

  it('puts all-day events in a strip of their own, a multi-day one on each of its days', () => {
    const nowMs = Date.parse('2026-10-06T06:00:00Z');
    const events = [
      timed('call', '2026-10-06T09:00:00Z', '2026-10-06T09:30:00Z'),
      allDay('holiday', '2026-10-06', '2026-10-07'),
      allDay('offsite', '2026-10-05', '2026-10-08'), // 5, 6 and 7 Oct: the end is exclusive
      allDay('yesterday', '2026-10-05', '2026-10-06'),
      allDay('tomorrow', '2026-10-07', '2026-10-08'),
    ];
    const groups = todayGroups({ events, links: NO_LINKS, nowMs });
    expect(ids(groups.allDay)).toEqual(['holiday', 'offsite']);
    expect(ids(groups.timed)).toEqual(['call']);
  });

  it('marks a declined all-day event and never offers notes for it', () => {
    const nowMs = Date.parse('2026-10-06T06:00:00Z');
    const events = [
      allDay('ooo', '2026-10-06', '2026-10-07', { selfResponse: 'declined' }),
      allDay('holiday', '2026-10-06', '2026-10-07'),
    ];
    const { allDay: strip } = todayGroups({ events, links: NO_LINKS, nowMs });
    expect(ids(strip)).toEqual(['holiday', 'ooo']);
    expect(strip.map((entry) => entry.declined)).toEqual([false, true]);
    expect(strip.map((entry) => entry.startNotes)).toEqual([false, false]);
  });
});

describe('todayGroups in America/Los_Angeles (UTC-7)', () => {
  inZone('America/Los_Angeles', 420);

  it('keeps an all-day event on its own date, even when UTC has moved on to the next day', () => {
    // 20:00 PDT on 6 Oct is 03:00 UTC on the 7th: a midnight-UTC conversion would put the
    // 6 Oct all-day event a day back and the 7 Oct one on today.
    const nowMs = Date.parse('2026-10-07T03:00:00Z');
    const events = [
      allDay('sixth', '2026-10-06', '2026-10-07'),
      allDay('seventh', '2026-10-07', '2026-10-08'),
    ];
    expect(ids(todayGroups({ events, links: NO_LINKS, nowMs }).allDay)).toEqual(['sixth']);
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

  it('never offers it for an all-day event', () => {
    expect(startNotesAvailable(allDay('day', '2026-10-06', '2026-10-07'), start)).toBe(false);
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
      selfResponse: 'declined' satisfies SelfResponse,
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
    expect(ids(groups.timed)).toEqual(['done', 'running', 'later', 'declined']);
  });
});
