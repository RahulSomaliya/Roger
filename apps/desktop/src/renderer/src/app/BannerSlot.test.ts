import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import { BannerSlot } from './BannerSlot';
import type { Shell } from './ShellContext';

const fakes = vi.hoisted(() => ({ shell: null as Shell | null }));
vi.mock('./ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));
// The banner slot holds only M2's warnings; M5's calendar mounts read `window.roger`, which Node
// lacks (AppLayout.test.ts does the same).
vi.mock('./slots/m5-calendar', () => ({ contributions: {} }));

const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});

function shell(
  status: CaptureStatus | null,
  extra: { localError?: string | null; actionError?: string | null } = {},
): Shell {
  return {
    route: { name: 'home' },
    navigate: vi.fn(),
    capture: {
      status,
      lastMeetingId: null,
      localError: extra.localError ?? null,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting: null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: extra.actionError ?? null,
  };
}

const banner = (): string => renderToStaticMarkup(createElement(BannerSlot));

beforeEach(() => {
  fakes.shell = shell(IDLE);
});

describe('the banner slot', () => {
  it('draws a capture error as a loud problem line, never a tinted box', () => {
    // "lines not saved on this Mac" arrives here (house rule 1): the person must hear it.
    fakes.shell = shell({ ...IDLE, error: 'Roger could not save lines on this Mac: disk full' });
    const html = banner();
    expect(html).toMatch(/class="problem"[^>]*role="alert"|role="alert"[^>]*class="problem"/);
    expect(html).toContain('Roger could not save lines on this Mac: disk full');
    expect(html).not.toMatch(/class="(?:[^"]* )?error[" ]/);
  });

  it('says a start or stop that failed before main answered, and not twice when main said it too', () => {
    fakes.shell = shell(IDLE, { actionError: 'Roger could not start notes: no microphone' });
    expect(banner()).toContain('Roger could not start notes: no microphone');
    fakes.shell = shell(
      { ...IDLE, error: 'Roger could not start notes: no microphone' },
      { actionError: 'Roger could not start notes: no microphone' },
    );
    expect(banner().match(/no microphone/g)).toHaveLength(1);
  });

  it('draws the stop notice as a quiet status line', () => {
    fakes.shell = shell({ ...IDLE, notice: 'Stopped at 2:32 pm because the Mac went to sleep.' });
    const html = banner();
    expect(html).toContain('role="status"');
    expect(html).toContain('Stopped at 2:32 pm because the Mac went to sleep.');
    expect(html).not.toMatch(/class="(?:[^"]* )?notice[" ]/);
  });

  it('shows no box at all while nothing is wrong', () => {
    expect(banner()).not.toContain('role=');
  });
});
