import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/ApiClient';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { QuitHook } from '../lifecycle';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from './TranscriptUploader';

// As in createCaptureRuntime.test.ts: ipc.ts asks Electron's desktopCapturer for the screen source,
// the M2-T10 slot looks for the helper under `app.getAppPath()` (a folder with no helper, so no
// test here runs one), the M2-T6 slot asks net.isOnline() every second while a recording runs, and
// the Notifier posts nothing while the harness window (webContents 7) is focused.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  app: { isPackaged: false, getAppPath: () => '/nonexistent/roger-app', on: vi.fn() },
  net: { isOnline: () => true },
  BrowserWindow: { getFocusedWindow: () => ({ webContents: { id: 7 } }) },
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const EARLIER = '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b';
const QUIT_HOOK = 'stop the speech-to-text usage uploader';

interface SentRequest {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: unknown;
}

/**
 * The API as a fetch stand-in. A usage PUT answers at once; every other request (the transcript
 * uploader's) waits until `release()`, like an API slow to take lines.
 */
function fakeApi() {
  const requests: SentRequest[] = [];
  const held: (() => void)[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      method: init?.method,
      authorization: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    if (url.includes('/v1/stt-usage/')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(
          new Response('{"error":{"code":"internal_error","message":"down"}}', { status: 503 }),
        );
      });
    });
  });
  return {
    fetchImpl,
    usagePuts: () => requests.filter((request) => request.url.includes('/v1/stt-usage/')),
    /** Requests still waiting on the API: the transcript uploader's. */
    held: () => held.length,
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

let quitHooks: QuitHook[] = [];

/**
 * The capture runtime with the fake vendor, and a meeting an earlier run left with a line and its
 * usage not yet uploaded: Stop's transcript flush has a request to make, which the API holds, and
 * the uploader's first pass, 0 ms after the build, has a row to send (`launchPass`).
 */
function build(token: string, store = new InMemoryTranscriptStore()) {
  const api = fakeApi();
  store.createMeeting({ id: EARLIER, title: 'Earlier', startedAt: '2026-10-07T09:00:00.000Z' });
  store.appendSegment({
    id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d',
    meetingId: EARLIER,
    source: 'mic',
    speaker: 'me',
    startMs: 1_000,
    endMs: 2_000,
    text: 'shall we start',
    confidence: 1,
    words: [],
    createdAt: '2026-10-07T09:00:02.000Z',
  });
  store.markMeetingEnded(EARLIER, '2026-10-07T09:30:00.000Z');
  const earlierSource = {
    sessionsOpened: 1,
    connectedMs: 1_800_000,
    audioSentMs: 1_799_000,
    droppedChunks: 0,
    estimatedCostUsd: 0.075,
  };
  store.saveSttUsage({
    meetingId: EARLIER,
    provider: 'assemblyai',
    total: { ...earlierSource, sessionsOpened: 2, connectedMs: 3_600_000, estimatedCostUsd: 0.15 },
    bySource: { mic: earlierSource, system: { ...earlierSource } },
    stopReason: 'quit',
    updatedAt: '2026-10-07T09:30:00.000Z',
  });
  const connection = { baseUrl: 'http://api.test', token, fetchImpl: api.fetchImpl };
  const client = new ApiClient(connection);
  const runtime = createCaptureRuntime({
    // The fake provider: Start asks the API for no token.
    config: { ...loadConfig({}), sttProviderOverride: 'fake' },
    store,
    api: client,
    apiConnection: connection,
    uploader: new TranscriptUploader({ store, api: client, logger }),
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    startupError: null,
    userData: '/nonexistent/roger-test',
    ipcMain: { handle: () => undefined, on: () => undefined },
    getWindow: () => ({ webContents: { id: 7, send: vi.fn() }, isDestroyed: () => false }),
    logger,
  });
  quitHooks = runtime.quitHooks;
  return { capture: runtime.capture, store, api };
}

/**
 * Waits for the uploader's first pass to send the earlier run's row. Start and Stop on the fake
 * vendor resolve in microtasks alone, so a test that went on at once could Stop before that 0 ms
 * pass runs, and the pass would then send Stop's row too: a send the slot never asked for.
 */
async function launchPass(api: ReturnType<typeof fakeApi>): Promise<void> {
  await vi.waitFor(() => {
    expect(api.usagePuts().map((put) => put.url)).toEqual([
      `http://api.test/v1/stt-usage/meetings/${EARLIER}`,
    ]);
  });
}

describe('the M3-T19b slot of createCaptureRuntime', () => {
  afterEach(async () => {
    for (const hook of quitHooks) await hook.run();
    quitHooks = [];
  });

  it("sends the meeting's usage right after Stop, while the transcript upload still waits on the API", async () => {
    const { capture, store, api } = build('test');
    await launchPass(api);
    const meetingId = (await capture.start()).meetingId ?? '';
    let stopped = false;
    const stopping = capture.stop().then(() => {
      stopped = true;
    });

    // The next pass is 30 s away: only the slot's send after Stop can put it out in time.
    await vi.waitFor(() => {
      expect(api.usagePuts()).toHaveLength(2);
      expect(api.held()).toBeGreaterThan(0);
    });
    // The transcript's upload is out and Stop still waits on it: the usage did not.
    expect(stopped).toBe(false);
    expect(api.usagePuts()[1]).toMatchObject({
      url: `http://api.test/v1/stt-usage/meetings/${meetingId}`,
      method: 'PUT',
      authorization: 'Bearer test',
      body: {
        provider: 'fake',
        sessions_opened: 2,
        gated_ms: 0,
        stop_reason: 'user',
        by_source: { mic: { sessions_opened: 1 }, system: { sessions_opened: 1 } },
      },
    });
    await vi.waitFor(() => {
      expect(store.listSttUsageToUpload(10)).toEqual([]);
    });

    api.release();
    await stopping;
    expect(api.usagePuts()).toHaveLength(2);
  });

  it('starts nothing without a token: every request would be refused', async () => {
    const { capture, store, api } = build('');
    const meetingId = (await capture.start()).meetingId ?? '';
    await capture.stop({ flushUploads: false });
    // Past the 0 ms a first pass would have taken.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(api.usagePuts()).toEqual([]);
    // Kept, for the next launch that has a token.
    expect(
      store
        .listSttUsageToUpload(10)
        .map((usage) => usage.meetingId)
        .sort(),
    ).toEqual([EARLIER, meetingId].sort());
  });

  it('leaves a Stop that threw to the next pass: its last totals may not be saved', async () => {
    // A store refusing writes partway through Stop (a full disk, SQLite busy past its timeout).
    class RefusingStore extends InMemoryTranscriptStore {
      override deleteMeetingIfEmpty(): boolean {
        throw new Error('disk I/O error');
      }
    }
    const { capture, store, api } = build('test', new RefusingStore());
    await launchPass(api);
    const meetingId = (await capture.start()).meetingId ?? '';
    await capture.stop({ flushUploads: false });

    expect(capture.getStatus().error).toContain('disk I/O error');
    expect(api.usagePuts()).toHaveLength(1);
    expect(store.listSttUsageToUpload(10).map((usage) => usage.meetingId)).toEqual([meetingId]);
  });

  it('stops at quit: a later Stop sends nothing', async () => {
    const { capture, api } = build('test');
    await launchPass(api);
    const hook = quitHooks.find((candidate) => candidate.name === QUIT_HOOK);
    expect(hook).toBeDefined();
    await hook?.run();

    await capture.start();
    await capture.stop({ flushUploads: false });
    expect(api.usagePuts()).toHaveLength(1);
  });
});
