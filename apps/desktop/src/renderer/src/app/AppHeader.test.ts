import { createElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { idleCaptureStatus, type CaptureStatus } from '../../../shared/capture';
import { AppHeader, RecordingChip } from './AppHeader';
import { HOME, type Route } from './router';
import type { Shell } from './ShellContext';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const STARTED = '2026-10-07T09:00:00.000Z';
const NOON = Date.parse('2026-10-07T09:12:30.000Z');

const fakes = vi.hoisted(() => ({ shell: null as Shell | null }));
vi.mock('./ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));

const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});

function shellAt(route: Route, status: CaptureStatus | null = IDLE): Shell {
  const live = status?.meetingId === MEETING;
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
    captureMeeting: live ? { id: MEETING, startedAt: STARTED } : null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

function recording(phase: 'recording' | 'stopping' = 'recording'): CaptureStatus {
  return { ...IDLE, phase, meetingId: MEETING, startedAt: STARTED };
}

function header(route: Route, status?: CaptureStatus | null): string {
  fakes.shell = shellAt(route, status);
  return renderToString(createElement(AppHeader));
}

describe('RecordingChip', () => {
  const chip = (fields: Partial<Parameters<typeof RecordingChip>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(RecordingChip, {
        phase: 'recording',
        startedAt: STARTED,
        nowMs: NOON,
        onOpen: vi.fn(),
        ...fields,
      }),
    );

  it('says Recording and the whole minutes, with a name that spells it out', () => {
    const html = chip();
    expect(html).toContain('aria-label="Recording, 12 minutes"');
    expect(html).toContain('<span>Recording</span>');
    expect(html).toContain('>12m<');
  });

  it('shows no time before main reports the start', () => {
    const html = chip({ startedAt: null });
    expect(html).toContain('aria-label="Recording"');
    expect(html).not.toMatch(/\d+m</);
  });

  it('says Stopping while the recording ends, with no time', () => {
    const html = chip({ phase: 'stopping' });
    expect(html).toContain('aria-label="Stopping…"');
    expect(html).not.toMatch(/\d+m</);
  });
});

describe('AppHeader', () => {
  it('names Roger and Settings, and shows no chip when nothing records', () => {
    const html = header(HOME);
    expect(html).toContain('>Roger</button>');
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain('recording-chip');
  });

  it('shows the chip on Home and Settings while a call records', () => {
    expect(header(HOME, recording())).toContain('recording-chip');
    expect(header({ name: 'settings' }, recording())).toContain('recording-chip');
  });

  it('keeps the chip off the live meeting’s own page, and shows it on another meeting', () => {
    expect(header({ name: 'meeting', meetingId: MEETING }, recording())).not.toContain(
      'recording-chip',
    );
    const other = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
    expect(header({ name: 'meeting', meetingId: other }, recording())).toContain('recording-chip');
  });

  it('marks the page it is on', () => {
    expect(header(HOME)).toMatch(/aria-current="page"[^>]*>Roger</);
    expect(header({ name: 'settings' })).toMatch(/aria-label="Settings" aria-current="page"/);
  });
});
