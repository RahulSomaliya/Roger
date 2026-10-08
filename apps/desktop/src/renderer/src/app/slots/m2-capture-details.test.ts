import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../../shared/capture';
import type { StoredMeeting } from '../../../../shared/meetings';
import type { CaptureMeeting } from '../captureMeeting';
import type { Shell } from '../ShellContext';
import type { MeetingSlotProps } from '../slotRegistry';
import { contributions } from './m2-capture-details';

// Node has no window.roger: the shell is a stand-in, as in m2-capture-status.test.ts. The reads and
// buttons are effects and handlers, which renderToStaticMarkup never runs; they are checked in the
// browser (e2e/redesign.qa.e2e.ts: the gap line, Details and Delete audio).
const fakes = vi.hoisted(() => ({ shell: null as Shell | null }));
vi.mock('../ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));

// The Details container reads the meeting page's view; its echo toggle is all it takes from it.
const view = vi.hoisted(() => ({ meeting: null as StoredMeeting | null }));
vi.mock('../../meeting/useMeeting', () => ({
  useMeetingView: () => ({ showHidden: false, setShowHidden: vi.fn(), meeting: view.meeting }),
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

function shell(status: CaptureStatus | null, captureMeeting: CaptureMeeting | null = null): Shell {
  return {
    route: { name: 'home' },
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

const resumed = (meetingId: string): CaptureStatus => ({
  ...IDLE,
  phase: 'recording',
  meetingId,
  startedAt: '2026-10-07T09:00:00.000Z',
  notices: [
    {
      kind: 'resumed-after-crash',
      source: null,
      at: '2026-10-07T09:00:00.000Z',
      message: 'Roger restarted and kept taking notes',
    },
  ],
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

describe('what M2-T20b mounts', () => {
  it('fills the three meeting regions, and nothing on Home', () => {
    // Kept audio is Details' now (re-runs start on their own): no `home` mount.
    expect(Object.keys(contributions).sort()).toEqual([
      'meetingAudioNote',
      'meetingBanner',
      'meetingCaptureReport',
    ]);
  });

  it('mounts no call-detected card: M5-T10’s panel renders it', () => {
    const ids = Object.values(contributions).flatMap((entries) => entries.map((entry) => entry.id));
    expect(ids.some((id) => id.includes('call'))).toBe(false);
  });

  it('puts the crash-resume line after the refused-lines line and the consent line', () => {
    expect(only(contributions.meetingBanner).id).toBe('m2-resumed-notice');
    expect(only(contributions.meetingBanner)).toMatchObject({ order: 10 });
  });
});

describe('the crash-resume notice', () => {
  const entry = only<MeetingSlotProps>(contributions.meetingBanner);
  const region = (meetingId: string): string =>
    renderToStaticMarkup(createElement(entry.component, { meetingId }));

  it('shows while the resumed meeting records, as a line with no Stop of its own', () => {
    fakes.shell = shell(resumed(A));
    expect(region(A)).toContain('Roger restarted and kept taking notes');
    expect(region(A)).not.toContain('Stop');
  });

  it('never shows on another meeting’s page, before main answers, or once recording ended', () => {
    fakes.shell = shell(resumed(A));
    expect(region(B)).toBe('');
    fakes.shell = shell(null);
    expect(region(A)).toBe('');
    fakes.shell = shell({ ...resumed(A), phase: 'stopping' });
    expect(region(A)).toBe('');
  });

  it('shows nothing for a recording that did not resume', () => {
    fakes.shell = shell({ ...resumed(A), notices: [] });
    expect(region(A)).toBe('');
  });
});

describe('the Details dialog content', () => {
  const entry = only<MeetingSlotProps>(contributions.meetingCaptureReport);
  const details = (meetingId: string): string =>
    renderToStaticMarkup(createElement(entry.component, { meetingId })).replaceAll('&#x27;', "'");
  const LIVE = (id: string): CaptureMeeting => ({ id, startedAt: '2026-10-07T09:00:00.000Z' });
  const recordingWith = (warnings: NonNullable<CaptureStatus['warnings']>): CaptureStatus => ({
    ...resumed(A),
    notices: [],
    streams: { mic: 'open', system: 'open' },
    sources: {
      mic: { health: 'active', chunks: 100, lastChunkAt: 1, message: null, device: 'Studio Mic' },
      system: { health: 'active', chunks: 100, lastChunkAt: 1, message: null },
    },
    warnings,
  });

  it('holds the sources, the counts and what is wrong, which the page no longer shows', () => {
    fakes.shell = shell(
      recordingWith([
        {
          kind: 'call-audio-silent',
          source: 'system',
          since: '2026-10-07T09:20:00.000Z',
          message: 'Call audio is silent. That is normal in a pause.',
          loud: false,
        },
      ]),
      LIVE(A),
    );
    const html = details(A);
    expect(html).toContain('Microphone');
    expect(html).toContain('Studio Mic');
    expect(html).toContain("Roger's server");
    // A quiet warning is Details', not a box above the page.
    expect(html).toContain('Call audio is silent. That is normal in a pause.');
    expect(html).not.toContain('level');
  });

  it('keeps the last recording’s cost after Stop, and says so plainly for a meeting with nothing', () => {
    fakes.shell = shell(IDLE, LIVE(A));
    expect(details(A)).toContain("Roger's server");
  });

  // D3: a past meeting with no capture report still opens onto something, never an empty dialog.
  it('holds the stored facts for a meeting with no capture report', () => {
    view.meeting = {
      id: B,
      title: 'Daily standup',
      startedAt: '2026-10-07T09:30:00.000Z',
      endedAt: '2026-10-07T09:57:00.000Z',
      segments: Array.from({ length: 12 }, (_, index) => ({
        id: `s${String(index)}`,
        meetingId: B,
        source: 'system' as const,
        speaker: 'them' as const,
        startMs: index * 1000,
        endMs: index * 1000 + 900,
        text: 'hello',
        confidence: 0.9,
        words: null,
        createdAt: '2026-10-07T09:30:10.000Z',
      })),
      attendees: [],
    };
    fakes.shell = shell(IDLE, LIVE(A));
    const html = details(B);
    expect(html).toContain('Saved on this Mac');
    expect(html).toContain('12 lines');
    expect(html).toMatch(/\d:\d\d [ap]m to \d+:\d\d [ap]m/);
    expect(html).not.toContain('Nothing was kept');
    view.meeting = null;
  });
});
