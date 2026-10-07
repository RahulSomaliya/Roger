import { app, net, powerMonitor, powerSaveBlocker } from 'electron';
import type { BackupStatus, CaptureReport, EchoStatus } from '../../shared/capture';
import { IpcChannel } from '../../shared/ipc';
import type { MeetingKeptForRerun } from '../../shared/ipc/capture';
import type { ApiClient } from '../api/ApiClient';
import { createSystemAudio } from '../audio/system/createSystemAudio';
import { AudioBackup } from '../backup/AudioBackup';
import type { ApiConnection } from '../api/http';
import { SttUsageClient } from '../api/sttUsageClient';
import type { DesktopConfig } from '../config';
import { type CaptureRequests, type CaptureWindow, registerIpcHandlers } from '../ipc';
import type { IpcMainLike } from '../ipc/trust';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import { CallOffer } from '../detect/CallOffer';
import {
  MeetingAppMonitor,
  type MeetingAppMonitorOptions,
  feedRoute,
} from '../detect/MeetingAppMonitor';
import { findHelper } from '../native/helperPath';
import { helperCommand, HelperProcess } from '../native/HelperProcess';
import type { MicrophoneAccess } from '../permissions';
import { createSetup } from '../setup/createSetup';
import { readSigningIdentity } from '../signing';
import type { StoredSegment, TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import { NetworkStatus } from '../stt/networkStatus';
import { SttUsageUploader } from '../upload/SttUsageUploader';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { electronNotifierPorts, Notifier } from '../notify/Notifier';
import { PowerCoordinator } from '../power/PowerCoordinator';
import { GapAudioReader } from '../rerun/gapAudio';
import { GapRetranscriber } from '../rerun/GapRetranscriber';
import { listMeetingsKeptForRerun } from '../rerun/keptForRerun';
import { rerunCredentials } from '../rerun/rerunStt';
import { CaptureService } from './CaptureService';
import { EchoSink } from './echo/EchoSink';
import { RouteHistory } from './echo/RouteProvider';
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
  /**
   * M2-T17b: call offers and auto-stop. Its prompt service is late-bound: index.ts calls
   * `callOffer.bindPrompts(calendar.prompts)` right after `createCalendarRuntime` (`[slot
   * M5-T9c]`) builds the PromptService, which is after this runtime. Until then an offer that
   * falls due is logged and dropped; auto-stop does not need it.
   */
  callOffer: CallOffer;
}

/**
 * What the M2 features answer for the capture channels; each stays null until its task fills it in
 * its slot below. For each member that takes a meeting, the ids are checked (ipc.ts) and the
 * meeting is known (createCaptureRequests) before it runs; `listMeetingsKeptForRerun` takes none.
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
  /** M2-T16: every meeting whose audio is kept for a re-run, newest first (Home's card). */
  listMeetingsKeptForRerun: (() => MeetingKeptForRerun[]) | null;
}

export function noCaptureFeatures(): CaptureFeatureHandlers {
  return {
    echoReport: null,
    backupReport: null,
    deleteMeetingAudio: null,
    rerunGaps: null,
    unhideSegment: null,
    listMeetingsKeptForRerun: null,
  };
}

/** Without an echo handler (tests through noCaptureFeatures()): nothing hidden, trimmed or held. */
const NO_ECHO: Readonly<EchoStatus> = Object.freeze({ hidden: 0, trimmed: 0, held: 0 });

/** Without a backup handler (tests through noCaptureFeatures()): none is kept. */
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

  // Polled only while a recording runs: the session it suspends exists only then, and Start just
  // opened two sessions, so each recording begins online. Offline terminates both sockets and holds
  // the audio; back online, each source reopens with its next chunk (CaptureSession.suspendStreams).
  const network = new NetworkStatus({
    isOnline: () => net.isOnline(),
    logger: logger.child({ component: 'network' }),
  });
  capture.onRecording({
    started: ({ session }) => {
      network.follow(session);
    },
    ended: () => {
      network.stop();
    },
  });

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

  // Mic lines that repeat call audio (laptop speakers) are hidden or trimmed, and each waits for
  // the call-audio watermark before it may upload (M2 D2). M2-T16 runs its re-run mic lines through
  // `echoSink.filterStored`; M2-T17a sets `echoRoute` from the monitor's route events as each comes:
  // it keeps every report, dated on the clock meetings start by, and known headphones turn the
  // filter off for the lines said while they played. The sink's segment listener runs before
  // ipc.ts's (registered below), so a `hidden` change reaches the window before the line it names,
  // as TranscriptSegmentChange allows: the page keeps such a change until its line arrives.
  const echoRoute = new RouteHistory(clock);
  const echoSink = new EchoSink({
    store,
    enabled: config.capture.echoFilter,
    route: echoRoute,
    publishChange: (change) => {
      const window = deps.getWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send(IpcChannel.TranscriptSegmentChanged, change);
      }
    },
    logger: logger.child({ component: 'echo' }),
    clock,
  });
  echoSink.attach(capture);
  // The holds an earlier run left are decided before anything uploads. The settle touches only
  // lines created before the uploader's launchedAt (EchoSink.settleAll says why): it can be retried
  // after a Start of this run.
  deps.uploader.setBeforeFirstTick((launchedAt) => {
    echoSink.settleAll(launchedAt);
  });
  capture.addStatusContributor('echo', ({ meetingId }) => {
    const echo = echoSink.liveStatus(meetingId);
    return echo === null ? {} : { echo };
  });
  features.echoReport = (meetingId) => echoSink.report(meetingId);
  features.unhideSegment = (segment) => {
    echoSink.unhide(segment);
  };

  // [slot M2-T15] the audio backup (a sink), retention, header repair, delete-audio

  // Each recording's audio under userData/audio, deleted past `audioRetentionDays`. start()
  // repairs the WAVs a crash left open before M2-T16's slot below reads them; M2-T16 calls
  // `audioBackup.refresh(meetingId)` once a re-run recovers a gap, so the status after Stop stops
  // saying the audio is kept for it.
  const audioBackup = new AudioBackup({
    capture,
    store,
    userData: deps.userData,
    settings: config.capture,
    logger: logger.child({ component: 'audio-backup' }),
    clock,
  });
  audioBackup.start();
  features.backupReport = (meetingId) => audioBackup.report(meetingId);
  features.deleteMeetingAudio = (meetingId) => audioBackup.deleteMeetingAudio(meetingId);
  quitHooks.push(audioBackup.quitHook);

  // [slot M2-T16] the gap re-run: every session takes `budget.acquire(1, 'minute')` first

  // Audio that reached main but not the vendor is transcribed again from the backup: at launch
  // (once audioBackup.start() above has repaired the WAVs, and the crash tails are recorded as
  // gaps), after every Stop, and on demand; never while capture is not idle. Each session takes a
  // slot in this one budget's minute window right before it opens (house rule 9), and re-run mic
  // lines go through the echo sink against the call audio stored first (filterStored).
  const rerunLogger = logger.child({ component: 'rerun' });
  const rerun = new GapRetranscriber({
    store,
    capture,
    budget,
    opensPerMinute: config.costGuards.sttOpensPerMinute,
    credentials: rerunCredentials(deps.api, config.sttProviderOverride),
    createSpeechToText: deps.createSpeechToText,
    audio: new GapAudioReader({ store, userData: deps.userData, logger: rerunLogger }),
    echo: echoSink,
    onRecovered: (meetingId) => {
      audioBackup.refresh(meetingId);
    },
    logger: rerunLogger,
    clock,
  });
  rerun.start();
  features.rerunGaps = (meetingId) => rerun.rerunMeeting(meetingId);
  features.listMeetingsKeptForRerun = () =>
    listMeetingsKeptForRerun(store, config.capture.audioRetentionDays);
  quitHooks.push({
    name: 'stop the gap re-run',
    // A terminate, or a killed afconvert: well under a second.
    timeoutMs: 3_000,
    run: () => rerun.stop(),
  });

  // [slot M2-T17a] the call app monitor; it feeds the echo sink's RouteProvider

  // `roger-audio monitor` runs from launch to quit, not only while recording: a call is offered
  // before anyone presses Start (M2-T17b reads `meetingAppMonitor.onCallApps`). Each route event
  // sets `echoRoute` and `signalMonitor`'s Bluetooth flag, and the status gets `route` and the
  // mic's device, which SignalMonitor turns into "Switched to <device>" (feedRoute says why in
  // that order). The helper is found here, not through `systemAudio`: that has no location on
  // Electron's path.
  let monitorHelper: MeetingAppMonitorOptions['helper'];
  try {
    const lookup = findHelper({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      env: process.env,
    });
    monitorHelper = lookup.found
      ? {
          create: (listener) =>
            new HelperProcess({
              name: 'monitor',
              command: helperCommand(lookup.location, [
                'monitor',
                '--parent-pid',
                String(process.pid),
                // An unpackaged build must not relaunch: `open -b ai.linkt.roger` starts the
                // installed Roger.app, not the dev build that died (Monitor.swift).
                ...(app.isPackaged ? [] : ['--relaunch-dry-run']),
              ]),
              stdout: 'lines',
              listener,
              logger: logger.child({ component: 'call-monitor-helper' }),
            }),
        }
      : { missing: lookup.reason };
  } catch (error) {
    // A relative app path or a failed access check: no helper to run, as selectSystemAudio reads it.
    monitorHelper = { missing: errorMessage(error) };
  }
  const meetingAppMonitor = new MeetingAppMonitor({
    helper: monitorHelper,
    // The pids of Roger's renderer, GPU and utility processes change as windows open and close.
    ownPids: () => new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]),
    // The only sign this launch is the helper's relaunch of a killed Roger (ParentWatch.swift).
    // Electron's `app.relaunch()` without `args` passes argv on, flag included: a Roger that
    // restarts itself must drop it, or the next Start is read as a relaunch.
    relaunched: process.argv.includes('--relaunched'),
    logger: logger.child({ component: 'call-monitor' }),
  });
  meetingAppMonitor.attach(capture);
  feedRoute(meetingAppMonitor, {
    echoRoute,
    signalMonitor,
    refreshStatus: () => {
      capture.refreshStatus();
    },
  });
  capture.addStatusContributor('route', () => meetingAppMonitor.statusContribution());
  quitHooks.push(meetingAppMonitor.quitHook);
  meetingAppMonitor.start();

  // [slot M2-T17b] the call offer and auto-stop

  // An app that holds the mic for 5 s (a browser 15 s) is offered to M5's prompt panel as
  // `call_detected`; nothing starts without the person's click. A recording in which a call app
  // was seen stops through the normal stop (`call-ended`) once none holds the mic for 15 s (a
  // browser 30 s), and `notifier` says so. `config.capture.callDetection` turns both off. It
  // fills `status.trigger` and listens to powerMonitor beside PowerCoordinator for the 60 s wake
  // grace. PromptService does not exist yet here: index.ts binds it (see CaptureRuntime.callOffer).
  const callOffer = new CallOffer({
    enabled: config.capture.callDetection,
    monitor: meetingAppMonitor,
    capture,
    notifier,
    powerMonitor,
    logger: logger.child({ component: 'call-offer' }),
    clock,
  });
  callOffer.attach();
  quitHooks.push(callOffer.quitHook);

  // [slot M2-T18] sleep and wake: PowerCoordinator

  // The only owner of powerMonitor's suspend and resume for capture (lifecycle.ts no longer stops
  // on a sleep): suspend finishes and closes both sessions, wake reopens each with its next chunk
  // and restarts the call audio helper, and a sleep of noSpeechStopMs or more stops at wake. It
  // keeps the Mac from idling to sleep while a recording runs (powerSaveBlocker).
  new PowerCoordinator({
    capture,
    systemAudio: systemAudio.source,
    powerMonitor,
    powerSaveBlocker,
    noSpeechStopMs: config.costGuards.noSpeechStopMs,
    logger: logger.child({ component: 'power' }),
    clock,
  }).attach();

  // [slot M2-T19] permission setup, `setup:*`; no navigation port (index.ts makes it later)

  // The setup screen's checks and actions. The renderer opens the screen itself
  // (app/slots/m2-setup.ts): on a first run, and when a Start is refused for the microphone.
  createSetup({
    ipcMain: deps.ipcMain,
    getWindow: deps.getWindow,
    systemAudio,
    store,
    config,
    apiConnection: deps.apiConnection,
    isPackaged: app.isPackaged,
    logger: logger.child({ component: 'setup' }),
    clock,
  });

  // [slot M3-T19b] the STT usage uploader

  // Each meeting's stt_usage row to the API: every 30 s, and at once after a Stop, whose save holds
  // the meeting's last totals and its stop reason. `ended` runs before Stop's transcript flush, and
  // the uploader never waits on TranscriptUploader. A Stop that threw (`stopFailed`) may not have
  // saved those totals: the next pass sends whatever was saved. Without a token every request is
  // refused, so it never starts (as index.ts treats the transcript uploader); the rows wait for a
  // launch that has one.
  const usageUploader = new SttUsageUploader({
    store,
    api: new SttUsageClient(deps.apiConnection),
    logger: logger.child({ component: 'stt-usage' }),
  });
  capture.onRecording({
    ended: ({ stopFailed }) => {
      if (!stopFailed) usageUploader.sendNow();
    },
  });
  if (deps.apiConnection.token !== '') usageUploader.start();
  quitHooks.push(usageUploader.quitHook);

  registerIpcHandlers({
    ipcMain: deps.ipcMain,
    capture,
    requests: createCaptureRequests(store, features),
    getWindow: deps.getWindow,
    logger: logger.child({ component: 'ipc' }),
  });
  return { capture, budget, quitHooks, callOffer };
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
    // Not wired (tests through noCaptureFeatures()): no audio is kept for a re-run, as NO_BACKUP.
    listMeetingsKeptForRerun: () => features.listMeetingsKeptForRerun?.() ?? [],
  };
}
