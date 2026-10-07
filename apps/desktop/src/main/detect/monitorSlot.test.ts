import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/ApiClient';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { QuitHook } from '../lifecycle';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';

// Never a test without ROGER_E2E=1 here: an unpackaged build then looks for the REAL roger-audio
// under this folder, which `make native` builds, and would run the real monitor.
// `apps/desktop`, where an unpackaged build looks for the fake helper (native/helperPath.ts):
// under ROGER_E2E=1 it is test/fixtures/fake-roger-audio.mjs, never the real roger-audio.
const APP_PATH = fileURLToPath(new URL('../../..', import.meta.url));

vi.mock('electron', async () =>
  (await import('../testing/electronRuntimeMock')).electronRuntimeMock({
    app: {
      isPackaged: false,
      getAppPath: () => APP_PATH,
      getAppMetrics: () => [],
      on: vi.fn(),
    },
  }),
);

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('the M2-T17a slot of createCaptureRuntime', () => {
  let quitHooks: QuitHook[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Stops the fake monitor this test started.
    for (const hook of quitHooks) await hook.run();
    quitHooks = [];
  });

  it("runs the monitor with Roger and puts the Mac's route and mic device in the status", async () => {
    vi.stubEnv('ROGER_E2E', '1');
    const store = new InMemoryTranscriptStore();
    const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
    const api = new ApiClient(connection);
    const runtime = createCaptureRuntime({
      // Electron's call audio path: the tap's helper (and its signing check) is not under test.
      config: {
        ...loadConfig({}, { capture: { audioBackup: false, systemAudioCapture: 'electron' } }),
        sttProviderOverride: 'fake',
      },
      store,
      api,
      apiConnection: connection,
      uploader: new TranscriptUploader({ store, api, logger }),
      createSpeechToText: () => new FakeSpeechToText(),
      ensureMicrophoneAccess: () => Promise.resolve('granted'),
      startupError: null,
      userData: '/nonexistent/roger-test',
      ipcMain: { handle: () => undefined, on: () => undefined },
      getWindow: () => null,
      logger,
    });
    quitHooks = runtime.quitHooks;

    // Before the fake helper says anything: no route, no device (a status never guesses one).
    expect(runtime.capture.getStatus().route ?? null).toBeNull();

    await vi.waitFor(
      () => {
        expect(runtime.capture.getStatus().route).toEqual({
          output: 'speakers',
          outputDevice: 'Fake Speakers',
          inputDevice: 'Fake Microphone',
        });
      },
      { timeout: 5_000 },
    );
    expect(runtime.capture.getStatus().sources.mic.device).toBe('Fake Microphone');
    expect(runtime.quitHooks.map((hook) => hook.name)).toContain('stop the call app monitor');
  });
});
