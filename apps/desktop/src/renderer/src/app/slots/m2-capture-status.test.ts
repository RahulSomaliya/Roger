import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../../shared/capture';
import type { CaptureMeeting } from '../captureMeeting';
import type { Route } from '../router';
import type { Shell } from '../ShellContext';
import type { MeetingSlotProps, NoProps } from '../slotRegistry';
import { contributions } from './m2-capture-status';

// Node has no window.roger: the shell is a stand-in, as in meeting/MeetingPage.test.ts.
const fakes = vi.hoisted(() => ({ shell: null as Shell | null }));
vi.mock('../ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));

const A = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const B = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});
const NO_CALL_AUDIO = {
  kind: 'no-audio',
  source: 'system',
  since: '2026-10-07T09:12:00.000Z',
  message: 'No call audio has reached Roger for 5 seconds: it cannot hear the call.',
  loud: true,
} as const;

function shell(
  status: CaptureStatus | null,
  captureMeeting: CaptureMeeting | null = null,
  route: Route = { name: 'home' },
): Shell {
  return {
    route,
    navigate: vi.fn(),
    capture: {
      status,
      lastMeetingId: null,
      localError: null,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

const recording = (meetingId: string): CaptureStatus => ({
  ...IDLE,
  phase: 'recording',
  meetingId,
  startedAt: '2026-10-07T09:00:00.000Z',
  streams: { mic: 'open', system: 'open' },
  warnings: [NO_CALL_AUDIO],
});

function only<Props>(entries: readonly { id: string; component: ComponentType<Props> }[] = []) {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) throw new Error('no entry');
  return entry;
}

beforeEach(() => {
  fakes.shell = shell(null);
});

describe('the capture warnings in the banner slot', () => {
  const Banner = only<NoProps>(contributions.banner).component;
  const banner = (): string => renderToStaticMarkup(createElement(Banner, {}));

  it("shows main's warnings on any page, whichever meeting the page shows", () => {
    fakes.shell = shell(recording(A), { id: A, startedAt: '2026-10-07T09:00:00.000Z' });
    expect(banner()).toContain('No call audio has reached Roger for 5 seconds');
  });

  it('leaves the loud ones to the status line on the page of the meeting that records', () => {
    // The header's status line says them in its one line, so the editor under the person's cursor
    // never moves; the same fact twice would also break "one message says a thing once".
    const live = { id: A, startedAt: '2026-10-07T09:00:00.000Z' };
    fakes.shell = shell(recording(A), live, { name: 'meeting', meetingId: A });
    expect(banner()).toBe('');
    // Another meeting's page, or Settings, has no such line: the banner says it.
    fakes.shell = shell(recording(A), live, { name: 'meeting', meetingId: B });
    expect(banner()).toContain('No call audio has reached Roger for 5 seconds');
    fakes.shell = shell(recording(A), live, { name: 'settings' });
    expect(banner()).toContain('No call audio has reached Roger for 5 seconds');
  });

  it('shows nothing before main answers, or while nothing is wrong', () => {
    expect(banner()).toBe('');
    fakes.shell = shell(IDLE);
    expect(banner()).toBe('');
  });
});

describe('lines the server refused for good, in the banner (house rule 1: always seen)', () => {
  const Banner = only<NoProps>(contributions.banner).component;
  const banner = (): string => renderToStaticMarkup(createElement(Banner, {}));
  const LIVE = (id: string): CaptureMeeting => ({ id, startedAt: '2026-10-07T09:00:00.000Z' });
  const refusedIdle: CaptureStatus = { ...IDLE, upload: { ...IDLE.upload, rejected: 3 } };

  // QA (redesign R13): the line showed under a meeting's header only, never on Home or Settings,
  // so a person who stopped a call and stayed on Home was not told it was not saved.
  it('says it on Home and on Settings, whichever meeting the lines were from', () => {
    for (const route of [{ name: 'home' }, { name: 'settings' }] as const) {
      fakes.shell = shell(refusedIdle, LIVE(A), route);
      const html = banner();
      expect(html).toContain('role="alert"');
      expect(html).toContain('Roger&#x27;s server refused 3 lines for good');
    }
  });

  it("says it on another meeting's page, which has no line of its own", () => {
    fakes.shell = shell(refusedIdle, LIVE(A), { name: 'meeting', meetingId: B });
    expect(banner()).toContain('refused 3 lines for good');
  });

  it('leaves it to the meeting page whose header already says it, so it shows once', () => {
    // Both decide through captureStatusFor: this page is the meeting main describes (m2-capture-status.ts).
    fakes.shell = shell(refusedIdle, LIVE(A), { name: 'meeting', meetingId: A });
    expect(banner()).toBe('');
    const header = renderToStaticMarkup(
      createElement(only<MeetingSlotProps>(contributions.meetingBanner).component, {
        meetingId: A,
      }),
    );
    expect(header).toContain('refused 3 lines for good');
  });

  it('says nothing when none was refused', () => {
    fakes.shell = shell(IDLE, LIVE(A), { name: 'home' });
    expect(banner()).toBe('');
  });
});

describe('lines the server refused for good', () => {
  const entry = only<MeetingSlotProps>(contributions.meetingBanner);
  const line = (meetingId: string): string =>
    renderToStaticMarkup(createElement(entry.component, { meetingId }));
  const refused = (meetingId: string, rejected: number): CaptureStatus => ({
    ...recording(meetingId),
    warnings: [],
    upload: { ...IDLE.upload, rejected },
  });
  const LIVE = (id: string): CaptureMeeting => ({ id, startedAt: '2026-10-07T09:00:00.000Z' });

  it('shows a loud problem line on the page of the meeting main describes', () => {
    fakes.shell = shell(refused(A, 2), LIVE(A));
    const html = line(A);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Roger&#x27;s server refused 2 lines for good');
  });

  it('keeps showing after Stop: the lines are still not on the server', () => {
    fakes.shell = shell({ ...IDLE, upload: { ...IDLE.upload, rejected: 1 } }, LIVE(A));
    expect(line(A)).toContain('refused 1 line for good');
  });

  it('shows nothing when none was refused, before main answers, or on another meeting', () => {
    fakes.shell = shell(refused(A, 0), LIVE(A));
    expect(line(A)).toBe('');
    fakes.shell = shell(null);
    expect(line(A)).toBe('');
    fakes.shell = shell(refused(A, 2), LIVE(A));
    expect(line(B)).toBe('');
  });
});

describe("the meeting page's capture status", () => {
  const entry = only<MeetingSlotProps>(contributions.meetingCaptureStatus);
  const region = (meetingId: string): string =>
    renderToStaticMarkup(createElement(entry.component, { meetingId }));

  it("replaces M1's StatusPanel", () => {
    expect(entry.id).toBe('m2-capture-status');
  });

  it("shows the status of the meeting it records, and never another meeting's", () => {
    fakes.shell = shell(
      { ...recording(B), warnings: [] },
      { id: B, startedAt: '2026-10-07T09:00:00.000Z' },
    );
    expect(region(B)).toContain('aria-label="Capture status"');
    expect(region(B)).toContain('Recording');
    expect(region(A)).toBe('');
  });

  it('puts a loud warning in the line, the one message the page says about it', () => {
    fakes.shell = shell(recording(B), { id: B, startedAt: '2026-10-07T09:00:00.000Z' });
    const html = region(B);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Roger can&#x27;t hear the call');
    expect(html).not.toContain('Recording');
  });

  it('says nothing after Stop: the meter is Details’ now', () => {
    fakes.shell = shell(IDLE, { id: B, startedAt: '2026-10-07T09:00:00.000Z' });
    expect(region(B)).toBe('');
  });
});
