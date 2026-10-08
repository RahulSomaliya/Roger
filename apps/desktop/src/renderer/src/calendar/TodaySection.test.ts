import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  allDayEvent,
  at,
  attendee,
  calendarState,
  CONNECTION,
  NOW_MS,
  plain,
  timedEvent,
} from './calendarTesting';
import {
  MeetingAction,
  TodaySectionView,
  type MeetingActions,
  type TodaySectionViewProps,
} from './TodaySection';
import { todayGroups, type TimedEntry } from './todayGroups';

function view(fields: Partial<TodaySectionViewProps> = {}): string {
  return plain(
    renderToStaticMarkup(
      createElement(TodaySectionView, {
        state: calendarState(),
        nowMs: NOW_MS,
        heroEventId: null,
        startBlocked: false,
        onStart: vi.fn(),
        onOpen: vi.fn(),
        onConnect: vi.fn(),
        onReload: vi.fn(),
        ...fields,
      }),
    ),
  );
}

/** A day like the plan's QA: a finished standup, the call under way, and six more. */
const DAY = [
  timedEvent('standup', at(9), at(9, 30), { title: 'Standup' }),
  timedEvent('review', at(10, 45), at(11, 30), {
    title: 'Design review',
    attendees: [attendee('You', { isSelf: true }), attendee('Jane Doe'), attendee('Ali Khan')],
  }),
  timedEvent('lunch', at(12), at(13), { title: 'Lunch with Sam' }),
  timedEvent('sync', at(14), at(14, 30), { title: 'Weekly sync' }),
  timedEvent('planning', at(15), at(16), { title: 'Planning' }),
  timedEvent('1on1', at(16, 30), at(17), { title: 'One on one' }),
  timedEvent('retro', at(17, 30), at(18), { title: 'Retro' }),
  timedEvent('skip', at(13, 30), at(14), { title: 'Optional demo', selfResponse: 'declined' }),
];

describe('Home, before a calendar is connected', () => {
  const notConnected = calendarState({ connection: null, sync: null, events: [] });

  it('offers one secondary button and one helper line, with no heading or card', () => {
    const html = view({ state: notConnected });
    expect(html).toContain('Connect Google Calendar</button>');
    expect(html).toContain('opens at login');
    expect(html).toContain('only reads your calendar');
    expect(html).not.toContain('See your day in Roger');
    expect(html).not.toContain('data-variant="primary"');
    expect(html).not.toContain('Today</h2>');
  });

  it('says it waits for the browser, and keeps the button so a second press starts over', () => {
    const html = view({ state: calendarState({ ...notConnected, connecting: true }) });
    expect(html).toContain('Finish signing in in your browser');
    expect(html).toContain('Connect Google Calendar</button>');
    expect(html).not.toContain('Open Google again');
  });

  it('shows the API refusal, such as an unticked calendar box, as an alert problem line', () => {
    const html = view({
      state: calendarState({
        ...notConnected,
        connectError: 'Tick the calendar box and try again',
      }),
    });
    expect(html).toMatch(
      /role="alert"[^>]*><svg[^]*Roger could not connect Google Calendar: Tick the calendar box and try again</,
    );
  });

  it('says it is loading, rather than offering to connect, before the first answer', () => {
    const html = view({
      state: calendarState({
        ...notConnected,
        connectionStatus: 'loading',
        loaded: false,
      }),
    });
    expect(html).toContain('Loading your calendar');
    expect(html).not.toContain('Connect Google Calendar');
  });

  it('says why the connection could not be read, with a way to try again', () => {
    const html = view({
      state: calendarState({
        ...notConnected,
        connectionStatus: 'failed',
        connectionError: 'API is down',
      }),
    });
    expect(html).toContain('Roger could not reach your Google Calendar connection: API is down');
    expect(html).toContain('Try again</button>');
    expect(html).not.toContain('only reads your calendar');
  });
});

describe('Home, with a calendar', () => {
  it('shows nothing at all for an empty day: no heading, no "Nothing on your calendar today"', () => {
    expect(view({ state: calendarState({ events: [] }) })).toBe('');
  });

  it('lists the day in order, a time and a title per row and nothing else', () => {
    const html = view({ state: calendarState({ events: DAY }) });
    expect(html).toContain('Today</h2>');
    const titles = [...html.matchAll(/class="today-title"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual([
      'Standup',
      'Design review',
      'Lunch with Sam',
      'Weekly sync',
      'Planning',
      'One on one',
      'Retro',
    ]);
    expect(html).toContain('<span class="today-time">9:00 am</span>');
    expect(html).toContain('<span class="today-time">5:30 pm</span>');
    expect(html).not.toContain('Jane and Ali');
  });

  it('leaves out the declined meeting and the all-day events', () => {
    const html = view({
      state: calendarState({
        events: [allDayEvent('holiday', { title: 'Release week' }), ...DAY],
      }),
    });
    expect(html).not.toContain('Optional demo');
    expect(html).not.toContain('Release week');
    expect(html).not.toContain('calendar-chip');
  });

  it('marks a meeting that is over, and gives it no button', () => {
    const html = view({ state: calendarState({ events: DAY }) });
    expect(html).toContain('data-over="true"');
    expect(html).not.toContain('Start notes for Standup');
  });

  it('keeps tomorrow’s meetings out', () => {
    const tomorrow = timedEvent(
      'tomorrow',
      new Date(2026, 9, 7, 10).toISOString(),
      new Date(2026, 9, 7, 11).toISOString(),
    );
    expect(view({ state: calendarState({ events: [tomorrow] }) })).toBe('');
  });
});

describe('a row’s button', () => {
  it('offers Start notes from 15 minutes before a meeting, never before', () => {
    // 11:00 now: Weekly sync at 14:00 is hours off, and a meeting at 11:10 is within the window.
    const events = [
      timedEvent('far', at(14), at(14, 30), { title: 'Far off' }),
      timedEvent('soon', at(11, 10), at(11, 40), { title: 'Soon' }),
    ];
    const html = view({ state: calendarState({ events }) });
    expect(html).toContain('aria-label="Start notes for Soon"');
    expect(html).not.toContain('Start notes for Far off');
  });

  it('is a ghost button in the fixed right column, not a primary', () => {
    const events = [timedEvent('soon', at(11, 10), at(11, 40), { title: 'Soon' })];
    const html = view({ state: calendarState({ events }) });
    expect(html).toMatch(/class="btn today-action" data-variant="ghost" data-size="sm"/);
    expect(html).not.toContain('data-variant="primary"');
  });

  it('shows Open note, not Start notes, when a local meeting already has the event', () => {
    const events = [timedEvent('review', at(10, 45), at(11, 30), { title: 'Design review' })];
    const html = view({
      state: calendarState({ events, links: new Map([['review', 'meeting-9']]) }),
    });
    expect(html).toContain('aria-label="Open note for Design review"');
    expect(html).not.toContain('Start notes');
  });

  it('shows Open note for a meeting that is not under way either', () => {
    const events = [timedEvent('lunch', at(12), at(13), { title: 'Lunch' })];
    const html = view({ state: calendarState({ events, links: new Map([['lunch', 'm1']]) }) });
    expect(html).toContain('Open note</button>');
  });

  it('is gone while a note is being taken: Stop is the hero’s, and one recording at a time', () => {
    const events = [timedEvent('soon', at(11, 10), at(11, 40), { title: 'Soon' })];
    const html = view({ state: calendarState({ events }), startBlocked: true });
    expect(html).not.toContain('Start notes');
    expect(html).not.toContain('disabled');
  });

  it('leaves the hero’s meeting to the hero: its row has no button of its own', () => {
    const events = [timedEvent('soon', at(11, 5), at(11, 40), { title: 'Soon' })];
    const html = view({ state: calendarState({ events }), heroEventId: 'soon' });
    expect(html).toContain('>Soon</span>');
    expect(html).not.toContain('Start notes');
  });
});

describe('MeetingAction', () => {
  const event = timedEvent('a', at(11, 10), at(11, 40), { title: 'Soon' });

  function entryFor(links: ReadonlyMap<string, string> = new Map(), nowMs = NOW_MS): TimedEntry {
    const entry = todayGroups({ events: [event], links, nowMs }).timed[0];
    if (entry === undefined) throw new Error('the event is not on the test day');
    return entry;
  }

  const handlers = (): MeetingActions => ({
    startBlocked: false,
    onStart: vi.fn(),
    onOpen: vi.fn(),
  });

  function onClickOf(element: ReactElement | null): () => void {
    if (!isValidElement<{ onClick: () => void }>(element)) throw new Error('no button rendered');
    return element.props.onClick;
  }

  it('starts notes for the event itself when pressed', () => {
    const actions = handlers();
    onClickOf(MeetingAction({ entry: entryFor(), ...actions }))();
    expect(actions.onStart).toHaveBeenCalledWith(event);
    expect(actions.onOpen).not.toHaveBeenCalled();
  });

  it('opens the meeting that has the event when pressed, and never offers a second Start for it', () => {
    const actions = handlers();
    onClickOf(MeetingAction({ entry: entryFor(new Map([['a', 'meeting-3']])), ...actions }))();
    expect(actions.onOpen).toHaveBeenCalledWith('meeting-3');
    expect(actions.onStart).not.toHaveBeenCalled();
  });

  it('shows no button before the Start notes window when there is no note', () => {
    const tenOClock = new Date(2026, 9, 6, 10).getTime(); // an hour before the 11:10 start
    expect(MeetingAction({ entry: entryFor(new Map(), tenOClock), ...handlers() })).toBeNull();
  });
});

describe('Home, when something is wrong', () => {
  const events = [timedEvent('review', at(10, 45), at(11, 30), { title: 'Design review' })];

  it('keeps the meetings it has when the connection cannot be checked, and says so in one quiet line', () => {
    const html = view({
      state: calendarState({
        events,
        connectionStatus: 'failed',
        connectionError: 'API is down',
      }),
    });
    expect(html).toContain('Roger could not check your Google Calendar connection: API is down');
    expect(html).toContain('role="status"');
    expect(html).toContain('Try again</button>');
    expect(html).toContain('Design review');
  });

  it('says why the copy could not be read', () => {
    const html = view({ state: calendarState({ copyError: 'calendar.sqlite is locked' }) });
    expect(html).toContain('Roger could not read your calendar: calendar.sqlite is locked');
  });

  it('says why Open note is unavailable, rather than quietly offering Start notes again', () => {
    const html = view({ state: calendarState({ events, linksError: 'event id is too long' }) });
    expect(html).toContain(
      'Roger could not check which meetings already have notes: event id is too long',
    );
  });

  it('says the calendar is stale and since when, as one line with no button', () => {
    const html = view({
      state: calendarState({
        events,
        sync: {
          lastSuccessAt: new Date(2026, 9, 6, 9, 12).toISOString(),
          lastError: 'Google answered 503',
          staleSince: new Date(2026, 9, 6, 10, 12).toISOString(),
          reconnectRequired: false,
        },
      }),
    });
    expect(html).toContain('Calendar not updated since 9:12 am');
    expect(html).not.toContain('Reconnect');
  });

  it('puts Reconnect beside a refused grant, and shows why a reconnect failed', () => {
    const html = view({
      state: calendarState({
        events,
        connection: { ...CONNECTION, status: 'reconnect_required' },
        connectError: 'Tick the calendar box',
      }),
    });
    expect(html).toContain('needs you to sign in again');
    expect(html).toContain('Reconnect</button>');
    expect(html).toMatch(
      /role="alert"[^]*Roger could not connect Google Calendar: Tick the calendar box/,
    );
  });

  it('has exactly one problem line for several problems, the refused grant first', () => {
    const html = view({
      state: calendarState({
        events,
        connection: { ...CONNECTION, status: 'reconnect_required' },
        copyError: 'disk is full',
        linksError: 'busy',
      }),
    });
    expect(html.match(/class="problem today-problem"/g)).toHaveLength(1);
    expect(html).toContain('needs you to sign in again');
    expect(html).not.toContain('disk is full');
  });

  it('says it waits for the browser while a reconnect is open', () => {
    const html = view({
      state: calendarState({
        events,
        connection: { ...CONNECTION, status: 'reconnect_required' },
        connecting: true,
      }),
    });
    expect(html).toContain('Finish signing in in your browser');
  });
});
