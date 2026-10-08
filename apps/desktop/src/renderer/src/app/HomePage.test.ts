import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idleCaptureStatus, type CaptureStatus } from '../../../shared/capture';
import type { MeetingSummary } from '../../../shared/meetings';
import { at, calendarState, NOW_MS, timedEvent } from '../calendar/calendarTesting';
import type { CalendarState } from '../calendar/calendarStore';
import type { Read } from '../meeting/useMeeting';
import { HomePage } from './HomePage';
import { HOME } from './router';
import type { Shell } from './ShellContext';

// Node has no window.roger: the shell, the calendar and the list read are stand-ins.
const fakes = vi.hoisted(() => ({
  shell: null as Shell | null,
  calendar: null as CalendarState | null,
  recent: null as Read<MeetingSummary[]> | null,
  /** The refreshKey each render passed: what decides when the list reads again. */
  keys: [] as string[],
}));
vi.mock('./ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));
vi.mock('../calendar/useCalendar', () => ({
  useCalendar: () => {
    if (fakes.calendar === null) throw new Error('set fakes.calendar first');
    return { state: fakes.calendar, store: {} };
  },
  useNow: () => NOW_MS,
}));
vi.mock('../meeting/useMeeting', () => ({
  useRecentMeetings: (refreshKey: string) => {
    if (fakes.recent === null) throw new Error('set fakes.recent first');
    fakes.keys.push(refreshKey);
    return fakes.recent;
  },
}));

const RENEWAL = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
const STANDUP = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const STARTED = new Date(2026, 9, 6, 10, 45).toISOString();
const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});
const MEETINGS: MeetingSummary[] = [
  { id: RENEWAL, title: 'Northwind renewal', startedAt: STARTED, endedAt: null },
  {
    id: STANDUP,
    title: 'Daily standup',
    startedAt: new Date(2026, 9, 5, 9, 30).toISOString(),
    endedAt: new Date(2026, 9, 5, 9, 45).toISOString(),
  },
];

function shell(status: CaptureStatus | null = IDLE, live = false, busy = false): Shell {
  return {
    route: HOME,
    navigate: vi.fn(),
    capture: {
      status,
      lastMeetingId: status?.meetingId ?? null,
      localError: null,
      busy,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting: live ? { id: RENEWAL, startedAt: STARTED } : null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

const recording = (phase: 'recording' | 'stopping' = 'recording'): CaptureStatus => ({
  ...IDLE,
  phase,
  meetingId: RENEWAL,
  startedAt: STARTED,
});

const render = (): string => renderToString(createElement(HomePage)).replaceAll('<!-- -->', '');

/** How many primary buttons the page has: the design allows one per view. */
const primaries = (html: string): number => html.match(/data-variant="primary"/g)?.length ?? 0;

beforeEach(() => {
  fakes.shell = shell();
  fakes.calendar = calendarState({ events: [] });
  fakes.recent = { value: MEETINGS, error: null, refresh: vi.fn() };
  fakes.keys = [];
});

describe('Home, idle', () => {
  it('is one large Start notes and nothing else when nothing is near', () => {
    const html = render();
    expect(html).toMatch(/data-variant="primary" data-size="lg"[^>]*>Start notes</);
    expect(primaries(html)).toBe(1);
    // No heading that names nothing, no empty-state card, no recording card.
    // Home still has an h1, for focus on arrival and the screen reader: hidden, and "Home".
    expect(html).toContain('<h1 class="sr-only">Home</h1>');
    expect(html).not.toContain('empty-state');
    expect(html).not.toContain('Take notes on your next call');
    expect(html).not.toContain('Recording now');
  });

  it('puts the meeting that starts within 10 minutes above Start notes, and keeps one primary', () => {
    fakes.calendar = calendarState({
      events: [timedEvent('sync', at(11, 8), at(11, 40), { title: 'Weekly sync' })],
    });
    const html = render();
    expect(html).toContain('Next · Starting in 8 min');
    expect(html).toContain('<h1 class="home-hero-title">Weekly sync</h1>');
    expect(primaries(html)).toBe(1);
    // Its row in Today has no Start of its own.
    expect(html).not.toContain('Start notes for Weekly sync');
  });

  it('keeps a meeting further off out of the hero, with its Start on the row only from 15 minutes before', () => {
    fakes.calendar = calendarState({
      events: [timedEvent('sync', at(11, 12), at(11, 40), { title: 'Weekly sync' })],
    });
    const html = render();
    expect(html).not.toContain('home-hero-title');
    expect(html).toContain('aria-label="Start notes for Weekly sync"');
    expect(primaries(html)).toBe(1);
  });

  it('lists the past meetings under Earlier, minus the one that records', () => {
    const html = render();
    expect(html).toContain('>Earlier</h2>');
    expect(html).toContain('Daily standup');
    expect(html).toContain('Northwind renewal');
  });

  it('says Starting… on a busy button that keeps its colour, while main starts a recording', () => {
    fakes.shell = shell({ ...IDLE, phase: 'starting' });
    const html = render();
    expect(html).toMatch(
      /data-variant="primary" data-size="lg" aria-disabled="true"[^>]*>Starting…</,
    );
    expect(html).not.toContain('disabled=""');
    fakes.shell = shell(IDLE, false, true);
    expect(render()).toContain('aria-disabled="true"');
  });
});

describe('Home, while a call records', () => {
  beforeEach(() => {
    fakes.shell = shell(recording(), true);
  });

  it('shows the live meeting and Stop as the one primary, and no recording card or second Start', () => {
    const html = render();
    expect(html).toContain('Recording · started 10:45 am');
    expect(html).toMatch(/class="home-hero-link"[^>]*>Northwind renewal</);
    expect(html).toMatch(/data-variant="primary"[^>]*>Stop</);
    expect(primaries(html)).toBe(1);
    expect(html).not.toContain('Start notes');
    expect(html).not.toContain('Recording now');
    expect(html).not.toContain('Open</button>');
  });

  it('lists the live meeting only in the hero, never again under Earlier', () => {
    const html = render();
    expect(html.match(/Northwind renewal/g)).toHaveLength(1);
    expect(html).toContain('Daily standup');
  });

  it('offers no row Start while recording', () => {
    fakes.calendar = calendarState({
      events: [timedEvent('soon', at(11, 5), at(11, 40), { title: 'Soon' })],
    });
    expect(render()).not.toContain('Start notes for Soon');
  });

  it('says Stopping… on a busy Stop that keeps its colour', () => {
    fakes.shell = shell(recording('stopping'), true);
    const html = render();
    expect(html).toMatch(/data-variant="primary" aria-disabled="true"[^>]*>Stopping…</);
  });

  it('names the meeting by its start when the list has no title for it', () => {
    fakes.recent = { value: [], error: null, refresh: vi.fn() };
    expect(render()).toMatch(/class="home-hero-link"[^>]*>Meeting at 10:45 am</);
  });

  it('shows no guessed title before the list answers', () => {
    fakes.recent = { value: undefined, error: null, refresh: vi.fn() };
    const html = render();
    expect(html).not.toContain('home-hero-link');
    expect(html).toMatch(/data-variant="primary"[^>]*>Stop</);
  });
});

describe('Home, reading the list', () => {
  it('reads again when a recording starts or stops, never on the idle heartbeat', () => {
    const keyFor = (fake: Shell): string => {
      fakes.shell = fake;
      fakes.keys = [];
      render();
      const [key] = fakes.keys;
      if (key === undefined) throw new Error('Home never asked for the list');
      return key;
    };
    // Main sends an idle status after every uploader pass, every 2 s, each a new object.
    const idle = keyFor(shell({ ...IDLE }));
    expect(keyFor(shell({ ...IDLE, upload: { ...IDLE.upload, pending: 4 } }))).toBe(idle);
    expect(keyFor(shell(recording(), true))).not.toBe(idle);
  });
});

describe('Home, the columns at 960 px and up (D2)', () => {
  it('puts the hero and the calendar line left, Today and Earlier right', () => {
    fakes.calendar = calendarState({
      events: [timedEvent('sync', at(13), at(14), { title: 'Weekly sync' })],
    });
    const html = render();
    const main = html.indexOf('class="home-main"');
    const side = html.indexOf('class="home-side"');
    expect(main).toBeGreaterThan(-1);
    expect(side).toBeGreaterThan(main);
    expect(html.indexOf('Start notes</button>')).toBeLessThan(side);
    expect(html.indexOf('>Today</h2>')).toBeGreaterThan(side);
    expect(html.indexOf('>Earlier</h2>')).toBeGreaterThan(html.indexOf('>Today</h2>'));
  });

  it('leaves the right column empty, so it is absent, when neither list has anything', () => {
    fakes.recent = { value: [], error: null, refresh: vi.fn() };
    expect(render()).toContain('<div class="home-side"></div>');
  });

  it('keeps Connect under the hero on the left', () => {
    fakes.calendar = calendarState({ connection: null, events: [] });
    const html = render();
    expect(html.indexOf('Connect Google Calendar')).toBeLessThan(html.indexOf('class="home-side"'));
  });
});
