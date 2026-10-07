import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../../shared/capture';
import type { CaptureMeeting } from '../captureMeeting';
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

function shell(status: CaptureStatus | null, captureMeeting: CaptureMeeting | null = null): Shell {
  return {
    route: { name: 'home' },
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

  it('shows nothing before main answers, or while nothing is wrong', () => {
    expect(banner()).toBe('');
    fakes.shell = shell(IDLE);
    expect(banner()).toBe('');
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
    fakes.shell = shell(recording(B), { id: B, startedAt: '2026-10-07T09:00:00.000Z' });
    expect(region(B)).toContain('aria-label="Capture status"');
    expect(region(B)).toContain('data-source="system"');
    expect(region(A)).toBe('');
  });
});
