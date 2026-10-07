import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../../shared/capture';
import type { Shell } from '../ShellContext';
import type { MeetingSlotProps } from '../slotRegistry';
import { contributions } from './m2-capture-details';

// Node has no window.roger: the shell is a stand-in, as in m2-capture-status.test.ts. The reads and
// buttons are effects and handlers, which renderToStaticMarkup never runs; they are checked in the
// browser (e2e/capture-details.shots.e2e.ts).
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

function shell(status: CaptureStatus | null): Shell {
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
    captureMeeting: null,
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
  it('fills the home card and the three meeting regions, and nothing else', () => {
    expect(Object.keys(contributions).sort()).toEqual([
      'home',
      'meetingAudioNote',
      'meetingCaptureReport',
      'meetingCaptureStatus',
    ]);
  });

  it('mounts no call-detected card: M5-T10’s panel renders it', () => {
    const ids = Object.values(contributions).flatMap((entries) => entries.map((entry) => entry.id));
    expect(ids.some((id) => id.includes('call'))).toBe(false);
  });

  it('sits after M2-T20a’s capture status, in the same region', () => {
    expect(only(contributions.meetingCaptureStatus).id).toBe('m2-resumed-notice');
    expect(only(contributions.meetingCaptureStatus)).toMatchObject({ order: 10 });
  });
});

describe('the crash-resume notice', () => {
  const entry = only<MeetingSlotProps>(contributions.meetingCaptureStatus);
  const region = (meetingId: string): string =>
    renderToStaticMarkup(createElement(entry.component, { meetingId }));

  it('shows while the resumed meeting records, with its Stop', () => {
    fakes.shell = shell(resumed(A));
    expect(region(A)).toContain('Roger restarted and kept taking notes');
    expect(region(A)).toContain('Stop recording');
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
