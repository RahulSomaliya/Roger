import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS, type CaptureReport } from '../../shared/capture';
import { IpcChannel } from '../../shared/ipc';
import type { MeetingKeptForRerun } from '../../shared/ipc/capture';
import { ApiClient } from '../api/ApiClient';
import {
  copyBackupFixture,
  FIXTURE_ENDED_AT_MS,
  FIXTURE_GAP_ID,
  FIXTURE_MEETING_ID,
  type FixtureCopy,
} from '../backup/testing/backupFixture';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { SenderEvent } from '../ipc/trust';
import type { QuitHook } from '../lifecycle';
import { createLogger } from '../logger';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';

vi.mock('electron', async () =>
  (await import('../testing/electronRuntimeMock')).electronRuntimeMock(),
);

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const SENDER: SenderEvent = { sender: { id: 7 } };
const DAY_MS = 86_400_000;

describe('the M2-T16 slot of createCaptureRuntime', () => {
  let fixture: FixtureCopy | null = null;
  let quitHooks: QuitHook[] = [];

  afterEach(async () => {
    // Ends a re-run still streaming and an afconvert the backup may have started on the copy.
    for (const hook of quitHooks) await hook.run();
    fixture?.remove();
  });

  it("re-runs a gap at launch, lists the meeting until then, and answers the re-run's report", async () => {
    fixture = copyBackupFixture();
    const { store, userData } = fixture;
    const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
    const api = new ApiClient(connection);
    const handlers = new Map<string, (event: SenderEvent, payload?: unknown) => unknown>();
    const runtime = createCaptureRuntime({
      // The fake provider: the re-run asks the API for no token, and no vendor hears the audio.
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
    const ask = async <T>(channel: string, payload?: unknown): Promise<T> =>
      (await handlers.get(channel)?.(SENDER, payload)) as T;

    // The launch re-run streams the gap's 2 s of kept audio at real time: under way here.
    await vi.waitFor(() => {
      expect(runtime.capture.getStatus().rerun).toMatchObject({
        meetingId: FIXTURE_MEETING_ID,
        state: 'running',
        gaps: 1,
        finished: 0,
      });
    });
    await expect(ask<MeetingKeptForRerun[]>(IpcChannel.AudioListKeptForRerun)).resolves.toEqual([
      {
        meetingId: FIXTURE_MEETING_ID,
        title: 'Backup fixture',
        keepUntil: new Date(
          FIXTURE_ENDED_AT_MS + BACKUP_KEEP_FOR_RERUN_MAX_DAYS * DAY_MS,
        ).toISOString(),
      },
    ]);

    // Asked meanwhile, the re-run answers once the launch's run of that meeting is over.
    const report = await ask<CaptureReport>(IpcChannel.CaptureRerunGaps, {
      meetingId: FIXTURE_MEETING_ID,
    });
    expect(report.gaps.find((gap) => gap.id === FIXTURE_GAP_ID)?.recoveredAt).not.toBeNull();
    expect(report.backup.keptForRerun).toBe(false);
    expect(runtime.capture.getStatus().rerun ?? null).toBeNull();
    await expect(ask<MeetingKeptForRerun[]>(IpcChannel.AudioListKeptForRerun)).resolves.toEqual([]);

    // The fake heard the call audio's tone in the gap: one line, re-run, saved; its use metered.
    const rerun = store
      .listSegmentsOverlapping(FIXTURE_MEETING_ID, 'system', 0, 10_000)
      .filter((line) => line.origin === 'rerun');
    expect(rerun).toHaveLength(1);
    expect(rerun[0]?.startMs).toBeGreaterThanOrEqual(2_500);
    expect(store.getSttUsage(FIXTURE_MEETING_ID)?.bySource.system.sessionsOpened).toBe(1);
    expect(quitHooks.map((hook) => hook.name)).toContain('stop the gap re-run');
    // Real time: 2 s of streaming, maybe an afconvert decode, under a loaded gate.
  }, 15_000);
});
