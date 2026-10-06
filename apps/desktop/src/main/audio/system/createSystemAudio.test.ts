import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import type { CaptureStatus } from '../../../shared/capture';
import { ApiClient } from '../../api/ApiClient';
import { CaptureService } from '../../capture/CaptureService';
import type { SystemAudioCaptureSetting } from '../../config';
import { createLogger } from '../../logger';
import { FAKE_HELPER_PATH, type HelperPathContext } from '../../native/helperPath';
import type { SigningIdentity } from '../../signing';
import { InMemoryTranscriptStore } from '../../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../../upload/TranscriptUploader';
import { createSystemAudio, type SystemAudioDeps } from './createSystemAudio';

const FAKE_HELPER = fileURLToPath(
  new URL('../../../../test/fixtures/fake-roger-audio.mjs', import.meta.url),
);
const IDENTITY: SigningIdentity = {
  kind: 'local-identity',
  requirement: 'identifier "ai.linkt.roger" and certificate leaf = H"b457"',
  requirementHash: 'd'.repeat(64),
};

/**
 * An app folder of its own holding only the fake helper. Never the real apps/desktop: on a Mac
 * that ran `make check`, its native/bin/roger-audio exists, and a test that picked it would build
 * a real tap (a privacy prompt for whatever runs the tests).
 */
function appWithFakeHelper(): string {
  const appPath = mkdtempSync(join(tmpdir(), 'roger-app-'));
  mkdirSync(dirname(join(appPath, FAKE_HELPER_PATH)), { recursive: true });
  copyFileSync(FAKE_HELPER, join(appPath, FAKE_HELPER_PATH));
  return appPath;
}

function smokeTest(appPath: string): HelperPathContext {
  return { isPackaged: false, resourcesPath: '/nonexistent', appPath, env: { ROGER_E2E: '1' } };
}

function harness(
  context: TestContext,
  options: {
    setting?: SystemAudioCaptureSetting;
    helperContext?: HelperPathContext;
    directives?: string;
  } = {},
) {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const store = new InMemoryTranscriptStore();
  const api = new ApiClient({ baseUrl: 'http://127.0.0.1:9', token: 'test' });
  const capture = new CaptureService({
    store,
    api,
    uploader: new TranscriptUploader({ store, api, logger }),
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    logger,
    // The fake provider: Start asks the API for no token.
    sttProviderOverride: 'fake',
    startupError: null,
  });
  const statuses: CaptureStatus[] = [];
  capture.on('status', (status) => statuses.push(status));
  const focus: (() => void)[] = [];
  const readSigningIdentity = vi.fn<SystemAudioDeps['readSigningIdentity']>(() =>
    Promise.resolve(IDENTITY),
  );
  const systemAudio = createSystemAudio({
    setting: options.setting ?? 'auto',
    helperContext: options.helperContext ?? smokeTest(appWithFakeHelper()),
    capture,
    store,
    logger,
    readSigningIdentity,
    onWindowFocus: (listener) => focus.push(listener),
    env: { ...process.env, ROGER_FAKE_AUDIO: options.directives ?? '' },
  });
  context.onTestFinished(async () => {
    await capture.stop({ flushUploads: false });
    await systemAudio.quitHook.run();
  });
  const messages = (): unknown[] => logs.map((line) => line.message);
  return { capture, systemAudio, statuses, focus, logs, messages, readSigningIdentity };
}

describe.concurrent('createSystemAudio', () => {
  it('feeds the helper tap into each recording, and stops it with the recording', async (context) => {
    const { capture, messages } = harness(context);
    expect(capture.getStatus().systemCapture).toBeNull();
    await capture.start();
    expect(capture.getStatus().systemCapture).toBe('tap');
    await vi.waitFor(() => {
      expect(capture.getStatus().sources.system.chunks).toBeGreaterThanOrEqual(3);
    });
    await capture.stop({ flushUploads: false });
    await vi.waitFor(() => {
      expect(messages()).toContain('audio helper stopped');
    });
    expect(capture.getStatus().systemCapture).toBeNull();
  });

  // The per-wave Mac check reads this line in the installed app's log (phase-2-build-order.md).
  it('logs which path call audio takes', (context) => {
    const { logs } = harness(context);
    expect(logs.find((line) => line.message === 'call audio capture chosen')).toMatchObject({
      level: 'info',
      systemCapture: 'tap',
      helper: 'e2e-fake',
    });
  });

  it("takes Electron's path when the helper is missing, and runs nothing", async (context) => {
    const appPath = mkdtempSync(join(tmpdir(), 'roger-app-'));
    const { capture, logs, messages, readSigningIdentity } = harness(context, {
      helperContext: { ...smokeTest(appPath), env: {} },
    });
    expect(logs.find((line) => line.message === 'call audio capture chosen')).toMatchObject({
      systemCapture: 'electron',
      reason: `no audio helper at ${join(appPath, 'native/bin/roger-audio')}`,
    });
    await capture.start();
    expect(capture.getStatus().systemCapture).toBe('electron');
    expect(capture.getStatus().systemAudioVerified).toBeUndefined();
    expect(messages()).not.toContain('audio helper started');
    // codesign runs only for the tap, whose "verified" it keys.
    expect(readSigningIdentity).not.toHaveBeenCalled();
  });

  it('sends the window a status when system audio turns verified', async (context) => {
    const { capture, statuses } = harness(context);
    await capture.start();
    await vi.waitFor(() => {
      expect(statuses.some((status) => status.systemAudioVerified === true)).toBe(true);
    });
  });

  it('rebuilds the tap when the window regains focus while system audio is unverified', async (context) => {
    const { capture, focus, messages } = harness(context, { directives: 'silence' });
    await capture.start();
    await vi.waitFor(() => {
      expect(capture.getStatus().sources.system.chunks).toBeGreaterThan(0);
    });
    expect(focus).toHaveLength(1);
    focus[0]!();
    await vi.waitFor(() => {
      expect(messages()).toContain('call audio tap rebuilt');
    });
  });

  // G1: a source that failed closes its vendor session at once, so it bills no silence.
  it("closes call audio's vendor session when the helper is refused", async (context) => {
    const { capture } = harness(context, { setting: 'tap', directives: 'format=8000' });
    await capture.start();
    await vi.waitFor(() => {
      expect(capture.getStatus().sources.system.health).toBe('error');
    });
    const status = capture.getStatus();
    expect(status.streams.system).toBe('closed');
    // The reason M2-T11's SignalMonitor turns into the loud warning; the tap adds none of its own.
    expect(status.sources.system.message).toContain('8000 Hz');
    expect(status.warnings).toBeUndefined();
  });

  it('waits at quit for the helper to stop', async (context) => {
    const { capture, systemAudio, messages } = harness(context);
    await capture.start();
    await vi.waitFor(() => {
      expect(capture.getStatus().sources.system.chunks).toBeGreaterThan(0);
    });
    void capture.stop({ flushUploads: false });
    await systemAudio.quitHook.run();
    expect(messages()).toContain('audio helper stopped');
  });
});
