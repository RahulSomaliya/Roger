import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../../shared/capture';
import type { TranscriptSegment } from '../../../../shared/transcript';
import type { MeetingView } from '../../meeting/useMeeting';
import type * as UseMeeting from '../../meeting/useMeeting';
import { VocabularySettings } from '../../settings/VocabularySettings';
import type { LiveTranscriptProps } from '../../transcript/LiveTranscript';
import type { CaptureMeeting } from '../captureMeeting';
import type { Shell } from '../ShellContext';
import { contributions } from './m3-transcript';

// The panel and the page are stand-ins: this checks what the slot hands the panel. The panel
// itself is LiveTranscript.test.ts's; the page with the real slot is MeetingPage.test.ts's.
const fakes = vi.hoisted(() => ({
  shell: null as Shell | null,
  view: null as MeetingView | null,
  /** The props of each LiveTranscript the slot rendered. */
  panels: [] as LiveTranscriptProps[],
}));
vi.mock('../ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));
vi.mock('../../meeting/useMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof UseMeeting>()),
  useMeetingView: () => {
    if (fakes.view === null) throw new Error('set fakes.view first');
    return fakes.view;
  },
}));
vi.mock('../../transcript/LiveTranscript', () => ({
  LiveTranscript: (props: LiveTranscriptProps) => {
    fakes.panels.push(props);
    return null;
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
const STORED: readonly TranscriptSegment[] = [
  {
    id: '4f6c2a1e-8b3d-4e5f-9a7b-1c2d3e4f5a01',
    meetingId: A,
    source: 'system',
    speaker: 'them',
    startMs: 61_000,
    endMs: 63_000,
    text: 'So the main thing is the renewal.',
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-07T09:01:03.000Z',
  },
];

function status(phase: CaptureStatus['phase'], meetingId: string): CaptureStatus {
  return { ...IDLE, phase, meetingId, startedAt: '2026-10-07T09:00:00.000Z' };
}

function shell(capture: CaptureStatus | null, captureMeeting: CaptureMeeting | null): Shell {
  return {
    route: { name: 'meeting', meetingId: A },
    navigate: vi.fn(),
    capture: {
      status: capture,
      lastMeetingId: captureMeeting?.id ?? null,
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

/** The props the transcript slot gives the panel on meeting A's page. */
function panelProps(): LiveTranscriptProps {
  const [entry] = contributions.meetingTranscript ?? [];
  if (entry === undefined) throw new Error('M3-T9 mounts nothing in meetingTranscript');
  fakes.panels = [];
  renderToString(createElement(entry.component, { meetingId: A }));
  const [props] = fakes.panels;
  if (props === undefined) throw new Error('the transcript slot rendered no LiveTranscript');
  return props;
}

beforeEach(() => {
  fakes.shell = shell(IDLE, null);
  fakes.view = {
    meetingId: A,
    meeting: null,
    storedLines: STORED,
    showHidden: false,
    setShowHidden: vi.fn(),
  };
});

describe("M3-T9's transcript slot", () => {
  it("hands the panel the page's meeting, its stored lines and the hidden-lines choice", () => {
    const shown = { ...fakes.view, showHidden: true } as MeetingView;
    fakes.view = shown;
    const props = panelProps();
    expect(props.meetingId).toBe(A);
    expect(props.storedLines).toBe(STORED);
    expect(props.showHidden).toBe(true);
  });

  it('is live only while this meeting records', () => {
    const a = { id: A, startedAt: '2026-10-07T09:00:00.000Z' };
    fakes.shell = shell(status('recording', A), a);
    expect(panelProps().live).toBe(true);
    // After Stop the shell still points at A, and main names no meeting.
    fakes.shell = shell(IDLE, a);
    expect(panelProps().live).toBe(false);
    fakes.shell = shell(status('stopping', A), a);
    expect(panelProps().live).toBe(false);
  });

  it("is not live on a past meeting's page while another meeting records", () => {
    fakes.shell = shell(status('recording', B), { id: B, startedAt: '2026-10-07T10:00:00.000Z' });
    expect(panelProps().live).toBe(false);
  });
});

describe("M3-T9's settings slot", () => {
  it('mounts the jargon list editor as a Settings section', () => {
    expect(contributions.settings).toEqual([
      { id: 'm3-vocabulary', order: 10, component: VocabularySettings },
    ]);
  });
});
