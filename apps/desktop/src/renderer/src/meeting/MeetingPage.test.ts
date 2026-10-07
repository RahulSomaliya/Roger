import { createElement, useState } from 'react';
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

// The page under renderToString, with the real slot files: M3-T9's live transcript and M2-T20a's
// capture status. M4-T20's notes slot and M5-T13's calendar slot are mocked below: they mount
// editors and a calendar banner that read window.roger. Node has no window.roger, so the shell and
// the meeting read are stand-ins, and the transcript shows only the stored lines: its subscription
// to main's events is an effect, which renderToString never runs.
const fakes = vi.hoisted(() => ({
  shell: null as Shell | null,
  /**
   * Shells the page sees after `shell`, one per useShell call, the last one kept: a render that
   * sets the page's own state renders it again at once, so a test can show it a change.
   */
  later: [] as Shell[],
  read: null as Read<StoredMeeting | null> | null,
  /** A meeting's own read, where a test gives one; any other meeting reads `read`. */
  readOf: new Map<string, Read<StoredMeeting | null>>(),
  /** What each render passed to useMeeting: the meeting and the key that makes it read again. */
  reads: [] as { meetingId: string; refreshKey: string }[],
}));
// M4-T20's notes and chat need `window.roger`, which Node lacks, and the page's frame is what is
// checked here: with nothing mounted in the notes and chat regions the page shows the transcript
// alone. The real regions are checked in the browser (e2e/m4-t20.qa.e2e.ts). Likewise M5's notice
// banner (its store reads `window.roger`): e2e/m5-t13.qa.e2e.ts and slots/m5-calendar.test.ts.
vi.mock('../app/slots/m4-notes', () => ({ contributions: {} }));
vi.mock('../app/slots/m5-calendar', () => ({ contributions: {} }));
vi.mock('../app/ShellContext', () => ({
  useShell: () => {
    if (fakes.shell === null) throw new Error('set fakes.shell first');
    const now = fakes.shell;
    fakes.shell = fakes.later.shift() ?? now;
    return now;
  },
}));
vi.mock('./useMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof UseMeeting>()),
  useMeeting: (meetingId: string, refreshKey: string) => {
    fakes.reads.push({ meetingId, refreshKey });
    const answer = fakes.readOf.get(meetingId) ?? fakes.read;
    if (answer === null) throw new Error('set fakes.read first');
    return answer;
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
  busy?: boolean;
}): Shell {
  return {
    route: { name: 'meeting', meetingId: A },
    navigate: vi.fn(),
    capture: {
      status: fields.status ?? null,
      // The meeting main named last is the one the shell points at (captureMeeting).
      lastMeetingId: fields.captureMeeting?.id ?? null,
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

const LIVE = { id: A, startedAt: '2026-10-06T09:00:00.000Z' };

/** The live transcript panel (transcript/LiveTranscript.tsx), mounted in the transcript region. */
const PANEL = /<div[^>]*class="live-transcript-lines"[^>]*role="log"[^>]*aria-label="Transcript"/;

/** The text content of the rendered page, tags and React's comment markers removed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '');

/**
 * One page whose route changes from meeting A to B while it stays mounted. renderToString cannot
 * give a mounted page new props, so the page runs as this component's body and the route changes
 * during its render: React keeps the page's state through that, as it would for one MeetingPage
 * whose meetingId changes.
 */
function RouteFromAToB() {
  const [meetingId, setMeetingId] = useState(A);
  const shown = MeetingPage({ meetingId });
  if (meetingId === A) setMeetingId(B);
  return shown;
}

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
  fakes.later = [];
  fakes.read = read(undefined);
  fakes.readOf = new Map();
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

  it('shows Stop and the capture status line while the meeting records, and no recording pill', () => {
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
    });
    fakes.read = read(stored(A, []));
    const html = page();
    expect(text(html)).toContain('Started');
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*data-variant="primary"[^>]*>Stop<\/button>/);
    // The status line (a slot) sits in the header; it holds its line while recording.
    expect(html).toMatch(
      /<header class="meeting-header" data-recording="">.*class="meeting-status"/,
    );
    expect(html).toContain('aria-label="Capture status"');
    // The words "Recording" are the status line's now: the pill beside Stop is deleted.
    expect(html).not.toContain('meeting-phase');
  });

  it('shows Stopping… as busy, not disabled, while a stop is under way', () => {
    // Busy keeps its colour and is aria-disabled; `disabled` would read as "you cannot".
    fakes.shell = shell({
      status: recording(A),
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
      busy: true,
    });
    fakes.read = read(stored(A, []));
    const html = page();
    expect(html).toMatch(
      /<button[^>]*data-variant="primary"[^>]*aria-disabled="true"[^>]*>Stopping…<\/button>/,
    );
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });

  it('offers Details for a meeting this Mac holds, and keeps its content unmounted until opened', () => {
    fakes.read = read(stored(A, []));
    const html = page();
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Details<\/button>/);
    // A closed dialog mounts no children: the capture report reads nothing until someone opens it.
    expect(html).toMatch(/<dialog[^>]*class="dialog"[^>]*><\/dialog>/);
  });

  it('has no Details, and no primary, for a meeting this Mac does not hold', () => {
    fakes.read = read(null);
    const html = page();
    expect(html).not.toContain('>Details<');
    expect(html).not.toContain('data-variant="primary"');
  });

  it('has no primary for a past meeting while another one records', () => {
    // Stop belongs to the live meeting's own page (docs/design.md, the one primary per moment).
    fakes.shell = shell({
      status: recording(B),
      captureMeeting: { id: B, startedAt: '2026-10-06T10:00:00.000Z' },
    });
    fakes.read = read(stored(A, []));
    expect(page(A)).not.toContain('data-variant="primary"');
  });

  it('shows the lines in the live transcript panel, which follows while the meeting records', () => {
    // The panel adds the lines main sends it to these stored ones itself (useLiveTranscript).
    fakes.shell = shell({ status: recording(A), captureMeeting: LIVE });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Stored before this page opened')]));
    const html = page();
    expect(html).toMatch(PANEL);
    expect(html).toMatch(/<p [^>]*data-segment-id="l1"[^>]*>.*Stored before this page opened/);
    // Following live from the start: nothing to jump back to.
    expect(html).not.toContain('Jump to live');
  });

  it('shows no Stop after Stop, and no recording mark on the header', () => {
    // The meter main keeps after Stop is Details' content now (the Details dialog, R3), not the page's.
    fakes.shell = shell({
      status: { ...IDLE, meter: METER },
      captureMeeting: { id: A, startedAt: '2026-10-06T09:00:00.000Z' },
    });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Done for today')]));
    const html = page();
    expect(html).not.toContain('>Stop<');
    expect(html).not.toContain('data-recording');
  });

  it('keeps showing meeting A while meeting B starts, never the M1 placeholder', () => {
    // Start notes on A's page: main names B before start() resolves and the shell opens B's page,
    // so for a moment the route is A while the capture view already describes B.
    fakes.shell = shell({
      status: recording(B),
      captureMeeting: { id: B, startedAt: '2026-10-06T10:00:00.000Z' },
    });
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'A line of meeting A')]));
    const html = page(A);
    expect(html).toMatch(/<h1[^>]*>Daily standup<\/h1>/);
    expect(text(html)).toContain('A line of meeting A');
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
    expect(html).not.toMatch(PANEL);
  });

  it('keeps the live transcript of a meeting main has not stored yet', () => {
    fakes.shell = shell({ status: recording(A), captureMeeting: LIVE });
    fakes.read = read(null);
    const html = page();
    expect(text(html)).not.toContain('This meeting is not on this Mac');
    expect(html).toMatch(PANEL);
    // The empty live transcript says nothing (no "Listening" line): its log is what is mounted.
    expect(html).toContain('aria-label="Transcript"');
  });

  it('shows the transcript alone, with no tab row, while nothing else is mounted', () => {
    // The notes and chat mount from M4-T20's slot file, mocked here: no tab opens onto nothing,
    // and a row of one tab is not drawn.
    fakes.read = read(stored(A, [line(A, 'l1', 2100, 'Only the transcript')]));
    const html = page();
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).toMatch(PANEL);
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
    // A past meeting opened from the sidebar, main not answered yet; also the meeting this window
    // recorded last, opened again after Stop: a new page has heard none of its lines.
    for (const opened of [shell({ status: IDLE }), shell({ status: IDLE, captureMeeting: LIVE })]) {
      fakes.shell = opened;
      const html = page();
      expect(text(html)).not.toContain('Nothing was transcribed');
      expect(html).not.toMatch(PANEL);
    }
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
    expect(text(html)).not.toContain('Nothing was transcribed');
    expect(html).not.toMatch(PANEL);
  });

  it('keeps the transcript it showed while recording when no read has answered by Stop', () => {
    // The panel holds the lines it heard live; taking it away until a read answers would drop
    // them, and a read that keeps failing would leave the page without them for good. Seen as
    // two renders of one page: recording, then after Stop with every read failed.
    fakes.shell = shell({ status: recording(A), captureMeeting: LIVE });
    fakes.later = [shell({ status: { ...IDLE, meter: METER }, captureMeeting: LIVE })];
    fakes.read = read(undefined, 'Roger could not read this meeting on this Mac: disk I/O error');
    const html = page();
    // The page's own last render is the one after Stop: no Stop button.
    expect(html).not.toContain('>Stop<');
    expect(html).toMatch(PANEL);
    expect(text(html)).not.toContain('The transcript shows here once');
    expect(html).toMatch(/role="alert"[^>]*>.*disk I\/O error/);
  });

  it("shows no transcript for B before B's read answers, after A's on the same page", () => {
    // AppLayout keys <main> by route, so each meeting gets a new page today; the page must not
    // rely on it. Meeting A's regions were shown; B is not recording and main has not answered.
    fakes.readOf = new Map([
      [A, read(stored(A, [line(A, 'l1', 2100, 'A line of meeting A')]))],
      [B, read(undefined)],
    ]);
    const html = renderToString(createElement(RouteFromAToB));
    expect(fakes.reads.map((each) => each.meetingId)).toContain(B);
    expect(html).toMatch(/<h1[^>]*>Loading…<\/h1>/);
    expect(text(html)).not.toContain('Nothing was transcribed');
    expect(html).not.toMatch(PANEL);
  });

  it('shows the transcript of a meeting recording now before the first read answers', () => {
    fakes.shell = shell({ status: recording(A), captureMeeting: LIVE });
    expect(page()).toContain('aria-label="Transcript"');
  });
});
