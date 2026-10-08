import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
  Tray,
  type BrowserWindow,
} from 'electron';
import type { AppRoute } from '../shared/ipc/app';
import { APP_PREFERENCES } from '../shared/preferences';
import { startKeepRunning } from './app/keepRunning';
import { userDataOverride } from './app/userDataPath';
import { ApiClient } from './api/ApiClient';
import type { ApiConnection } from './api/http';
import { NotesClient } from './api/notesClient';
import { createStreamRequest } from './api/streamRequest';
import { VocabularyClient } from './api/vocabularyClient';
import { aboutPanelOptions, fatalStartText } from './app/startupText';
import { canvasColor, startAppearance } from './app/appearance';
import { buildAppMenu } from './appMenu';
import { CALENDAR_QUIT_TIMEOUT_MS, createCalendarRuntime } from './calendar/createCalendarRuntime';
import { SqliteCalendarCache } from './calendar/SqliteCalendarCache';
import { createCaptureRuntime } from './capture/createCaptureRuntime';
import { loadConfig, readConfigFile } from './config';
import { enterE2eMode, resolveE2eMode } from './e2eMode';
import { RecordingLifecycle, watchApp, watchWindow } from './lifecycle';
import { createLogger, errorMessage } from './logger';
import { registerMeetingsIpc } from './meetings/meetings-ipc';
import { registerNavigation } from './navigation';
import { LlmStreams } from './notes/LlmStreams';
import { registerNotesIpc } from './notes/notes-ipc';
import { NotesGenerator } from './notes/NotesGenerator';
import { KeptSilentMeetings, NotesQuitGuard } from './notes/notesQuitGuard';
import { NotesSync } from './notes/NotesSync';
import { SqliteNotesStore } from './notes/SqliteNotesStore';
import { ensureMicrophoneAccess } from './permissions';
import { PreferencesStore } from './preferences/PreferencesStore';
import { registerPreferencesIpc } from './preferences/preferences-ipc';
import { PromptWindow } from './prompt/PromptWindow';
import { registerPromptIpc } from './prompt/promptIpc';
import { CrashRecovery } from './recovery/CrashRecovery';
import { SqliteTranscriptStore } from './store/SqliteTranscriptStore';
import { createSpeechToText } from './stt/createSpeechToText';
import { TranscriptUploader } from './upload/TranscriptUploader';
import { registerVocabularyIpc } from './vocabulary/vocabularyIpc';
import { createMainWindow, installPermissionHandlers, resolveAppPage } from './window';

const MISSING_TOKEN =
  'No API token. Set ROGER_DESKTOP_API_TOKEN (or "apiToken" in config.json in the app data folder) and restart.';

/**
 * The composition root. Phase 2 tasks wire their features in through named slots: a marker line
 * `// [slot <task>] <what>` and a blank line. A task writes only under its own marker and never
 * moves or rewords one, so tasks that fill different slots merge cleanly (the next marker is an
 * unchanged line between them). The marker order is load-bearing; each marker says why where it
 * matters. Phase 2's slot list: docs/plans/phase-2-build-order.md, section 1 (P2-F1).
 */
async function main(): Promise<void> {
  // [slot M2-T13] e2e mode: temporary user data, no TCC prompt. Before the lock (it uses userData).

  // The Electron smoke test only (e2eMode.ts): unpackaged and ROGER_E2E=1, read from the launch's
  // environment, never .env (loadDevEnv runs later). M5-T11's slot leaves userData alone while
  // `e2e.on`: this folder is the run's. The harness (e2e/harness.ts) writes config.json there
  // before launch, checks main's userData is that folder, and reads lines through `window.roger`.
  const e2e = resolveE2eMode({
    isPackaged: app.isPackaged,
    env: process.env,
    userDataDirSwitch: app.commandLine.getSwitchValue('user-data-dir'),
    makeTemporaryDir: () => mkdtempSync(join(tmpdir(), 'roger-e2e-')),
  });
  enterE2eMode(
    e2e,
    { app, systemPreferences, desktopCapturer, Notification },
    // Unpackaged only, so pretty like the app logger; that one needs config.json from userData.
    createLogger({ level: 'info', format: 'pretty' }).child({ component: 'e2e' }),
  );

  // [slot M5-T11 userData] "Roger Dev" when not packaged. Before the lock; never over M2-T13's.

  // Before the lock: Electron keys the single-instance lock on userData, and productName is
  // "Roger" in a dev build too, so a dev run quit at once against the installed Roger in the menu
  // bar, and where it ran it shared roger.sqlite with it (app/userDataPath.ts). Never over the
  // e2e run's folder (`e2e` is M2-T13's, just above) or a `--user-data-dir` the launch named.
  const devUserData = userDataOverride({
    isPackaged: app.isPackaged,
    e2eOn: e2e.on,
    userDataSwitch: app.commandLine.hasSwitch('user-data-dir'),
    appData: app.getPath('appData'),
  });
  if (devUserData !== null) app.setPath('userData', devUserData);

  if (!app.requestSingleInstanceLock()) {
    // A second copy would fight over the SQLite file and the microphone.
    app.quit();
    return;
  }
  await app.whenReady();
  loadDevEnv();

  const userData = app.getPath('userData');
  const configFile = readConfigFile(join(userData, 'config.json'));
  const config = loadConfig(process.env, configFile.config);
  const logger = createLogger({
    level: config.logLevel,
    format: app.isPackaged ? 'json' : 'pretty',
  });
  if (configFile.error) logger.warn(configFile.error);
  if (config.sttProviderOverride && config.sttProviderOverride !== 'fake') {
    logger.warn('ROGER_STT_PROVIDER is ignored unless it is "fake"; the API picks the vendor', {
      value: config.sttProviderOverride,
    });
  }
  // Set by the window creation below; the main window's IPC registrars trust only its page.
  let window: BrowserWindow | null = null;
  // Brings the window forward: the app menu, the prompt panel's Open Roger and a notification click.
  const showWindow = (): void => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  // Opens a route and shows the window. `navigation` is built further down (after the runtime that
  // needs this); every caller runs long after, so the closure reads it when called.
  const openRoute = (route: AppRoute): void => {
    navigation.navigate(route);
    showWindow();
  };
  // Every Roger API client's connection (api/http.ts). Without a token each call is refused, and
  // the runtime below reports why and blocks Start.
  const apiConnection: ApiConnection = { baseUrl: config.apiUrl, token: config.apiToken ?? '' };

  // [slot M4-S2] the preferences store

  // Before every other feature: M4-T16's notes generator and M5's reminders read it, and each
  // milestone registers its own keys in its slot (src/shared/preferences.ts says how).
  const preferences = new PreferencesStore({
    path: join(userData, 'preferences.json'),
    logger: logger.child({ component: 'preferences' }),
  });
  preferences.register(APP_PREFERENCES);
  // The theme preference drives nativeTheme (the prompt panel, menus and dialogs follow) and the
  // window's background; the window below is built after this, so it opens in the right colour.
  startAppearance({
    preferences,
    nativeTheme,
    setWindowBackground: (color) => window?.setBackgroundColor(color),
  });
  registerPreferencesIpc({
    ipcMain,
    store: preferences,
    getWindow: () => window,
    logger: logger.child({ component: 'ipc' }),
  });

  // [slot M2-T4 store] the transcript store

  const store = new SqliteTranscriptStore(join(userData, 'roger.sqlite'));

  // [slot M2-T23] meetings a previous run left open (M2-T23 replaces this with CrashRecovery)

  // No session can be running at startup, so any open meeting was cut off by a crash, a force-quit,
  // or a quit whose stop outran quitStopTimeoutMs (lifecycle.ts). Each is ended here, before the
  // runtime below records the crash tails of ended meetings and re-runs them, except the one Roger
  // was recording under 10 minutes ago when this launch is the monitor's relaunch: it resumes in
  // the same meeting id (M2 D7, recovery/CrashRecovery.ts).
  const crashRecovery = new CrashRecovery({
    store,
    relaunched: process.argv.includes('--relaunched'),
    // D7 also resumes a launch nobody relaunched while a call app holds the mic. The monitor is a
    // local of createCaptureRuntime (`[slot M2-T17a]`), returned as `callApps` and destructured
    // below, so this names a const the runtime slot declares later. The getter is read
    // only in `start` (the setImmediate below), after that const exists; never call it earlier.
    callApps: () => callAppMonitor,
    logger: logger.child({ component: 'crash-recovery' }),
  });
  crashRecovery.endMeetingsLeftOpen();
  // The resume needs the capture service `[slot M2-T4 runtime]` builds below, and the uploader it
  // builds first, whose launchedAt then precedes every line the resume stores. Trap: this reads
  // `capture` before its line. It runs once main() has run to its end, so it finds it only while
  // nothing between here and createCaptureRuntime awaits (CrashRecovery.test.ts checks).
  setImmediate(() => {
    try {
      void crashRecovery.start(capture);
    } catch (error) {
      // `capture` unset (a ReferenceError): main() threw before its line, and Roger is exiting.
      logger.error('crash recovery not started: Roger did not finish starting', {
        error: errorMessage(error),
      });
    }
  });

  // [slot M4-T16 notes store] notes.sqlite. Before the runtime: the uploader and capture need it.

  // Every meeting's notes as this Mac holds them (M4), in their own file beside roger.sqlite. The
  // guard asks the windows to save the notes still in an editor: at quit, and at Stop, before the
  // uploader is asked whether a meeting nobody spoke in has notes and must be kept.
  const notesStore = new SqliteNotesStore(join(userData, 'notes.sqlite'));
  const notesQuitGuard = new NotesQuitGuard({
    store: notesStore,
    windows: () => (window === null ? [] : [window]),
    logger: logger.child({ component: 'notes' }),
  });

  // [slot M2-T4 runtime] API client, uploader, capture, capture IPC, the recording lifecycle

  const api = new ApiClient(apiConnection);
  // Built before anything that stores a line: its `launchedAt` (the moment of this construction)
  // is what the held-line settling and a crash resume (`[slot M2-T23]`) count "created before this
  // launch" from, so a line stored earlier than the uploader would count as an older run's.
  const uploader = new TranscriptUploader({
    store,
    api,
    logger: logger.child({ component: 'uploader' }),
    // M4-T16: a meeting nobody spoke in is kept for its notes, asked once the open editors have
    // saved; both delete sites in CaptureService ask through these (TranscriptUploader says why).
    // Stop's save, never the quit's flush: only it fails on a window that did not answer, and
    // only a failure keeps the meeting (NotesQuitGuard.saveOpenNotes; KeptSilentMeetings in
    // `[slot M4-T16 notes]` drops its generate if the uploader then discards it).
    hasNotes: (meetingId) => notesStore.hasNotes(meetingId),
    saveOpenNotes: () => notesQuitGuard.saveOpenNotes(),
  });
  // An unreadable config.json is the likely reason for a missing token, so the UI names both.
  const missingToken = config.apiToken
    ? null
    : configFile.error === null
      ? MISSING_TOKEN
      : `${MISSING_TOKEN} (${configFile.error})`;
  // A refused cost guard blocks Start rather than fall back: a typo must never loosen a guard.
  const settingsError =
    config.errors.length === 0
      ? null
      : `Settings refused: ${config.errors.join('; ')}. Fix config.json or the ROGER_* variables and restart.`;
  if (settingsError !== null) logger.error(settingsError);
  const startupError =
    [missingToken, settingsError].filter((error) => error !== null).join(' ') || null;
  // Capture, the one open budget, the capture IPC and every M2 feature's slot. The cost guards go
  // in with `config`: into CaptureService and its budget there, into the adapters here.
  const {
    capture,
    quitHooks: captureQuitHooks,
    callOffer,
    callApps: callAppMonitor,
  } = createCaptureRuntime({
    config,
    store,
    api,
    apiConnection,
    uploader,
    createSpeechToText: (provider) =>
      createSpeechToText(provider, { logger, guards: config.costGuards }),
    ensureMicrophoneAccess: () => ensureMicrophoneAccess(),
    startupError,
    userData,
    ipcMain,
    getWindow: () => window,
    openRoute,
    logger,
  });

  // Filled by `[slot M5-T9c]`, which runs after this lifecycle is built: the hook list below is
  // read at quit, so the calendar's stop (its own account, sync and cache) joins it late.
  let stopCalendar: (() => Promise<void>) | null = null;

  // Quit and the window really closing (never a hide: closing the window only hides it, M5-T11)
  // stop the recording, and so does a page that cannot be brought
  // back (lifecycle.ts); a crash or a reload reloads the page, and a sleep pauses the sessions
  // (capture/createCaptureRuntime.ts, M2-T18). After the stop, a quit runs the hooks below in
  // order, each bounded. The two markers in the list are slots like the others: whoever rewires
  // this block keeps both, in this order, because the notes flush must run before the stores
  // close.
  const lifecycle = new RecordingLifecycle({
    capture,
    logger: logger.child({ component: 'lifecycle' }),
    quitStopTimeoutMs: config.costGuards.quitStopTimeoutMs,
    quitHooks: [
      // [slot M4-T16 quit] ask each window to flush its notes (1 s), then close notes.sqlite

      notesQuitGuard.quitHook,
      {
        name: 'stop the calendar and close calendar.sqlite',
        timeoutMs: CALENDAR_QUIT_TIMEOUT_MS,
        run: () => stopCalendar?.(),
      },

      // [slot M2-T4 quit] stop the uploader and close the transcript store

      // The capture features' own hooks first: their timers and helpers touch the store.
      ...captureQuitHooks,
      {
        name: 'stop the uploader and close the transcript store',
        // Synchronous, so the bound never cuts it; every hook names one all the same.
        timeoutMs: 1_000,
        run: () => {
          uploader.stop();
          // A tick still awaiting the API meets the closed store next ('database is not open').
          // TranscriptUploader.tick logs that and never rejects; a rejection would be unhandled
          // here. After a stop that timed out, a late final line meets it too; CaptureSession
          // logs that.
          store.close();
        },
      },
    ],
    quit: () => {
      app.quit();
    },
  });
  watchApp(lifecycle, { app });

  // After createCaptureRuntime, so the hook its `[slot M2-T14b]` sets (`setBeforeFirstTick`: settle
  // the lines held since the last run) is in place before the first tick.
  if (missingToken === null) uploader.start();
  else logger.error(missingToken);

  // [slot M4-S1] navigation and the app menu

  // A route main opens in the page (app:navigate) waits here until the page says app:ready.
  const navigation = registerNavigation({
    ipcMain,
    getWindow: () => window,
    logger: logger.child({ component: 'navigation' }),
  });
  const appMenu = buildAppMenu({
    appName: app.name,
    open: openRoute,
    // The page opens the microphone, so main asks it to start (a hidden window still captures).
    startNotes: () => {
      capture.requestStart({});
      showWindow();
    },
    stopNotes: () => {
      if (capture.phase !== 'recording') return;
      capture.stop().catch((error: unknown) => {
        logger.error('stop from the app menu failed', { error: errorMessage(error) });
      });
    },
    isPackaged: app.isPackaged,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu));
  app.setAboutPanelOptions(aboutPanelOptions(app.getVersion()));

  // [slot M4-S4b] meetings IPC

  // Home's Earlier list and the meeting page read roger.sqlite, never the API: both work
  // offline. A read after the quit hook closed the store rejects, and the page shows why.
  registerMeetingsIpc({
    ipcMain,
    store,
    getWindow: () => window,
    logger: logger.child({ component: 'meetings' }),
  });

  // [slot M3-T8] vocabulary IPC

  // The jargon list in Settings: each read and save goes to the API, nothing is kept here.
  registerVocabularyIpc({
    ipcMain,
    client: new VocabularyClient(apiConnection),
    getWindow: () => window,
    logger: logger.child({ component: 'vocabulary' }),
  });

  // [slot M4-T16 notes] notes and chat IPC, the notes generator and the notes sync

  const notesLogger = logger.child({ component: 'notes' });
  const notesClient = new NotesClient(apiConnection);
  // Uploads notes.sqlite to Postgres. It never creates a meeting there: a note whose meeting is
  // still pending waits for the uploader, and a 404 hands the meeting back to it (NotesSync.ts).
  const notesSync = new NotesSync({
    store: notesStore,
    api: notesClient,
    meetings: {
      remoteState: (meetingId) => store.getMeeting(meetingId)?.remoteState ?? null,
      onChange: (listener) =>
        uploader.onStatus(() => {
          listener();
        }),
    },
    onMeetingMissing: (meetingId) => {
      uploader.markMeetingMissing(meetingId);
    },
    logger: notesLogger,
  });
  const llmStreams = new LlmStreams({
    stream: createStreamRequest(apiConnection),
    cancelRun: (meetingId, runId) => notesClient.cancelRun(meetingId, runId),
    logger: notesLogger,
  });
  const notesGenerator = new NotesGenerator({
    store: notesStore,
    sync: notesSync,
    streams: llmStreams,
    api: notesClient,
    transcripts: store,
    uploads: uploader,
    recordings: capture,
    // The same webContents object at every call: LlmStreams tracks a window by identity.
    window: () => (window === null || window.isDestroyed() ? null : window.webContents),
    logger: notesLogger,
  });
  // Stop keeps a meeting nobody spoke in when the windows did not save their notes in time (every
  // page, until M4-T20 mounts the flush responder), and the generator writes it up; the uploader
  // may then discard it as empty, telling nobody. This drops its generate then.
  const keptSilentMeetings = new KeptSilentMeetings({
    recordings: capture,
    uploads: uploader,
    transcripts: store,
    pendingGenerates: notesStore,
    generator: notesGenerator,
    logger: notesLogger,
  });
  const notesIpc = registerNotesIpc({
    ipcMain,
    getWindow: () => window,
    store: notesStore,
    sync: notesSync,
    generator: notesGenerator,
    streams: llmStreams,
    api: notesClient,
    flush: notesQuitGuard,
    logger: logger.child({ component: 'ipc' }),
  });
  // At quit, once the open editors saved, in this order: nothing writes notes.sqlite after it
  // closes, and the generator's flushes go through the sync.
  notesQuitGuard.stopBeforeClose(keptSilentMeetings, notesGenerator, notesSync, notesIpc);
  // As the uploader: without a token every request is refused, and the runtime says why. Saves
  // still land in notes.sqlite and upload at the next launch that has one.
  if (missingToken === null) {
    notesSync.start();
    // Before the generator, and in the turn uploader.start() ran (no await since): its status
    // listener must run first, and its scan must see the meetings an earlier launch kept before
    // the first tick deletes them (KeptSilentMeetings).
    keptSilentMeetings.start();
    notesGenerator.start();
  }

  // [slot M5-T9c] the calendar runtime and the start-request enricher

  // Google Calendar: the synced copy, reminders, the prompt service (M5-T10's panel window draws
  // it, and registers its IPC), the calendar IPC, and the enricher that links a manual start to the
  // one call that is on. Each preference key it reads is registered inside, before anything reads.
  // Kept by name: the runtime does not hand its cache back, and the menu bar reads it too.
  const calendarCache = new SqliteCalendarCache(join(userData, 'calendar.sqlite'));
  const calendar = createCalendarRuntime({
    cache: calendarCache,
    apiConnection,
    preferences,
    store,
    capture,
    navigation,
    ipcMain,
    getWindow: () => window,
    // What the app menu's `open` does, for the prompt panel's "Open Roger".
    openWindow: showWindow,
    electron: { app, powerMonitor, powerSaveBlocker, shell },
    logger: logger.child({ component: 'calendar' }),
  });
  // The call offer was built with the capture runtime, before this PromptService existed: until
  // this line a due offer is logged and dropped. Once only: bindPrompts throws on a second call.
  callOffer.bindPrompts(calendar.prompts);

  const page = resolveAppPage();
  // The prompt panel (M5-T10): without it a reminder or a call offer reaches PromptService and no
  // card is ever drawn. Its channels trust the panel's own page, never the main window's: the
  // getter below is the panel (null until the first card), so the main window's page cannot click
  // a prompt and the panel's cannot use any other channel (promptIpc.ts, ipc/trust.ts).
  const promptLogger = logger.child({ component: 'prompt' });
  const promptWindow = new PromptWindow({
    prompts: calendar.prompts,
    page,
    preloadPath: join(__dirname, '../preload/prompt.js'),
    logger: promptLogger,
  });
  const stopPromptIpc = registerPromptIpc({
    ipcMain,
    getWindow: () => promptWindow.panel,
    prompts: calendar.prompts,
    logger: promptLogger,
  });
  promptWindow.start();
  // The panel goes before the calendar closes its stores: a card drawn at quit has nothing to act on.
  stopCalendar = async () => {
    stopPromptIpc();
    promptWindow.stop();
    await calendar.stop();
  };
  installPermissionHandlers(
    session.defaultSession,
    page,
    logger.child({ component: 'permissions' }),
  );
  // A launch at login keeps the window hidden (app/windowLifecycle.ts). Read once, before the page
  // loads: macOS tells only the first read of a launch, so the login item log gets this value.
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  window = createMainWindow(
    join(__dirname, '../preload/index.js'),
    page,
    logger.child({ component: 'window' }),
    {
      lifecycle,
      openedAtLogin,
      boundsPath: join(userData, 'window-bounds.json'),
      backgroundColor: canvasColor(nativeTheme.shouldUseDarkColors),
    },
  );
  watchWindow(lifecycle, window);
  window.on('closed', () => {
    window = null;
  });
  logger.info('roger started', { apiUrl: config.apiUrl, userData, packaged: app.isPackaged });

  // [slot M5-T11 lifecycle] the tray, the login item, activate, and window-all-closed

  // Closing the window hides it, so Roger runs on in the menu bar: no quit when the last window
  // goes, the window comes back from the Dock or a second launch, and open at login follows the
  // preference. Quit is the app menu's or the tray's `app.quit()`, which RecordingLifecycle
  // stops the recording for. `calendar` is M5-T9c's runtime: the menu names the next meetings and
  // a connect turns the login item on (`{ account, sync, cache }` is all the tray reads of it).
  startKeepRunning({
    app,
    electron: { Tray, Menu, nativeImage },
    build: { isPackaged: app.isPackaged, e2eOn: e2e.on },
    openedAtLogin,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    capture,
    calendar: { account: calendar.account, sync: calendar.sync, cache: calendarCache },
    preferences,
    ipcMain,
    getWindow: () => window,
    navigate: (route) => {
      navigation.navigate(route);
    },
    logger: logger.child({ component: 'app' }),
  });
}

/**
 * In development the repo-root `.env` is the single place for local settings. Only the desktop's
 * own `ROGER_*` keys are taken: the API's vendor keys in that file must not enter this process.
 */
function loadDevEnv(): void {
  if (app.isPackaged) return;
  const envPath = resolve(app.getAppPath(), '../../.env');
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) {
    if (key.startsWith('ROGER_') && process.env[key] === undefined) process.env[key] = value;
  }
}

void main().catch((error: unknown) => {
  const message = errorMessage(error);
  process.stderr.write(`fatal: ${message}\n`);
  // A packaged app opened from Finder has no terminal; without this it would just vanish.
  dialog.showErrorBox('Roger could not start', fatalStartText(message));
  app.exit(1);
});
