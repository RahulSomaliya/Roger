import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import type { ForcedTheme } from '../preview/control';
import { fitShellPage, QA_THEMES, QA_WIDTHS } from '../qa/driver';

/**
 * The Electron smoke test's harness (M2-T13): launches the unpackaged build, as `make dev-desktop`
 * runs it, in e2e mode (`src/main/e2eMode.ts`) on Chromium's fake microphone playing a tone, the
 * fake helper for call audio (`test/fixtures/fake-roger-audio.mjs`) and the fake STT, in a data
 * folder of its own. No run may raise a macOS prompt: `launchRoger` checks e2e mode came up and
 * that every microphone the page can open is Chromium's fake one before it hands the run over,
 * and replaces each Electron call that could prompt with a counter (`RogerRun.promptCalls`).
 *
 * Build first: `pnpm test:e2e` (`make e2e-desktop`) runs `electron-vite build` and then these
 * files. Electron's binary must be on disk: `node node_modules/electron/install.js` in
 * apps/desktop, once (CLAUDE.md failure log).
 */

/**
 * apps/desktop. Electron runs on this folder so that `app.getAppPath()` is it: helperPath.ts finds
 * the fake helper and the dev build there, and `loadDevEnv` the repo's `.env`. Any other app path
 * finds neither, and call audio falls back to Electron's path, which e2e mode refuses.
 */
export const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MAIN_ENTRY = join(APP_DIR, 'out/main/index.js');

/**
 * Chromium's fake microphone and camera in place of the Mac's, and a mock keychain. e2e mode
 * appends the same switches itself (E2E_CHROMIUM_SWITCHES); passing them here too keeps a run on
 * the fake devices even if e2e mode failed to come up, which `launchRoger` then reports.
 */
const FAKE_DEVICE_SWITCHES = ['--use-fake-device-for-media-stream', '--use-mock-keychain'];

/** Launch, then the window, then the shell's New note: well inside vitest.e2e.config.ts's 60 s. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Roger stops a recording within quitStopTimeoutMs (5 s) at quit, then closes its stores. */
const QUIT_TIMEOUT_MS = 15_000;

/** The microphone's tone: lower and quieter than the fake helper's 440 Hz, so lines tell apart. */
const MIC_TONE = { hz: 330, amplitude: 6_000, seconds: 2, sampleRate: 48_000 };

export interface LaunchOptions {
  /**
   * config.json in the run's data folder (keys: src/main/config.ts). A smoke run that checks both
   * sides' lines turns `echoFilter` off: the fake STT writes the same words for every line, so
   * M2-T14b's filter would rightly hide the microphone's lines as echoes of the call's.
   */
  config?: Readonly<Record<string, unknown>>;
  /**
   * For runs that press Start more than twice a minute: raises ROGER_STT_OPENS_PER_MINUTE to 100,
   * the guard's maximum. Each Start opens two sessions and the default budget allows four a
   * minute, so the third Start inside a minute is refused (cost guard G3), fake STT or not.
   */
  manyStarts?: boolean;
  /**
   * More environment for main, such as ROGER_FAKE_AUDIO for the fake helper's directives. It
   * cannot change what makes the run a smoke run (e2e mode, the fake STT, the token, the API).
   */
  env?: Readonly<Record<string, string>>;
}

/** Each Electron call that would raise a macOS prompt, counted since launch. All must stay 0. */
export interface PromptCalls {
  /** The TCC gate's question (`systemPreferences.askForMediaAccess`). */
  askForMediaAccess: number;
  /** Screen Recording (`desktopCapturer.getSources`), Electron's call-audio path. */
  getSources: number;
  /** A notification post (`Notification#show`), whose first asks to allow notifications. */
  notifications: number;
}

declare global {
  // Set in Roger's main process by installPromptCounters, read back by RogerRun.promptCalls. A
  // name only this harness uses: tsconfig.e2e.json compiles every e2e/ file as one program.
  var __rogerE2ePrompts: PromptCalls | undefined;
}

export interface RogerRun {
  readonly app: ElectronApplication;
  /** The main window, with the shell drawn and New note enabled. */
  readonly page: Page;
  /** The run's data folder: roger.sqlite, config.json, preferences.json. Deleted by close(). */
  readonly userData: string;
  /** Main's log lines (stderr), in order, from when the launch resolved (not the first ones). */
  readonly logs: readonly string[];
  promptCalls(): Promise<PromptCalls>;
  /** Quits Roger (its quit path stops a recording first) and deletes the run's folder. */
  close(): Promise<void>;
}

/**
 * Launches Roger for one test file. Rejects, with Roger's last log lines, if e2e mode is not on,
 * if the page could open a microphone that is not Chromium's fake one, or if the shell never
 * becomes ready: in each case before anything could record, and with Roger already quit and its
 * folder deleted.
 */
export async function launchRoger(options: LaunchOptions = {}): Promise<RogerRun> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `No build at ${MAIN_ENTRY}: run \`pnpm --filter @roger/desktop test:e2e\` (it builds first) or \`electron-vite build\``,
    );
  }
  const executablePath = electronBinary();
  const runDir = await mkdtemp(join(tmpdir(), 'roger-e2e-'));
  const userData = join(runDir, 'user-data');
  const micWav = join(runDir, 'mic.wav');
  await mkdir(userData);
  if (options.config !== undefined) {
    await writeFile(join(userData, 'config.json'), `${JSON.stringify(options.config, null, 2)}\n`);
  }
  await writeFile(micWav, toneWav(MIC_TONE));

  let app: ElectronApplication | null = null;
  let logs: string[] = [];
  try {
    app = await _electron.launch({
      executablePath,
      args: [
        APP_DIR,
        // Electron 44 itself honours the switch from the first line of main (checked 2026-10-07),
        // so even a run whose e2e mode failed never opens the Mac's own Roger data folder.
        `--user-data-dir=${userData}`,
        ...FAKE_DEVICE_SWITCHES,
        // Played on a loop as the microphone (Chromium's FileSource).
        `--use-file-for-fake-audio-capture=${micWav}`,
        // On macOS the audio service's sandbox cannot read a file in the temp folder: the fake
        // microphone then logs "Failed to read ... as input to the fake device" and sends silence,
        // and the run reads as a dead mic. Only that sandbox is off; the page keeps its own.
        '--disable-features=AudioServiceSandbox',
      ],
      env: launchEnvironment(await refusedApiUrl(), options),
      cwd: APP_DIR,
      timeout: LAUNCH_TIMEOUT_MS,
    });
    logs = collectLogs(app);
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await expectE2eMode(app, userData);
    await installPromptCounters(app);
    await page
      .getByRole('button', { name: 'New note', disabled: false })
      .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expectOnlyFakeMicrophones(page);
    const launched = app;
    return {
      app: launched,
      page,
      userData,
      logs,
      promptCalls: () => readPromptCalls(launched),
      close: async () => {
        try {
          await quit(launched);
        } finally {
          await rm(runDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    const failure = new Error(`Roger did not launch for the smoke test${logTail(logs)}`, {
      cause: error,
    });
    try {
      if (app !== null) await quit(app);
    } catch (quitError) {
      // Both matter: why the launch failed, and that a Roger may still be running.
      throw new AggregateError([failure, quitError], 'Roger did not launch, then did not quit', {
        cause: quitError,
      });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
    throw failure;
  }
}

function logTail(logs: readonly string[]): string {
  return logs.length === 0 ? '' : `; its log:\n${logs.slice(-30).join('\n')}`;
}

/** electron's index.js answers its binary's path in Node; inside Electron it is the API. */
function electronBinary(): string {
  let path: unknown;
  try {
    path = createRequire(import.meta.url)('electron');
  } catch (error) {
    throw new Error(
      'Electron has no binary here: run `node node_modules/electron/install.js` in apps/desktop once',
      { cause: error },
    );
  }
  if (typeof path !== 'string' || !existsSync(path)) {
    throw new Error(`Electron's binary is not at ${String(path)}: run its install.js again`);
  }
  return path;
}

/**
 * A port nothing listens on. The run has no Roger API: each upload is refused at once and every
 * line stays in roger.sqlite, where the test reads it. A local API (`make dev-api` on port 8000)
 * must never receive a run's lines, so the harness never leaves ROGER_API_URL to `.env`.
 */
async function refusedApiUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolveListen();
    });
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
  if (address === null || typeof address === 'string') {
    throw new Error(`Could not pick a free port for the absent API (address: ${String(address)})`);
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * This process's environment without the keys that would change what a run is: every ROGER_*
 * (a developer's API, token or provider), the dev server URL (the page must be the built one) and
 * ELECTRON_RUN_AS_NODE (Electron would run as plain Node). Then the run's own. `loadDevEnv` still
 * fills the ROGER_* keys left unset here from the checkout's `.env` (in a worktree there is none),
 * so in a checkout with a `.env` its cost guards apply to the run.
 */
function launchEnvironment(apiUrl: string, options: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ROGER_')) continue;
    if (key === 'ELECTRON_RENDERER_URL' || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  return {
    ...env,
    ROGER_LOG_LEVEL: 'info',
    ...options.env,
    ...(options.manyStarts === true ? { ROGER_STT_OPENS_PER_MINUTE: '100' } : {}),
    // Last, so no option undoes them: without e2e mode the run would ask macOS for the mic.
    ROGER_E2E: '1',
    ROGER_STT_PROVIDER: 'fake',
    // index.ts refuses Start without a token; the absent API never checks it.
    ROGER_DESKTOP_API_TOKEN: 'e2e-dummy-token',
    ROGER_API_URL: apiUrl,
  };
}

/** Main's stderr as lines (Roger's logger writes there, as does Chromium). */
function collectLogs(app: ElectronApplication): string[] {
  const logs: string[] = [];
  const stderr = app.process().stderr;
  if (stderr === null) throw new Error("Roger's stderr is not piped: no log to check e2e mode by");
  stderr.setEncoding('utf8');
  let partial = '';
  stderr.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    logs.push(...lines);
  });
  return logs;
}

/**
 * Asked of main itself: its "e2e mode on" log line is written before the launch resolves, so
 * before this harness can read stderr. Notifications are off only in e2e mode on a Mac.
 */
async function expectE2eMode(app: ElectronApplication, userData: string): Promise<void> {
  const seen = await app.evaluate(({ app: electronApp, Notification }) => ({
    userData: electronApp.getPath('userData'),
    notifications: Notification.isSupported(),
  }));
  if (seen.userData !== userData || seen.notifications) {
    throw new Error(
      `Roger is not in e2e mode (userData ${seen.userData}, expected ${userData}; notifications ${seen.notifications ? 'on' : 'off'})`,
    );
  }
}

/**
 * Replaces, in Roger's main process, each Electron call that could raise a macOS prompt with a
 * counter that fails the call. e2e mode already answers them; these catch a change that reaches
 * the real ones anyway, and still keep the prompt off the Mac. Installed before the shell is
 * ready, so before the test can press anything.
 */
async function installPromptCounters(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ desktopCapturer, Notification, systemPreferences }) => {
    const calls: PromptCalls = { askForMediaAccess: 0, getSources: 0, notifications: 0 };
    globalThis.__rogerE2ePrompts = calls;
    systemPreferences.askForMediaAccess = () => {
      calls.askForMediaAccess += 1;
      return Promise.reject(new Error('the smoke test never asks macOS for media access'));
    };
    desktopCapturer.getSources = () => {
      calls.getSources += 1;
      return Promise.reject(new Error('the smoke test never captures the screen'));
    };
    Notification.prototype.show = () => {
      calls.notifications += 1;
    };
  });
}

async function readPromptCalls(app: ElectronApplication): Promise<PromptCalls> {
  const calls = await app.evaluate(() => globalThis.__rogerE2ePrompts);
  if (calls === undefined) throw new Error('The prompt counters are not installed in Roger');
  return calls;
}

/**
 * Fails unless every microphone the page can open is Chromium's fake one ("Fake Default Audio
 * Input", ...): pressing Start on a real one would record the room, and could prompt.
 */
async function expectOnlyFakeMicrophones(page: Page): Promise<void> {
  const labels = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput')
      .map((device) => device.label),
  );
  if (labels.length === 0 || labels.some((label) => !label.startsWith('Fake '))) {
    throw new Error(
      `The page could open a microphone that is not Chromium's fake one: ${JSON.stringify(labels)}`,
    );
  }
}

async function quit(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout('timeout');
    }, QUIT_TIMEOUT_MS);
  });
  try {
    if ((await Promise.race([app.close(), timedOut])) === 'timeout') {
      app.process().kill('SIGKILL');
      throw new Error(`Roger did not quit within ${QUIT_TIMEOUT_MS} ms; it was killed`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A 16-bit mono PCM WAV of a steady tone, which Chromium's fake microphone plays on a loop. */
export function toneWav(tone: {
  hz: number;
  amplitude: number;
  seconds: number;
  sampleRate: number;
}): Buffer {
  const samples = Math.round(tone.seconds * tone.sampleRate);
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(tone.sampleRate, 24);
  wav.writeUInt32LE(tone.sampleRate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per frame
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = tone.amplitude * Math.sin((2 * Math.PI * tone.hz * index) / tone.sampleRate);
    wav.writeInt16LE(Math.round(value), 44 + index * 2);
  }
  return wav;
}

/** How a QA shot looks: a forced theme at a width (qa/driver.ts's themes and widths). */
export interface Look {
  theme: ForcedTheme;
  /** CSS pixels. */
  width: number;
  /** CSS pixels; grows to fit the shell's page column when shot. */
  height?: number;
}

/** Every look a gallery shoots: both themes, at a laptop width and a phone width. */
export const LOOKS: readonly Look[] = QA_THEMES.flatMap((theme) =>
  QA_WIDTHS.map((width) => ({ theme, width })),
);

const DEFAULT_HEIGHT = 900;
/** A preference write, a theme repaint and a resize: well under a second on a healthy run. */
const LOOK_TIMEOUT_MS = 5_000;

/**
 * Forces a theme twice, through Roger's own `theme` preference and the page's
 * `prefers-color-scheme`, and waits until the page shows both, as qa/driver.ts does: a page that
 * follows the system would otherwise show whatever the scheme says. Sizes the page by its
 * viewport, not the window: the window's minimum width (window.ts) is wider than a phone.
 */
export async function setLook(run: RogerRun, look: Look): Promise<void> {
  const { theme, width, height = DEFAULT_HEIGHT } = look;
  await run.page.evaluate((value) => window.roger.setPreference('theme', value), theme);
  // Playwright emulates the scheme on every page it drives (light unless told), which overrides
  // macOS's appearance and `nativeTheme`: emulate the one asked for.
  await run.page.emulateMedia({ colorScheme: theme });
  await run.page.setViewportSize({ width, height });
  const shown = (): Promise<{ theme: string | null; system: string; width: number }> =>
    run.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      system: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      width: window.innerWidth,
    }));
  try {
    await run.page.waitForFunction(
      ({ value, expectedWidth }) =>
        document.documentElement.dataset.theme === value &&
        matchMedia('(prefers-color-scheme: dark)').matches === (value === 'dark') &&
        window.innerWidth === expectedWidth,
      { value: theme, expectedWidth: width },
      { timeout: LOOK_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(
      `Asked for ${theme} at ${width} px, but the page shows ${JSON.stringify(await shown())}`,
      { cause: error },
    );
  }
}

/**
 * Shoots the window in a look into `path` (a PNG; its folder is made), for M2-T19 and M2-T20's QA
 * in the real app, and returns what `check` found. `check` runs on the page as it will be shot
 * (look applied, column fitted, animations done), and the shot is taken only if it passes: a
 * gallery caption states what its check saw, never what the test expected. With no check, M2-T13's
 * shots were marked pass and captioned "both sides' lines after Stop" over a page still recording,
 * and over Home when the test ran alone. As qa/driver.ts does: the page column grows until it
 * stops scrolling (the shell is one screen tall), finite animations finish first, and never
 * `fullPage`, which re-runs fill-mode animations inside the capture.
 */
export async function shoot<Found>(
  run: RogerRun,
  path: string,
  look: Look,
  check: (page: Page) => Promise<Found>,
): Promise<Found> {
  await setLook(run, look);
  await run.page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  await fitShellPage(run.page);
  const found = await check(run.page);
  await mkdir(dirname(path), { recursive: true });
  await run.page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  return found;
}
