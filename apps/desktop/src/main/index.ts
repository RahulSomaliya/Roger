import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { ApiClient } from './api/ApiClient';
import { CaptureService } from './capture/CaptureService';
import { loadConfig, readConfigFile } from './config';
import { registerIpcHandlers } from './ipc';
import { createLogger, errorMessage } from './logger';
import { ensureMicrophoneAccess } from './permissions';
import { SqliteTranscriptStore } from './store/SqliteTranscriptStore';
import { createSpeechToText } from './stt/createSpeechToText';
import { TranscriptUploader } from './upload/TranscriptUploader';
import { createMainWindow } from './window';

const MISSING_TOKEN =
  'No API token. Set ROGER_DESKTOP_API_TOKEN (or "apiToken" in config.json in the app data folder) and restart.';

async function main(): Promise<void> {
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
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken ?? '' });
  const uploader = new TranscriptUploader({
    store,
    api,
    logger: logger.child({ component: 'uploader' }),
  });
  const capture = new CaptureService({
    store,
    api,
    uploader,
    createSpeechToText: (provider) => createSpeechToText(provider, { logger }),
    ensureMicrophoneAccess: () => ensureMicrophoneAccess(),
    logger: logger.child({ component: 'capture' }),
    sttProviderOverride: config.sttProviderOverride,
    startupError: config.apiToken ? null : MISSING_TOKEN,
  });

  let window: BrowserWindow | null = null;
  registerIpcHandlers({
    ipcMain,
    capture,
    getWindow: () => window,
    logger: logger.child({ component: 'ipc' }),
  });
  if (config.apiToken) uploader.start();
  else logger.error(MISSING_TOKEN);

  window = createMainWindow(join(__dirname, '../preload/index.js'));
  window.on('closed', () => {
    window = null;
  });
  logger.info('roger started', { apiUrl: config.apiUrl, userData, packaged: app.isPackaged });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        await capture.stop();
      } catch (error) {
        logger.error('stop on quit failed', { error: errorMessage(error) });
      } finally {
        uploader.stop();
        store.close();
        app.quit();
      }
    })();
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
}

/** In development the repo-root `.env` is the single place for local settings. */
function loadDevEnv(): void {
  if (app.isPackaged) return;
  const envPath = resolve(app.getAppPath(), '../../.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

void main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(error)}\n`);
  app.exit(1);
});
