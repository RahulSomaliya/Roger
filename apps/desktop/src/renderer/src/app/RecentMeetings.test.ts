import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import type { MeetingSummary } from '../../../shared/meetings';
import type { Read } from '../meeting/useMeeting';
import type * as UseMeeting from '../meeting/useMeeting';
import { RecentMeetings } from './RecentMeetings';
import type { Route } from './router';
import type { Shell } from './ShellContext';

// Node has no window.roger: the shell and the list read are stand-ins.
const fakes = vi.hoisted(() => ({
  shell: null as Shell | null,
  recent: null as Read<MeetingSummary[]> | null,
}));
vi.mock('./ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));
vi.mock('../meeting/useMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof UseMeeting>()),
  useRecentMeetings: () => {
    if (fakes.recent === null) throw new Error('set fakes.recent first');
    return fakes.recent;
  },
}));

const STANDUP = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const RENEWAL = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});
const MEETINGS: MeetingSummary[] = [
  {
    id: RENEWAL,
    title: 'Northwind renewal: scope and pricing',
    startedAt: '2026-10-06T14:00:00.000Z',
    endedAt: null,
  },
  {
    id: STANDUP,
    title: 'Daily standup',
    startedAt: '2026-10-05T09:30:04.000Z',
    endedAt: '2026-10-05T09:33:16.000Z',
  },
];

function shell(route: Route, status: CaptureStatus | null = IDLE, recordingId?: string): Shell {
  return {
    route,
    navigate: vi.fn(),
    capture: {
      status,
      segments: [],
      interim: { mic: null, system: null },
      localError: null,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting:
      recordingId === undefined ? null : { id: recordingId, startedAt: '2026-10-06T14:00:00.000Z' },
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

function recent(value: MeetingSummary[] | undefined, error: string | null = null) {
  return { value, error, refresh: vi.fn() };
}

const render = (): string => renderToString(createElement(RecentMeetings));

/** Each meeting button: its full title and whether it is the page shown. */
function buttons(html: string): { title: string; current: boolean }[] {
  return [...html.matchAll(/<button[^>]*title="([^"]*)"[^>]*>/g)].map((match) => ({
    title: match[1] ?? '',
    current: match[0].includes('aria-current="page"'),
  }));
}

beforeEach(() => {
  fakes.shell = shell({ name: 'home' });
  fakes.recent = recent(undefined);
});

describe('RecentMeetings', () => {
  it('lists the meetings on this Mac in the order main gives, marking the one shown', () => {
    fakes.shell = shell({ name: 'meeting', meetingId: STANDUP });
    fakes.recent = recent(MEETINGS);
    expect(buttons(render())).toEqual([
      { title: 'Northwind renewal: scope and pricing', current: false },
      { title: 'Daily standup', current: true },
    ]);
  });

  it('marks the meeting Roger is recording, for sight and for screen readers', () => {
    fakes.shell = shell(
      { name: 'home' },
      { ...IDLE, phase: 'recording', meetingId: RENEWAL, startedAt: '2026-10-06T14:00:00.000Z' },
      RENEWAL,
    );
    fakes.recent = recent(MEETINGS);
    const html = render();
    expect(html.match(/class="recording-dot"/g)).toHaveLength(1);
    expect(html).toMatch(/Recording: <\/span><span class="sidebar-link-text">Northwind renewal/);
  });

  it('says there are none only once main has answered', () => {
    expect(render()).not.toContain('No meetings yet');
    fakes.recent = recent([]);
    expect(render()).toContain('No meetings yet');
  });

  it('says why the list failed, with Try again, and keeps the list it had', () => {
    fakes.recent = recent(MEETINGS, 'Roger could not list the meetings on this Mac: disk full');
    const html = render();
    expect(html).toMatch(
      /role="alert"[^>]*>.*Roger could not list the meetings on this Mac: disk full/,
    );
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(buttons(html)).toHaveLength(2);
    expect(html).not.toContain('No meetings yet');
  });
});
