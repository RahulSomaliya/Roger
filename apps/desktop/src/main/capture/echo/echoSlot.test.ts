import { describe, expect, it, vi, type Mock } from 'vitest';
import type { CaptureReport } from '../../../shared/capture';
import { IpcChannel, PCM_SAMPLE_RATE } from '../../../shared/ipc';
import type { AudioSource, TranscriptSegment } from '../../../shared/transcript';
import { ApiClient, type MeetingDto, type UploadApi } from '../../api/ApiClient';
import { loadConfig } from '../../config';
import type { SenderEvent } from '../../ipc/trust';
import { createLogger } from '../../logger';
import { InMemoryTranscriptStore } from '../../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../../upload/TranscriptUploader';
import { createCaptureRuntime } from '../createCaptureRuntime';

// As in createCaptureRuntime.test.ts, whose stand-ins every test that builds the runtime copies:
// ipc.ts asks desktopCapturer for the screen source, the M2-T10 slot looks for the helper under
// `app.getAppPath()` (a folder with none, so no test here runs a helper and no tap is built), the
// M2-T6 slot polls net.isOnline() while recording, and a focused window keeps M2-T11's Notifier
// from posting.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  app: { isPackaged: false, getAppPath: () => '/nonexistent/roger-app', on: vi.fn() },
  net: { isOnline: () => true },
  BrowserWindow: { getFocusedWindow: () => ({ webContents: { id: 7 } }) },
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const SENDER: SenderEvent = { sender: { id: 7 } };
const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';

/** 100 ms of loud, steady audio: the fake STT writes the same line for it on either side. */
const VOICE = new Uint8Array(new Int16Array(PCM_SAMPLE_RATE / 10).fill(8_000).buffer);

function fakeUploadApi(): {
  createMeeting: Mock<UploadApi['createMeeting']>;
  appendSegments: Mock<UploadApi['appendSegments']>;
  endMeeting: Mock<UploadApi['endMeeting']>;
} {
  const meeting = (id: string): MeetingDto => ({
    id,
    workspace_id: 'w1',
    title: 'Weekly sync',
    status: 'recording',
    started_at: '2026-10-07T09:00:00.000Z',
    ended_at: null,
    segment_count: 0,
    start_source: 'manual',
    calendar_event: null,
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: '2026-10-07T09:00:00.000Z',
  });
  return {
    createMeeting: vi.fn<UploadApi['createMeeting']>((input) => Promise.resolve(meeting(input.id))),
    appendSegments: vi.fn<UploadApi['appendSegments']>((_meetingId, segments) =>
      Promise.resolve({ accepted: segments.length, duplicates: 0 }),
    ),
    endMeeting: vi.fn<UploadApi['endMeeting']>((meetingId) => Promise.resolve(meeting(meetingId))),
  };
}

function runtimeHarness(options: { echoFilter?: boolean; store?: InMemoryTranscriptStore } = {}) {
  const store = options.store ?? new InMemoryTranscriptStore();
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
  const uploadApi = fakeUploadApi();
  // Built before the runtime, as index.ts builds it: its launchedAt precedes every line of this run.
  const uploader = new TranscriptUploader({ store, api: uploadApi, logger });
  const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
  const send = vi.fn<(channel: string, payload: unknown) => void>();
  const runtime = createCaptureRuntime({
    // The fake provider (Start asks the API for no token); no backup, which is not under test.
    config: {
      ...loadConfig(
        {},
        { capture: { audioBackup: false, echoFilter: options.echoFilter ?? true } },
      ),
      sttProviderOverride: 'fake',
    },
    store,
    api: new ApiClient(connection),
    apiConnection: connection,
    uploader,
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    startupError: null,
    userData: '/nonexistent/roger-test',
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      on: () => undefined,
    },
    getWindow: () => ({ webContents: { id: 7, send }, isDestroyed: () => false }),
    logger,
  });
  return {
    store,
    uploader,
    uploadApi,
    capture: runtime.capture,
    ask: (channel: string, payload: unknown): unknown => handlers.get(channel)?.(SENDER, payload),
    /** What main told the window of echo changes. */
    segmentChanges: (): unknown[] =>
      send.mock.calls
        .filter(([channel]) => channel === IpcChannel.TranscriptSegmentChanged)
        .map(([, change]) => change),
  };
}

/** Two seconds of the same audio on both sides, captured at the same instant: one line each. */
function bothSidesSay(capture: ReturnType<typeof runtimeHarness>['capture']): void {
  const from = Date.now();
  for (const source of ['system', 'mic'] as const) {
    for (let chunk = 0; chunk < 20; chunk += 1)
      capture.pushAudio(source, VOICE, from + chunk * 100);
  }
}

function onlyLine(
  store: InMemoryTranscriptStore,
  meetingId: string,
  source: AudioSource,
): TranscriptSegment & { suppressedReason: string | null; uploadAfter: string | null } {
  const lines = store.listSegmentsOverlapping(meetingId, source, 0, Number.MAX_SAFE_INTEGER);
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe('the M2-T14b slot of createCaptureRuntime', () => {
  it('hides a mic line that repeats call audio, tells the window and counts it, and shows it again', async () => {
    const { store, capture, ask, segmentChanges } = runtimeHarness();
    const meetingId = (await capture.start()).meetingId ?? '';

    bothSidesSay(capture);

    const them = onlyLine(store, meetingId, 'system');
    const me = onlyLine(store, meetingId, 'mic');
    expect(me.suppressedReason).toBe('echo');
    expect(segmentChanges()).toEqual([
      {
        meetingId,
        segmentId: me.id,
        source: 'mic',
        change: 'hidden',
        reason: 'echo',
        echoOf: them.id,
        text: me.text,
      },
    ]);
    expect(capture.getStatus().echo).toEqual({ hidden: 1, trimmed: 0, held: 0 });
    const report = ask(IpcChannel.CaptureGetReport, { meetingId }) as CaptureReport;
    expect(report.echo).toEqual({ hidden: 1, trimmed: 0, held: 0 });

    ask(IpcChannel.TranscriptUnhideSegment, { meetingId, segmentId: me.id });

    expect(store.getSegment(me.id)?.suppressedReason).toBeNull();
    expect(segmentChanges().at(-1)).toMatchObject({ segmentId: me.id, change: 'unhidden' });
    expect(capture.getStatus().echo).toEqual({ hidden: 0, trimmed: 0, held: 0 });

    await capture.stop({ flushUploads: false });
    // Idle: the status names no meeting, so it carries no echo counts.
    expect(capture.getStatus().echo).toBeUndefined();
  });

  it('hides and holds nothing with echoFilter false in config.json (the smoke run)', async () => {
    const { store, capture, segmentChanges } = runtimeHarness({ echoFilter: false });
    const meetingId = (await capture.start()).meetingId ?? '';

    bothSidesSay(capture);

    expect(onlyLine(store, meetingId, 'mic')).toMatchObject({
      suppressedReason: null,
      uploadAfter: null,
    });
    expect(segmentChanges()).toEqual([]);
    await capture.stop({ flushUploads: false });
  });

  it("settles the holds an earlier run left before the uploader's first upload", async () => {
    const store = new InMemoryTranscriptStore();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    store.createMeeting({ id: MEETING, title: 'Weekly sync', startedAt: earlier });
    const said = (id: string, source: AudioSource, startMs: number): TranscriptSegment => ({
      id,
      meetingId: MEETING,
      source,
      speaker: source === 'mic' ? 'me' : 'them',
      startMs,
      endMs: startMs + 2_000,
      text: 'so the plan is to ship on Friday',
      confidence: null,
      words: null,
      createdAt: earlier,
    });
    store.appendSegment(said('them-1', 'system', 10_000));
    store.appendSegment(said('me-1', 'mic', 10_100));
    store.holdSegment('me-1', new Date(Date.now() + 60_000).toISOString());
    store.markMeetingEnded(MEETING, earlier);

    const { uploader, uploadApi } = runtimeHarness({ store });
    await uploader.flush();

    expect(store.getSegment('me-1')?.suppressedReason).toBe('echo');
    expect(
      uploadApi.appendSegments.mock.calls.flatMap(([, lines]) => lines.map((l) => l.id)),
    ).toEqual(['them-1']);
    // Nothing is held any more, so the meeting's end went up too.
    expect(uploadApi.endMeeting).toHaveBeenCalledTimes(1);
  });
});
