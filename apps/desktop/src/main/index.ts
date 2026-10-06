import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { app, dialog, ipcMain, session, type BrowserWindow } from 'electron';
import { ApiClient } from './api/ApiClient';
import { CaptureService } from './capture/CaptureService';
import { loadConfig, readConfigFile } from './config';
import { registerIpcHandlers } from './ipc';
import { createLogger, errorMessage } from './logger';
import { ensureMicrophoneAccess } from './permissions';
import { SqliteTranscriptStore } from './store/SqliteTranscriptStore';
import { createSpeechToText } from './stt/createSpeechToText';
import { TranscriptUploader } from './upload/TranscriptUploader';
import { createMainWindow, installPermissionHandlers, resolveAppPage } from './window';

const MISSING_TOKEN =
  'No API token. Set ROGER_DESKTOP_API_TOKEN (or "apiToken" in config.json in the app data folder) and restart.';

async function main(): Promise<void> {
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

  const store = new SqliteTranscriptStore(join(userData, 'roger.sqlite'));
  // No session can be running at startup, so any open meeting was cut off by a crash or force-quit.
  const recovered = store.endMeetingsLeftOpen(new Date().toISOString());
  if (recovered > 0)
    logger.warn('ended meetings left open by a previous run', { count: recovered });

  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken ?? '' });
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
  const capture = new CaptureService({
    store,
    api,
    uploader,
    createSpeechToText: (provider) => createSpeechToText(provider, { logger }),
    ensureMicrophoneAccess: () => ensureMicrophoneAccess(),
    logger: logger.child({ component: 'capture' }),
    sttProviderOverride: config.sttProviderOverride,
    startupError,
  });

  let window: BrowserWindow | null = null;
  registerIpcHandlers({
    ipcMain,
    capture,
    getWindow: () => window,
    logger: logger.child({ component: 'ipc' }),
  });
  if (missingToken === null) uploader.start();
  else logger.error(missingToken);

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

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        // No upload flush on quit: lines are safe in SQLite and the uploader resumes next launch.
        await capture.stop({ flushUploads: false });
      } catch (error) {
        logger.error('stop on quit failed', { error: errorMessage(error) });
      } finally {
        uploader.stop();
        // A tick still awaiting the API meets the closed store next ('database is not open').
        // TranscriptUploader.tick logs that and never rejects; a rejection would be unhandled here.
        store.close();
        app.quit();
      }
    })();
  });
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
