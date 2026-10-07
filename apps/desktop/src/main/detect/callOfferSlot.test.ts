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
// under this folder, which `make native` builds, and would run the real monitor (monitorSlot.test.ts).
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

function build(capture: { callDetection?: boolean }) {
  const store = new InMemoryTranscriptStore();
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
  const api = new ApiClient(connection);
  return createCaptureRuntime({
    config: {
      ...loadConfig(
        {},
        { capture: { audioBackup: false, systemAudioCapture: 'electron', ...capture } },
      ),
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
}

describe('the M2-T17b slot of createCaptureRuntime', () => {
  let quitHooks: QuitHook[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Stops the fake monitor this test started.
    for (const hook of quitHooks) await hook.run();
    quitHooks = [];
  });

  it('puts call detection into the status and the quit hooks, and takes its prompt service late', () => {
    vi.stubEnv('ROGER_E2E', '1');
    const runtime = build({});
    quitHooks = runtime.quitHooks;

    // Idle: a status never claims a call (the field exists, null, once the feature is on).
    expect(runtime.capture.getStatus().trigger).toBeNull();
    expect(runtime.quitHooks.map((hook) => hook.name)).toContain('stop call detection');

    const prompts = { offer: vi.fn(), onCallCardDismissed: vi.fn(() => () => undefined) };
    runtime.callOffer.bindPrompts(prompts);
    expect(prompts.onCallCardDismissed).toHaveBeenCalledOnce();
    // One PromptService for the run: index.ts binds it once, and a second bind is a wiring bug.
    expect(() => {
      runtime.callOffer.bindPrompts(prompts);
    }).toThrow(/already/);
  });

  it('returns the call app monitor as callApps, for CrashRecovery', () => {
    vi.stubEnv('ROGER_E2E', '1');
    const runtime = build({});
    quitHooks = runtime.quitHooks;
    expect(runtime.callApps.callApps).toEqual([]);
    expect(typeof runtime.callApps.onCallApps).toBe('function');
  });

  it('adds nothing to the status with the callDetection switch off', () => {
    vi.stubEnv('ROGER_E2E', '1');
    const runtime = build({ callDetection: false });
    quitHooks = runtime.quitHooks;
    expect(runtime.capture.getStatus().trigger).toBeUndefined();
  });
});
