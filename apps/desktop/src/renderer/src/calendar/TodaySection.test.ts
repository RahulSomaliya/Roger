import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LOGIN_ITEMS_SETTINGS_PATH } from '../../../shared/ipc/loginItem';
import {
  allDayEvent,
  at,
  attendee,
  calendarState,
  NOW_MS,
  plain,
  timedEvent,
} from './calendarTesting';
import { OpenAtLoginLine, TodaySectionView, type TodaySectionViewProps } from './TodaySection';

function view(fields: Partial<TodaySectionViewProps> = {}): string {
  return plain(
    renderToStaticMarkup(
      createElement(TodaySectionView, {
        state: calendarState(),
        nowMs: NOW_MS,
        startError: null,
        startBlocked: false,
        openAtLogin: null,
        onStart: vi.fn(),
        onOpen: vi.fn(),
        onConnect: vi.fn(),
        onReload: vi.fn(),
        onUndoOpenAtLogin: vi.fn(),
        onDismissOpenAtLogin: vi.fn(),
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

  it('offers to connect, and says what Roger does with the calendar', () => {
    const html = view({ state: notConnected });
    expect(html).toContain('See your day in Roger');
    expect(html).toContain('Connect Google Calendar</button>');
    expect(html).toContain('Roger only reads your calendar');
    expect(html).not.toContain('Today</h2>');
  });

  it('says it waits for the browser, and lets the user start over', () => {
    const html = view({ state: calendarState({ ...notConnected, connecting: true }) });
    expect(html).toContain('Finish signing in in your browser');
    expect(html).toContain('Open Google again</button>');
  });

  it('shows the API refusal, such as an unticked calendar box', () => {
    const html = view({
      state: calendarState({
        ...notConnected,
        connectError: 'Tick the calendar box and try again',
      }),
    });
    expect(html).toMatch(
      /role="alert">Roger could not connect Google Calendar: Tick the calendar box and try again</,
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
    expect(html).not.toContain('See your day in Roger');
  });
});

describe('Home, with a calendar', () => {
  it('says nothing is on the calendar today, with the day named', () => {
    const html = view({ state: calendarState({ events: [] }) });
    expect(html).toContain('Today</h2>');
    expect(html).toContain('Nothing on your calendar today');
  });

  it('lists the day in order, the meeting under way as the larger Next card', () => {
    const html = view({ state: calendarState({ events: DAY }) });
    const titles = [...html.matchAll(/class="calendar-title">([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual([
      'Standup',
      'Design review',
      'Lunch with Sam',
      'Weekly sync',
      'Planning',
      'One on one',
      'Retro',
      'Optional demo',
    ]);
    expect(html.match(/class="calendar-next"/g)).toHaveLength(1);
    expect(html).toMatch(/calendar-next[^]*Now · Started 15 min ago[^]*Design review/);
    expect(html).toContain('Jane and Ali');
    expect(html).toMatch(/\d{1,2}:\d{2}/);
  });

  it('greys the declined meeting, says so, and puts it last', () => {
    const html = view({ state: calendarState({ events: DAY }) });
    expect(html).toMatch(/calendar-row calendar-declined[^]*Optional demo[^]*Declined/);
    expect(html.lastIndexOf('Optional demo')).toBeGreaterThan(html.lastIndexOf('Retro'));
  });

  it('marks a meeting that is over, and gives it no button', () => {
    const html = view({ state: calendarState({ events: DAY }) });
    expect(html).toContain('calendar-row calendar-over');
    expect(html).not.toContain('Start notes for Standup');
  });

  it('puts the all-day events in a strip on top, a declined one greyed', () => {
    const html = view({
      state: calendarState({
        events: [
          allDayEvent('ooo', { title: 'Sam out', selfResponse: 'declined' }),
          allDayEvent('holiday', { title: 'Public holiday' }),
          ...DAY,
        ],
      }),
    });
    expect(html).toContain('aria-label="All-day events"');
    expect(html.indexOf('Public holiday')).toBeLessThan(html.indexOf('Standup'));
    expect(html).toContain('calendar-chip calendar-declined">Sam out (declined)');
  });

  it('keeps tomorrow’s meetings out', () => {
    const tomorrow = timedEvent(
      'tomorrow',
      new Date(2026, 9, 7, 10).toISOString(),
      new Date(2026, 9, 7, 11).toISOString(),
    );
    expect(view({ state: calendarState({ events: [tomorrow] }) })).toContain(
      'Nothing on your calendar today',
    );
  });
});

describe('Start notes and Open note', () => {
  it('offers Start notes from 15 minutes before a meeting, never before', () => {
    // 11:00 now: Weekly sync at 14:00 is hours off, Lunch at 12:00 is an hour off, and a meeting
    // at 11:10 is within the window.
    const events = [
      timedEvent('far', at(14), at(14, 30), { title: 'Far off' }),
      timedEvent('soon', at(11, 10), at(11, 40), { title: 'Soon' }),
    ];
    const html = view({ state: calendarState({ events }) });
    expect(html).toContain('aria-label="Start notes for Soon"');
    expect(html).not.toContain('Start notes for Far off');
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

  it('waits for the note being taken before a second one starts', () => {
    const events = [timedEvent('soon', at(11, 10), at(11, 40), { title: 'Soon' })];
    const html = view({ state: calendarState({ events }), startBlocked: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start notes<\/button>/);
    expect(html).toContain('Stop the note you are taking first.');
  });
});

describe('Home, when something is wrong', () => {
  const events = [timedEvent('review', at(10, 45), at(11, 30), { title: 'Design review' })];

  it('keeps the meetings it has when the connection cannot be checked, and says so', () => {
    const html = view({
      state: calendarState({
        events,
        connectionStatus: 'failed',
        connectionError: 'API is down',
      }),
    });
    expect(html).toContain('Roger could not check your Google Calendar connection: API is down');
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

  it('shows why a start failed before main could answer', () => {
    const html = view({
      state: calendarState({ events }),
      startError: 'Roger could not start notes for this meeting: IPC closed',
    });
    expect(html).toMatch(/role="alert">Roger could not start notes for this meeting: IPC closed</);
  });
});

describe('the line after the first connect', () => {
  const line = (phase: 'on' | 'approval' | 'undone', error: string | null = null): string =>
    plain(
      renderToStaticMarkup(
        createElement(OpenAtLoginLine, {
          phase,
          error,
          onUndo: vi.fn(),
          onDismiss: vi.fn(),
        }),
      ),
    );

  it('says Roger will open at login so it can remind you, with Undo', () => {
    const html = line('on');
    expect(html).toContain('Roger will open at login so it can remind you.');
    expect(html).toContain('Undo</button>');
  });

  it('says where to allow it when macOS waits for approval, with no Undo', () => {
    const html = line('approval');
    expect(html).toContain(LOGIN_ITEMS_SETTINGS_PATH.replace('&', '&amp;'));
    expect(html).not.toContain('Undo');
  });

  it('confirms an Undo, and says why one failed', () => {
    expect(line('undone')).toContain('Roger will not open at login.');
    expect(line('on', 'preferences.json is read-only')).toContain(
      'Roger could not undo it: preferences.json is read-only',
    );
  });

  it('shows above the day only when the first connect earned it', () => {
    const events = [timedEvent('review', at(10, 45), at(11, 30))];
    const html = view({
      state: calendarState({ events, justConnected: true }),
      openAtLogin: { phase: 'on', error: null },
    });
    expect(html).toContain('Roger will open at login so it can remind you.');
    expect(view({ state: calendarState({ events }) })).not.toContain('open at login');
  });
});
