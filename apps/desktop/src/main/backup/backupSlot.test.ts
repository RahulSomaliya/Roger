import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureReport } from '../../shared/capture';
import { IpcChannel, PCM_SAMPLE_RATE } from '../../shared/ipc';
import { ApiClient } from '../api/ApiClient';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { SenderEvent } from '../ipc/trust';
import type { QuitHook } from '../lifecycle';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { meetingAudioDir } from './audioPaths';

// As in createCaptureRuntime.test.ts: ipc.ts asks Electron's desktopCapturer for the screen source
// and the M2-T10 slot looks for the helper under `app.getAppPath()`, a folder with no helper, so no
// test here runs one (a real tap would raise a privacy prompt).
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  app: { isPackaged: false, getAppPath: () => '/nonexistent/roger-app', on: vi.fn() },
  // createCaptureRuntime's M2-T6 slot asks this every second while a recording runs. Left out,
  // each poll logs "network check failed" (the mock has no `net`) and the test still passes.
  net: { isOnline: () => true },
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const SENDER: SenderEvent = { sender: { id: 7 } };

describe('the M2-T15 slot of createCaptureRuntime', () => {
  let userData = '';
  let quitHooks: QuitHook[] = [];

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-backup-slot-'));
  });

  afterEach(async () => {
    // Stops an afconvert the compressor may have started on this test's WAVs before they go.
    for (const hook of quitHooks) await hook.run();
    rmSync(userData, { recursive: true, force: true });
  });

  it("keeps a recording's audio under userData/audio, and answers the report and delete-audio", async () => {
    const store = new InMemoryTranscriptStore();
    const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
    const api = new ApiClient(connection);
    const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
    const runtime = createCaptureRuntime({
      // The fake provider: Start asks the API for no token.
      config: { ...loadConfig({}), sttProviderOverride: 'fake' },
      store,
      api,
      apiConnection: connection,
      uploader: new TranscriptUploader({ store, api, logger }),
      createSpeechToText: () => new FakeSpeechToText(),
      ensureMicrophoneAccess: () => Promise.resolve('granted'),
      startupError: null,
      userData,
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
        on: () => undefined,
      },
      getWindow: () => ({ webContents: { id: 7, send: vi.fn() }, isDestroyed: () => false }),
      logger,
    });
    quitHooks = runtime.quitHooks;
    const { capture } = runtime;
    const ask = async (channel: string, meetingId: string): Promise<CaptureReport> =>
      (await handlers.get(channel)?.(SENDER, { meetingId })) as CaptureReport;

    const meetingId = (await capture.start()).meetingId ?? '';
    const silence = new Uint8Array((PCM_SAMPLE_RATE / 10) * 2);
    // Capture times as M2-T12's renderer sends them: one second of contiguous audio, one file.
    const capturedFrom = Date.now();
    for (let chunk = 0; chunk < 10; chunk += 1) {
      capture.pushAudio('mic', silence, capturedFrom + chunk * 100);
    }
    expect(capture.getStatus().backup?.state).toBe('writing');
    await capture.stop({ flushUploads: false });

    const report = await ask(IpcChannel.CaptureGetReport, meetingId);
    expect(report.backup).toMatchObject({ state: 'kept', keptForRerun: false });
    expect(report.backup.bytes).toBeGreaterThan(0);
    // Read from the store, not the folder: on a Mac the real afconvert may be encoding it now.
    expect(store.listAudioFiles(meetingId)).toHaveLength(1);
    expect(existsSync(meetingAudioDir(userData, meetingId))).toBe(true);

    const afterDelete = await ask(IpcChannel.AudioDeleteMeeting, meetingId);
    expect(afterDelete.backup.state).toBe('deleted');
    expect(existsSync(meetingAudioDir(userData, meetingId))).toBe(false);
    expect(quitHooks.map((hook) => hook.name)).toContain('stop the audio backup');
  });
});
