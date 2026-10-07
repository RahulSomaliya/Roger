import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import type { StoredMeeting } from '../../../shared/meetings';
import type { AudioSource, TranscriptSegment } from '../../../shared/transcript';
import type { CaptureMeeting } from '../app/captureMeeting';
import type { Shell } from '../app/ShellContext';
import { MeetingPage } from './MeetingPage';
import type { Read } from './useMeeting';
import type * as UseMeeting from './useMeeting';

// The page under renderToString, with the real slot files: M4-S4's seeds (M1's StatusPanel and
// TranscriptView) are what it shows until M2-T20a and M3-T9 mount theirs. Node has no
// window.roger, so the shell and the meeting read are stand-ins.
const fakes = vi.hoisted(() => ({
  shell: null as Shell | null,
  read: null as Read<StoredMeeting | null> | null,
  /** What each render passed to useMeeting: the meeting and the key that makes it read again. */
  reads: [] as { meetingId: string; refreshKey: string }[],
}));
vi.mock('../app/ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    return fakes.shell;
  },
}));
vi.mock('./useMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof UseMeeting>()),
  useMeeting: (meetingId: string, refreshKey: string) => {
    if (fakes.read === null) throw new Error('set fakes.read first');
    fakes.reads.push({ meetingId, refreshKey });
    return fakes.read;
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
const METER = {
  vendorName: 'AssemblyAI',
  total: { sessionsOpened: 2, connectedMs: 60_000, audioSentMs: 60_000, estimatedCostUsd: 0.005 },
  sources: {
    mic: { sessionsOpened: 1, connectedMs: 30_000, audioSentMs: 30_000, estimatedCostUsd: 0.0025 },
    system: {
      sessionsOpened: 1,
      connectedMs: 30_000,
      audioSentMs: 30_000,
      estimatedCostUsd: 0.0025,
    },
  },
};

function line(meetingId: string, id: string, startMs: number, text: string): TranscriptSegment {
  const source: AudioSource = 'system';
  return {
    id,
    meetingId,
    source,
    speaker: 'them',
    startMs,
    endMs: startMs + 900,
    text,
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-05T09:30:10.000Z',
  };
}

function stored(meetingId: string, segments: TranscriptSegment[]): StoredMeeting {
  return {
    id: meetingId,
    title: 'Daily standup',
    startedAt: '2026-10-05T09:30:04.000Z',
    endedAt: '2026-10-05T09:33:16.000Z',
    segments,
  };
}

function read(value: StoredMeeting | null | undefined, error: string | null = null) {
  return { value, error, refresh: vi.fn() };
}

function shell(fields: {
  status?: CaptureStatus | null;
  captureMeeting?: CaptureMeeting | null;
  segments?: TranscriptSegment[];
  busy?: boolean;
}): Shell {
  return {
    route: { name: 'meeting', meetingId: A },
    navigate: vi.fn(),
    capture: {
      status: fields.status ?? null,
      // The meeting main named last is the one the shell points at (captureMeeting).
      lastMeetingId: fields.captureMeeting?.id ?? null,
      segments: fields.segments ?? [],
      interim: { mic: null, system: null },
      localError: null,
      busy: fields.busy ?? false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting: fields.captureMeeting ?? null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

function recording(meetingId: string): CaptureStatus {
  return {
    ...IDLE,
    phase: 'recording',
    meetingId,
    startedAt: '2026-10-06T09:00:00.000Z',
    streams: { mic: 'open', system: 'open' },
    meter: METER,
  };
}

const page = (meetingId = A): string => renderToString(createElement(MeetingPage, { meetingId }));

/** The text content of the rendered page, tags and React's comment markers removed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '');

/** The refreshKey the page passes to useMeeting for meeting `meetingId` under `fake`. */
function readKeyFor(fake: Shell, meetingId = A): string {
  fakes.shell = fake;
  fakes.reads = [];
  page(meetingId);
  const [first] = fakes.reads;
  if (first === undefined) throw new Error('the page never read its meeting');
  expect(first.meetingId).toBe(meetingId);
  return first.refreshKey;
}

beforeEach(() => {
  fakes.shell = shell({});
  fakes.read = read(undefined);
  fakes.reads = [];
});

describe('the meeting page', () => {
  it('shows a stored meeting: its title, when it ran and its lines', () => {
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Morning! Can everyone hear me?')]));
    const html = page();
    expect(html).toMatch(/<h1[^>]*>Daily standup<\/h1>/);
    expect(text(html)).toContain('Morning! Can everyone hear me?');
    expect(html).not.toContain('>Stop<');
    // A meeting Roger is not recording has no capture status of its own.
    expect(html).not.toContain('aria-label="Capture status"');
  });

  it('shows the recording state, Stop and the capture status while the meeting records', () => {
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
    });
    fakes.read = read(stored(A, []));
    const html = page();
    expect(text(html)).toContain('Recording');
    expect(html).toMatch(/<button[^>]*class="button stop"[^>]*>Stop<\/button>/);
    expect(html).toContain('aria-label="Capture status"');
    expect(text(html)).toContain('Speech-to-text');

    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
      busy: true,
    });
    expect(page()).toMatch(/<button[^>]*disabled=""[^>]*>Stop<\/button>/);
  });

  it('adds the lines that arrived live to the stored ones, each once', () => {
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
      segments: [line(A, 'l1', 2100, 'Stored and live'), line(A, 'l2', 4000, 'Only live so far')],
    });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Stored and live')]));
    const shown = text(page());
    expect(shown.match(/Stored and live/g)).toHaveLength(1);
    expect(shown).toContain('Only live so far');
  });

  it("keeps the last recording's meter after Stop, the cost the owner asked to see", () => {
    fakes.shell = shell({
      status: { ...IDLE, meter: METER },
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
    });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Done for today')]));
    const html = page();
    expect(text(html)).toContain('Last recording');
    expect(html).not.toContain('>Stop<');
  });

  it('keeps showing meeting A while meeting B starts, never the M1 placeholder', () => {
    // New note on A's page: main names B before start() resolves and the shell opens B's page,
    // so for a moment the route is A while the capture view already describes B.
    fakes.shell = shell({
      status: recording(B),
      captureMeeting: { id: B, startedAt: '2026-10-06T10:00:00.000Z' },
      segments: [line(B, 'b1', 500, 'First line of the next call')],
    });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'A line of meeting A')]));
    const html = page(A);
    expect(html).toMatch(/<h1[^>]*>Daily standup<\/h1>/);
    expect(text(html)).toContain('A line of meeting A');
    expect(text(html)).not.toContain('First line of the next call');
    expect(text(html)).not.toContain('can show only the meeting it recorded last');
    expect(html).not.toContain('aria-label="Capture status"');
    expect(html).not.toContain('>Stop<');
  });

  it('says why a read failed, with Try again, and keeps what it read before', () => {
    fakes.read = read(
      stored(A, [line(A, 'l1', 2100, 'Still here')]),
      'Roger could not read this meeting on this Mac: database is locked',
    );
    const html = page();
    expect(html).toMatch(
      /role="alert"[^>]*>.*Roger could not read this meeting on this Mac: database is locked/,
    );
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(text(html)).toContain('Still here');
  });

  it('says this Mac has no such meeting once main answers that', () => {
    fakes.read = read(null);
    const html = page();
    expect(text(html)).toContain('This meeting is not on this Mac');
    expect(html).not.toContain('class="transcript"');
  });

  it('keeps the live transcript of a meeting main has not stored yet', () => {
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
      segments: [line(A, 'l1', 2100, 'Live before the store answers')],
    });
    fakes.read = read(null);
    const html = page();
    expect(text(html)).not.toContain('This meeting is not on this Mac');
    expect(text(html)).toContain('Live before the store answers');
  });

  it('shows the transcript alone, with no pane buttons, while nothing else is mounted', () => {
    // The notes and chat mount in M4-T20 (wave 6): until then no button opens an empty pane.
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Only the transcript')]));
    const html = page();
    expect(html).toContain('data-layout="single"');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('role="tablist"');
  });

  it("reads again when this meeting's recording starts or stops, never for another's", () => {
    // After Stop the store has every line the page saw live, or no meeting when nobody spoke.
    const live = { id: A, startedAt: '2026-10-06T09:00:00.000Z' };
    const idle = readKeyFor(shell({ status: IDLE }));
    const recordingA = readKeyFor(shell({ status: recording(A), captureMeeting: live }));
    expect(recordingA).not.toBe(idle);
    expect(readKeyFor(shell({ status: { ...IDLE, meter: METER }, captureMeeting: live }))).toBe(
      idle,
    );
    // Main's idle heartbeat (a new status every 2 s) reads nothing again.
    expect(readKeyFor(shell({ status: { ...IDLE, upload: { ...IDLE.upload, pending: 2 } } }))).toBe(
      idle,
    );
    // While B records, A's page has nothing new to read.
    const b = { id: B, startedAt: '2026-10-06T10:00:00.000Z' };
    expect(readKeyFor(shell({ status: recording(B), captureMeeting: b }), A)).toBe(idle);
  });

  it('names no meeting while the first read runs, rather than a wrong title', () => {
    const html = page();
    expect(html).toMatch(/<h1[^>]*>Loading…<\/h1>/);
  });

  it('shows no transcript before the first read answers: it knows no lines to call missing', () => {
    // Roger restarted, a past meeting opened from the sidebar: no live lines, main not answered.
    fakes.shell = shell({ status: IDLE, segments: [line(B, 'b1', 500, 'Another meeting')] });
    const html = page();
    expect(text(html)).not.toContain('No lines were saved');
    expect(html).not.toContain('class="transcript"');
  });

  it('says it could not read the meeting when the first read fails, never a made-up title', () => {
    fakes.read = read(
      undefined,
      'Roger could not read this meeting on this Mac: database is locked',
    );
    const html = page();
    expect(html).toMatch(/<h1[^>]*>Could not read this meeting<\/h1>/);
    expect(text(html)).not.toContain('Untitled meeting');
    expect(html).toMatch(/role="alert"[^>]*>.*database is locked/);
    expect(text(html)).toContain('The transcript shows here once Roger can read this meeting.');
    expect(text(html)).not.toContain('No lines were saved');
    expect(html).not.toContain('class="transcript"');
  });

  it('keeps the lines this window heard live when the first read fails', () => {
    fakes.shell = shell({
      status: { ...IDLE, meter: METER },
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
      segments: [line(A, 'l1', 2100, 'Heard live before Stop')],
    });
    fakes.read = read(undefined, 'Roger could not read this meeting on this Mac: disk I/O error');
    const html = page();
    expect(text(html)).toContain('Heard live before Stop');
    expect(text(html)).not.toContain('The transcript shows here once');
  });

  it('shows the transcript of a meeting recording now before the first read answers', () => {
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
    });
    expect(text(page())).toContain('Lines appear here as people speak.');
  });
});
