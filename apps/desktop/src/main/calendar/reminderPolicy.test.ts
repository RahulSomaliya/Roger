import { describe, expect, it } from 'vitest';
import {
  promptKey,
  type AllDayCalendarEvent,
  type CalendarAttendee,
  type CalendarEvent,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { ReminderLeadMinutes } from '../../shared/calendarPrefs';
import {
  dueEvents,
  dueWindow,
  isDue,
  missedReason,
  oneClearMatch,
  PROMPT_OPEN_AFTER_START_MS,
  promptWorthiness,
  promptWorthyEvents,
  sharesCard,
  type MissedReasonInput,
} from './reminderPolicy';

const MINUTE = 60_000;
const ms = (iso: string): number => Date.parse(iso);

const me: CalendarAttendee = {
  email: 'rahul@linkt.ai',
  displayName: 'Rahul',
  responseStatus: 'accepted',
  isSelf: true,
  isOrganizer: false,
};
const jane: CalendarAttendee = {
  email: 'jane@example.com',
  displayName: 'Jane',
  responseStatus: 'accepted',
  isSelf: false,
  isOrganizer: true,
};

/** A call: the user and one other person, with the Meet link Google added. */
function call(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'fake',
    id: 'call_1',
    icalUid: 'call_1@google.com',
    recurringEventId: null,
    title: 'Sync with Jane',
    status: 'confirmed',
    allDay: false,
    start: '2026-10-06T09:00:00Z',
    end: '2026-10-06T09:30:00Z',
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [me, jane],
    attendeesOmitted: false,
    videoLink: 'https://meet.google.com/abc-defg-hij',
    videoLinkSource: 'conference',
    htmlLink: null,
    ...overrides,
  };
}

/** A block on the user's own calendar: no other attendee. */
function solo(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return call({
    id: 'solo_1',
    title: 'Focus',
    selfResponse: 'organizer',
    attendees: [],
    videoLink: null,
    videoLinkSource: null,
    ...overrides,
  });
}

function allDay(): AllDayCalendarEvent {
  return {
    ...call(),
    id: 'offsite',
    allDay: true,
    start: null,
    end: null,
    startDate: '2026-10-06',
    endDate: '2026-10-07',
  };
}

describe('promptWorthiness', () => {
  it('never prompts an all-day event', () => {
    expect(promptWorthiness(allDay())).toEqual({ worthy: false, rule: 'all_day' });
  });

  it('never prompts a declined call', () => {
    expect(promptWorthiness(call({ selfResponse: 'declined' }))).toEqual({
      worthy: false,
      rule: 'declined',
    });
  });

  it('never prompts a solo block', () => {
    expect(promptWorthiness(solo())).toEqual({ worthy: false, rule: 'no_call_evidence' });
    expect(promptWorthiness(solo({ attendees: [me] }))).toEqual({
      worthy: false,
      rule: 'no_call_evidence',
    });
  });

  it('does not prompt a solo block whose only link is the Meet link Google added', () => {
    const lunch = solo({
      videoLink: 'https://meet.google.com/abc-defg-hij',
      videoLinkSource: 'conference',
    });
    expect(promptWorthiness(lunch)).toEqual({ worthy: false, rule: 'no_call_evidence' });
  });

  it('prompts a solo block with a Zoom link typed into the location or the description', () => {
    for (const source of ['location', 'description'] as const) {
      const block = solo({ videoLink: 'https://zoom.us/j/1234567890', videoLinkSource: source });
      expect(promptWorthiness(block)).toEqual({ worthy: true, event: block });
    }
  });

  it('prompts when Google left the other attendees out', () => {
    expect(promptWorthiness(solo({ attendees: [me], attendeesOmitted: true })).worthy).toBe(true);
  });

  it('prompts tentative and unanswered calls', () => {
    expect(promptWorthiness(call({ selfResponse: 'tentative' })).worthy).toBe(true);
    expect(promptWorthiness(call({ selfResponse: 'needs_action' })).worthy).toBe(true);
    expect(promptWorthiness(call({ status: 'tentative' })).worthy).toBe(true);
  });
});

describe('promptWorthyEvents', () => {
  it('keeps the calls in their order and drops the events that never prompt', () => {
    const first = call({ id: 'first' });
    const second = call({ id: 'second', start: '2026-10-06T08:00:00Z' });
    const events: CalendarEvent[] = [
      first,
      solo(),
      allDay(),
      call({ id: 'declined', selfResponse: 'declined' }),
      second,
    ];
    expect(promptWorthyEvents(events)).toEqual([first, second]);
  });
});

describe('isDue', () => {
  const event = call({ start: '2026-10-06T09:00:00Z' });
  const start = ms('2026-10-06T09:00:00Z');

  it.each([0, 1, 2, 5, 10] as const)('runs from start − %i min until start + 10 min', (lead) => {
    expect(isDue(event, start - lead * MINUTE - 1, lead)).toBe(false);
    expect(isDue(event, start - lead * MINUTE, lead)).toBe(true);
    expect(isDue(event, start + 4 * MINUTE, lead)).toBe(true);
    expect(isDue(event, start + PROMPT_OPEN_AFTER_START_MS - 1, lead)).toBe(true);
    expect(isDue(event, start + PROMPT_OPEN_AFTER_START_MS, lead)).toBe(false);
  });

  it('names the same window as dueWindow', () => {
    expect(dueWindow(event, 2)).toEqual({
      fromMs: start - 2 * MINUTE,
      untilMs: start + 10 * MINUTE,
    });
  });
});

describe('dueEvents', () => {
  const now = ms('2026-10-06T08:59:30Z');
  const none = new Set<string>();

  it('offers the calls that are due, earliest first, and nothing else', () => {
    const later = call({ id: 'later', start: '2026-10-06T09:00:20Z' });
    const first = call({ id: 'first', start: '2026-10-06T08:55:00Z' });
    const tomorrow = call({ id: 'tomorrow', start: '2026-10-07T09:00:00Z' });
    const events: CalendarEvent[] = [later, solo(), allDay(), first, tomorrow];
    expect(dueEvents(events, now, 1, none)).toEqual([first, later]);
  });

  it('offers each key once: a logged outcome never repeats', () => {
    const event = call();
    expect(dueEvents([event], now, 1, none)).toEqual([event]);
    expect(dueEvents([event], now, 1, new Set([promptKey(event)]))).toEqual([]);
    expect(dueEvents([event], now + 5 * MINUTE, 1, new Set([promptKey(event)]))).toEqual([]);
  });

  it('prompts a moved instance again at its new time', () => {
    const original = call({ id: 'standup_20261006', start: '2026-10-06T09:00:00Z' });
    const logged = new Set([promptKey(original)]);
    const moved = call({
      id: 'standup_20261006',
      start: '2026-10-06T11:00:00Z',
      end: '2026-10-06T11:15:00Z',
    });
    expect(dueEvents([moved], now, 1, logged)).toEqual([]);
    expect(dueEvents([moved], ms('2026-10-06T10:59:00Z'), 1, logged)).toEqual([moved]);
  });

  it('brings the prompt back when a declined call is accepted again', () => {
    const declined = call({ selfResponse: 'declined' });
    expect(dueEvents([declined], now, 1, none)).toEqual([]);
    const accepted = { ...declined, selfResponse: 'accepted' as const };
    expect(dueEvents([accepted], now, 1, none)).toEqual([accepted]);
  });

  it('uses the lead time it is given', () => {
    const event = call();
    expect(dueEvents([event], ms('2026-10-06T08:55:00Z'), 1, none)).toEqual([]);
    expect(dueEvents([event], ms('2026-10-06T08:55:00Z'), 5, none)).toEqual([event]);
  });
});

describe('sharesCard', () => {
  const ten = call({ id: 'a', start: '2026-10-06T10:00:00Z' });

  it('puts two calls in one minute on one card', () => {
    expect(sharesCard(ten, call({ id: 'b', start: '2026-10-06T10:00:00Z' }))).toBe(true);
    expect(sharesCard(ten, call({ id: 'b', start: '2026-10-06T10:00:59Z' }))).toBe(true);
    expect(sharesCard(ten, call({ id: 'b', start: '2026-10-06T09:59:30Z' }))).toBe(true);
  });

  it('gives calls a minute or more apart their own cards', () => {
    expect(sharesCard(ten, call({ id: 'b', start: '2026-10-06T10:01:00Z' }))).toBe(false);
    expect(sharesCard(ten, call({ id: 'b', start: '2026-10-06T10:30:00Z' }))).toBe(false);
  });
});

describe('oneClearMatch', () => {
  const now = ms('2026-10-06T09:10:00Z');
  const running = call({
    id: 'running',
    start: '2026-10-06T09:00:00Z',
    end: '2026-10-06T09:30:00Z',
  });
  const soon = call({ id: 'soon', start: '2026-10-06T09:15:00Z', end: '2026-10-06T09:45:00Z' });

  it('links the one call that is running', () => {
    expect(oneClearMatch([running], now)).toBe(running);
  });

  it('links the one call that starts within 5 minutes', () => {
    expect(oneClearMatch([soon], now)).toBe(soon);
    expect(oneClearMatch([soon], ms('2026-10-06T09:09:59Z'))).toBeNull();
  });

  it('links nothing once a call has ended', () => {
    expect(oneClearMatch([running], ms('2026-10-06T09:30:00Z'))).toBeNull();
  });

  it('links nothing when two calls overlap, rather than the wrong one', () => {
    const other = call({ id: 'other', start: '2026-10-06T09:05:00Z', end: '2026-10-06T09:35:00Z' });
    expect(oneClearMatch([running, other], now)).toBeNull();
    expect(oneClearMatch([running, soon], now)).toBeNull();
  });

  it('does not count events that never prompt', () => {
    const focus = solo({ start: '2026-10-06T09:00:00Z', end: '2026-10-06T10:00:00Z' });
    const declined = call({ id: 'declined', selfResponse: 'declined' });
    expect(oneClearMatch([focus, declined, allDay(), running], now)).toBe(running);
  });
});

describe('missedReason', () => {
  const event = call({ start: '2026-10-06T09:00:00Z' });
  const promptAt = ms('2026-10-06T08:59:00Z'); // start − 1 min
  const covered: Omit<MissedReasonInput, 'event'> = {
    leadMinutes: 1,
    connections: [{ connectedAtMs: ms('2026-10-01T10:00:00Z'), disconnectedAtMs: null }],
    runs: [{ startedAtMs: ms('2026-10-06T08:00:00Z'), lastTickAtMs: ms('2026-10-06T09:20:00Z') }],
    firstSeenAtMs: ms('2026-10-06T07:00:00Z'),
  };
  const reason = (overrides: Partial<MissedReasonInput>): string =>
    missedReason({ event, ...covered, ...overrides });

  it('is disconnected when no connection covered the prompt time, before any other reason', () => {
    expect(
      reason({
        connections: [
          { connectedAtMs: ms('2026-10-01T10:00:00Z'), disconnectedAtMs: promptAt - 1 },
          { connectedAtMs: promptAt + 1, disconnectedAtMs: null },
        ],
        runs: [],
        firstSeenAtMs: null,
      }),
    ).toBe('disconnected');
    expect(reason({ connections: [] })).toBe('disconnected');
  });

  it('is not_running when no Roger run covered the prompt time, before api_stale', () => {
    const ranUntilJustBefore = {
      startedAtMs: ms('2026-10-06T08:00:00Z'),
      lastTickAtMs: promptAt - 1,
    };
    const startedJustAfter = {
      startedAtMs: promptAt + 1,
      lastTickAtMs: ms('2026-10-06T09:20:00Z'),
    };
    expect(reason({ runs: [ranUntilJustBefore, startedJustAfter], firstSeenAtMs: null })).toBe(
      'not_running',
    );
  });

  it('is api_stale when the event first reached the cache after the prompt time', () => {
    expect(reason({ firstSeenAtMs: promptAt + 1 })).toBe('api_stale');
  });

  it('is api_stale when the event only came from the launch catch-up fetch', () => {
    expect(reason({ firstSeenAtMs: null })).toBe('api_stale');
  });

  it('is policy when Roger ran with the event cached and still showed nothing', () => {
    expect(reason({})).toBe('policy');
    expect(
      reason({
        connections: [{ connectedAtMs: promptAt, disconnectedAtMs: null }],
        runs: [{ startedAtMs: promptAt, lastTickAtMs: promptAt }],
        firstSeenAtMs: promptAt,
      }),
    ).toBe('policy');
  });

  it('measures the prompt time with the lead time', () => {
    const run = {
      startedAtMs: ms('2026-10-06T08:56:00Z'),
      lastTickAtMs: ms('2026-10-06T09:20:00Z'),
    };
    expect(reason({ runs: [run], leadMinutes: 1 })).toBe('policy');
    expect(reason({ runs: [run], leadMinutes: 5 })).toBe('not_running');
  });
});

describe('test_timing_is_instant_based', () => {
  /** Runs `scenario` with the process in `timeZone`; proves the zone took effect. */
  function inTimeZone<T>(timeZone: string, julyOffsetMinutes: number, scenario: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      expect(new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset()).toBe(julyOffsetMinutes);
      return scenario();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  // Los Angeles falls back on 2026-11-01: 01:30 happens twice, an hour apart, at 08:30Z and
  // 09:30Z. It springs forward on 2026-03-08, when 02:00 to 03:00 does not exist.
  const firstOneThirty = call({
    id: 'pdt',
    start: '2026-11-01T01:30:00-07:00',
    end: '2026-11-01T02:00:00-07:00',
  });
  const secondOneThirty = call({
    id: 'pst',
    start: '2026-11-01T01:30:00-08:00',
    end: '2026-11-01T02:00:00-08:00',
  });
  const afterSpringForward = call({
    id: 'spring',
    start: '2026-03-08T03:00:00-07:00',
    end: '2026-03-08T03:30:00-07:00',
  });
  const events = [firstOneThirty, secondOneThirty, afterSpringForward];

  function scenario(): string[] {
    const lead: ReminderLeadMinutes = 1;
    const lines: string[] = [];
    for (const [from, to] of [
      ['2026-11-01T08:00:00Z', '2026-11-01T10:00:00Z'],
      ['2026-03-08T09:30:00Z', '2026-03-08T10:30:00Z'],
    ] as const) {
      for (let now = ms(from); now <= ms(to); now += MINUTE) {
        const due = dueEvents(events, now, lead, new Set()).map((event) => event.id);
        const match = oneClearMatch(events, now)?.id ?? '-';
        lines.push(`${new Date(now).toISOString()} due=${due.join(',')} match=${match}`);
      }
    }
    return lines;
  }

  it('gives the same answers in Los Angeles and Kolkata, across both DST changes', () => {
    const losAngeles = inTimeZone('America/Los_Angeles', 420, scenario);
    const kolkata = inTimeZone('Asia/Kolkata', -330, scenario);
    expect(kolkata).toEqual(losAngeles);

    const dueAt = (iso: string): string | undefined =>
      losAngeles.find((line) => line.startsWith(iso));
    expect(dueAt('2026-11-01T08:28:00.000Z')).toContain('due= ');
    expect(dueAt('2026-11-01T08:29:00.000Z')).toContain('due=pdt ');
    expect(dueAt('2026-11-01T08:39:00.000Z')).toContain('due=pdt ');
    expect(dueAt('2026-11-01T08:40:00.000Z')).toContain('due= ');
    expect(dueAt('2026-11-01T09:29:00.000Z')).toContain('due=pst ');
    expect(dueAt('2026-03-08T09:58:00.000Z')).toContain('due= ');
    expect(dueAt('2026-03-08T09:59:00.000Z')).toContain('due=spring ');
  });
});
