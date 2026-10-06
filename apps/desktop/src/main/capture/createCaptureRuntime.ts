import { app } from 'electron';
import type { BackupStatus, CaptureReport, EchoStatus } from '../../shared/capture';
import type { ApiClient } from '../api/ApiClient';
import { createSystemAudio } from '../audio/system/createSystemAudio';
import type { ApiConnection } from '../api/http';
import type { DesktopConfig } from '../config';
import { type CaptureRequests, type CaptureWindow, registerIpcHandlers } from '../ipc';
import type { IpcMainLike } from '../ipc/trust';
import type { QuitHook } from '../lifecycle';
import type { Logger } from '../logger';
import type { MicrophoneAccess } from '../permissions';
import { readSigningIdentity } from '../signing';
import type { StoredSegment, TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { electronNotifierPorts, Notifier } from '../notify/Notifier';
import { CaptureService } from './CaptureService';
import { SignalMonitor } from './SignalMonitor';
import { SttOpenBudget } from './SttOpenBudget';

export interface CaptureRuntimeDeps {
  config: DesktopConfig;
  store: TranscriptStore;
  api: ApiClient;
  /** For a feature's own API client on api/http.ts (M3-T19b's sttUsageClient). */
  apiConnection: ApiConnection;
  /** Not started yet: index.ts starts it once every slot here has run (T3b's beforeFirstTick). */
  uploader: TranscriptUploader;
  /** Built in index.ts with `config.costGuards`, which the adapters apply themselves. */
  createSpeechToText: SpeechToTextFactory;
  ensureMicrophoneAccess: () => Promise<MicrophoneAccess>;
  /** A configuration problem found at startup (no token, a refused guard): it blocks Start. */
  startupError: string | null;
  /** The app's data folder (M2-T15 keeps audio under `audio/`). */
  userData: string;
  ipcMain: IpcMainLike;
  getWindow: () => CaptureWindow | null;
  logger: Logger;
  clock?: () => number;
}

export interface CaptureRuntime {
  capture: CaptureService;
  /**
   * The one open budget (cost guard G3), shared by every open outside the bench: CaptureService's
   * for a recording, and M2-T16's gap re-run through `acquire(1, 'minute')`.
   */
  budget: SttOpenBudget;
  /**
   * What the features need done at quit (stop a poll, a sweep, a helper), in slot order. index.ts
   * runs them under `[slot M2-T4 quit]`, after the recording stops and before the transcript store
   * closes: a timer still running after the close meets "database is not open".
   */
  quitHooks: QuitHook[];
}

/**
 * What the M2 features answer for the meeting-scoped capture channels; each stays null until its
 * task fills it in its slot below. The ids are checked (ipc.ts) and the meeting is known
 * (createCaptureRequests) before any of these runs.
 */
export interface CaptureFeatureHandlers {
  /** M2-T14b: the meeting's echo counts for its report. */
  echoReport: ((meetingId: string) => EchoStatus) | null;
  /** M2-T15: the meeting's audio backup for its report. */
  backupReport: ((meetingId: string) => BackupStatus) | null;
  /** M2-T15: delete the meeting's audio, with its path check; its lines stay. */
  deleteMeetingAudio: ((meetingId: string) => Promise<void>) | null;
  /** M2-T16: re-run the meeting's gaps from its backup; it refuses while a recording runs. */
  rerunGaps: ((meetingId: string) => Promise<void>) | null;
  /**
   * M2-T14b: show a hidden line again (the store, `transcript:segment-changed`, the upload). Only
   * ever handed a line of the meeting asked for whose `suppressedReason` is set.
   */
  unhideSegment: ((segment: StoredSegment) => void) | null;
}

export function noCaptureFeatures(): CaptureFeatureHandlers {
  return {
    echoReport: null,
    backupReport: null,
    deleteMeetingAudio: null,
    rerunGaps: null,
    unhideSegment: null,
  };
}

/** Until M2-T14b counts them: nothing is hidden, trimmed or held without the echo filter. */
const NO_ECHO: Readonly<EchoStatus> = Object.freeze({ hidden: 0, trimmed: 0, held: 0 });

/** Until M2-T15 keeps audio: none is kept. */
const NO_BACKUP: Readonly<BackupStatus> = Object.freeze({
  state: 'off',
  bytes: 0,
  keepUntil: null,
  keptForRerun: false,
  message: null,
});

/**
 * Capture's main-process runtime: the capture service, the one open budget, the capture IPC, and
 * a named slot for each M2 feature (and M3-T19b's usage uploader). `[slot M2-T4 runtime]` in
 * index.ts calls it.
 *
 * Slots work as in index.ts: a marker line `// [slot <task>] <what>` and a blank line; a task
 * writes only under its own marker, never moves one, and adds its imports at the top. The marker
 * order is load-bearing (createCaptureRuntime.test.ts says why). A feature reaches capture through
 * its seams, never through an edit to CaptureService.ts:
 * - `capture.addAudioSink` for every recorded chunk
 * - `capture.onRecording` for the live CaptureSession at Start and the stop's reason at Stop
 * - `capture.addStatusContributor` and `capture.refreshStatus` for its status fields
 * - `features` for its part of the capture channels
 * - `quitHooks.push(...)` for what must stop at quit
 */
export function createCaptureRuntime(deps: CaptureRuntimeDeps): CaptureRuntime {
  const { config, store, logger } = deps;
  const clock = deps.clock ?? (() => Date.now());
  // One budget for capture and the re-run, never one each: the vendor counts opens per account, so
  // a re-run after Stop and the next Start spend the same minute window.
  const budget = new SttOpenBudget(
    {
      perMinute: config.costGuards.sttOpensPerMinute,
      perMeeting: config.costGuards.sttOpensPerMeeting,
    },
    clock,
  );
  const capture = new CaptureService({
    store,
    api: deps.api,
    uploader: deps.uploader,
    createSpeechToText: deps.createSpeechToText,
    ensureMicrophoneAccess: deps.ensureMicrophoneAccess,
    logger: logger.child({ component: 'capture' }),
    sttProviderOverride: config.sttProviderOverride,
    startupError: deps.startupError,
    guards: config.costGuards,
    budget,
    clock,
  });
  const features = noCaptureFeatures();
  const quitHooks: QuitHook[] = [];

  // [slot M2-T6] the network poll (net.isOnline every 1 s), fed to the live session

  // [slot M2-T10] call audio through the helper: HelperProcess, TapSystemAudio, selection

  // The tap or Electron's path, chosen once; the helper runs while a recording does. M2-T17a's
  // monitor, M2-T18's wake (`source.restart`) and M2-T19's "I allowed it" (`source.rebuild`,
  // `verification`) use `systemAudio`. The helper's place comes from the build only
  // (native/helperPath.ts): the fake helper only under ROGER_E2E=1 in an unpackaged build.
  const systemAudio = createSystemAudio({
    setting: config.capture.systemAudioCapture,
    helperContext: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      env: process.env,
    },
    capture,
    store,
    logger: logger.child({ component: 'system-audio' }),
    readSigningIdentity: () => readSigningIdentity(process.execPath),
    onWindowFocus: (listener) => {
      app.on('browser-window-focus', listener);
    },
    clock,
  });
  quitHooks.push(systemAudio.quitHook);

  // [slot M2-T11] signal health and loud warnings: SignalMonitor (a sink), Notifier

  // M2-T17b posts "the call ended" and M2-T19 its test notification through `notifier`; M2-T17a
  // tells `signalMonitor` when the default input is Bluetooth (setMicBluetooth, owner's D4).
  const notifier = new Notifier({
    ports: electronNotifierPorts(deps.getWindow),
    logger: logger.child({ component: 'notifier' }),
    clock,
  });
  const signalMonitor = new SignalMonitor({
    store,
    logger: logger.child({ component: 'signal' }),
    clock,
    onChange: () => {
      capture.refreshStatus();
    },
  });
  signalMonitor.attach(capture);
  // Every feature's warnings, not only the monitor's: M2-T10's hung helper and M2-T15's paused
  // backup reach the user the same way.
  capture.on('status', (status) => {
    notifier.updateWarnings(status.warnings ?? []);
  });

  // [slot M2-T14b] the echo sink, T3b's beforeFirstTick, unhide and the echo report

  // [slot M2-T15] the audio backup (a sink), retention, header repair, delete-audio

  // [slot M2-T16] the gap re-run: every session takes `budget.acquire(1, 'minute')` first

  // [slot M2-T17a] the call app monitor; it feeds the echo sink's RouteProvider

  // [slot M2-T17b] the call offer and auto-stop

  // [slot M2-T18] sleep and wake: PowerCoordinator

  // [slot M2-T19] permission setup, `setup:*`; no navigation port (index.ts makes it later)

  // [slot M3-T19b] the STT usage uploader

  registerIpcHandlers({
    ipcMain: deps.ipcMain,
    capture,
    requests: createCaptureRequests(store, features),
    getWindow: deps.getWindow,
    logger: logger.child({ component: 'ipc' }),
  });
  return { capture, budget, quitHooks };
}

/**
 * The meeting-scoped capture channels: the report is read from the store, with each feature's
 * part; the actions run through the features. The features are read when a request comes, so a
 * handler a slot set after this was built still answers.
 */
export function createCaptureRequests(
  store: TranscriptStore,
  features: CaptureFeatureHandlers,
): CaptureRequests {
  const knownMeeting = (meetingId: string): void => {
    if (store.getMeeting(meetingId) === null) {
      throw new Error(`Meeting ${meetingId} is not on this Mac.`);
    }
  };
  const getReport = (meetingId: string): CaptureReport => {
    knownMeeting(meetingId);
    return {
      meetingId,
      stopReason: store.getMeetingStopReason(meetingId),
      gaps: store.listGaps(meetingId).map((gap) => ({
        id: gap.id,
        source: gap.source,
        startMs: gap.startMs,
        endMs: gap.endMs,
        reason: gap.reason,
        recoveredAt: gap.recoveredAt,
        recoverError: gap.recoverError,
      })),
      events: store.listCaptureEvents(meetingId).map((event) => ({
        at: event.at,
        offsetMs: event.offsetMs,
        source: event.source,
        kind: event.kind,
        detail: event.detail,
      })),
      echo: features.echoReport?.(meetingId) ?? { ...NO_ECHO },
      backup: features.backupReport?.(meetingId) ?? { ...NO_BACKUP },
    };
  };
  /** Runs a feature's action on a known meeting, then reads the report it changed. */
  const act = async (
    meetingId: string,
    run: ((meetingId: string) => Promise<void>) | null,
    what: string,
  ): Promise<CaptureReport> => {
    knownMeeting(meetingId);
    if (run === null) throw new Error(`${what} is not available in this version of Roger.`);
    await run(meetingId);
    return getReport(meetingId);
  };
  return {
    getReport,
    rerunGaps: (meetingId) =>
      act(meetingId, features.rerunGaps, 'Re-running gaps from the audio backup'),
    deleteMeetingAudio: (meetingId) =>
      act(meetingId, features.deleteMeetingAudio, 'Deleting the audio backup of a meeting'),
    unhideSegment: ({ meetingId, segmentId }) => {
      const segment = store.getSegment(segmentId);
      if (segment?.meetingId !== meetingId) {
        throw new Error(`Line ${segmentId} of meeting ${meetingId} is not on this Mac.`);
      }
      // A trimmed line keeps uploading what is left of it; the store would not unhide it either
      // (TranscriptStore.unhideSegment). The preview fake refuses the same lines.
      if (segment.suppressedReason === null) {
        throw new Error(`Line ${segmentId} is not hidden: only a hidden line can be shown again.`);
      }
      if (features.unhideSegment === null) {
        throw new Error('Showing a hidden line again is not available in this version of Roger.');
      }
      features.unhideSegment(segment);
    },
  };
}
