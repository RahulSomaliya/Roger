import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { app, dialog, ipcMain, Menu, powerMonitor, session, type BrowserWindow } from 'electron';
import { APP_PREFERENCES } from '../shared/preferences';
import { ApiClient } from './api/ApiClient';
import type { ApiConnection } from './api/http';
import { VocabularyClient } from './api/vocabularyClient';
import { buildAppMenu } from './appMenu';
import { createCaptureRuntime } from './capture/createCaptureRuntime';
import { loadConfig, readConfigFile } from './config';
import { RecordingLifecycle, watchApp, watchWindow } from './lifecycle';
import { createLogger, errorMessage } from './logger';
import { registerMeetingsIpc } from './meetings/meetings-ipc';
import { registerNavigation } from './navigation';
import { ensureMicrophoneAccess } from './permissions';
import { PreferencesStore } from './preferences/PreferencesStore';
import { registerPreferencesIpc } from './preferences/preferences-ipc';
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

  // [slot M5-T11 userData] "Roger Dev" when not packaged. Before the lock; never over M2-T13's.

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
  // or a quit whose stop outran quitStopTimeoutMs (lifecycle.ts).
  const recovered = store.endMeetingsLeftOpen(new Date().toISOString());
  if (recovered > 0)
    logger.warn('ended meetings left open by a previous run', { count: recovered });

  // [slot M4-T16 notes store] notes.sqlite. Before the runtime: the uploader and capture need it.

  // [slot M2-T4 runtime] API client, uploader, capture, capture IPC, the recording lifecycle

  const api = new ApiClient(apiConnection);
  const uploader = new TranscriptUploader({
    store,
    api,
    logger: logger.child({ component: 'uploader' }),
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
  const { capture, quitHooks: captureQuitHooks } = createCaptureRuntime({
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
    logger,
  });

  // Quit, sleep, the window closing, crashing or reloading: each stops the recording (lifecycle.ts).
  // After the stop, a quit runs the hooks below in order, each bounded. The two markers in the
  // list are slots like the others: whoever rewires this block keeps both, in this order, because
  // the notes flush must run before the stores close.
  const lifecycle = new RecordingLifecycle({
    capture,
    logger: logger.child({ component: 'lifecycle' }),
    quitStopTimeoutMs: config.costGuards.quitStopTimeoutMs,
    quitHooks: [
      // [slot M4-T16 quit] ask each window to flush its notes (1 s), then close notes.sqlite

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
  watchApp(lifecycle, { app, powerMonitor });

  // After createCaptureRuntime, so a hook its slots set (T3b's beforeFirstTick) runs first.
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
    open: (route) => {
      navigation.navigate(route);
      if (window === null) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu));

  // [slot M4-S4b] meetings IPC

  // The sidebar's recent meetings and the meeting page read roger.sqlite, never the API: both work
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

  // [slot M5-T9c] the calendar runtime and the start-request enricher

  const page = resolveAppPage();
  installPermissionHandlers(
    session.defaultSession,
    page,
    logger.child({ component: 'permissions' }),
  );
  window = createMainWindow(
    join(__dirname, '../preload/index.js'),
    page,
    logger.child({ component: 'window' }),
  );
  watchWindow(lifecycle, window);
  window.on('closed', () => {
    window = null;
  });
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  logger.info('roger started', { apiUrl: config.apiUrl, userData, packaged: app.isPackaged });

  // [slot M5-T11 lifecycle] the tray, the login item, activate, and window-all-closed

  app.on('window-all-closed', () => {
    app.quit();
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
  dialog.showErrorBox('Roger could not start', message);
  app.exit(1);
});
