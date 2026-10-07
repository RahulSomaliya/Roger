import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { previewSearch } from '../preview/scenarios';
import * as qa from '../qa/driver';
import { ApiError, type ApiRequest } from '../src/main/api/http';
import { createLogger } from '../src/main/logger';
import { checkConnections } from '../src/main/setup/connectionChecks';
import {
  type NotificationTestOutcome,
  PermissionService,
  type SetupPorts,
} from '../src/main/setup/PermissionService';
import type { ProbeOutcome } from '../src/main/setup/systemAudioProbe';
import type { SigningIdentity } from '../src/main/signing';
import type { SetupActionKind } from '../src/renderer/src/components/setup/setupRows';
import { InMemoryTranscriptStore } from '../src/main/store/InMemoryTranscriptStore';
import type { SystemCaptureMode } from '../src/shared/capture';
import { IpcChannel, type RogerApi } from '../src/shared/ipc';
import type { MediaAccessState, SetupStatus } from '../src/shared/ipc/setup';

/**
 * M2-T19's browser QA: the permission setup screen in both themes at 1440 and 390 wide, through
 * the preview (qa/README.md). It opens the way people reach it: by itself on a first run, from the
 * app menu (app:navigate), and by itself when a Start is refused for the microphone (the failure
 * path). Every status it shows is built by main's own PermissionService and checkConnections on
 * fake ports, so each message is the one main writes: the server row is main's reading of the raw
 * "POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000". Run:
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/m2-t19.qa.e2e.ts
 */

declare global {
  interface Window {
    /** Set once the first-run page should ask the preview's fake again (openFirstRun). */
    __m2t19Live?: boolean;
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M2-T19 permission setup', 'm2-t19');
const FLOW_TIMEOUT_MS = 240_000;
const API_URL = 'http://127.0.0.1:8000';
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

/** CaptureService's refusal at Start when macOS says no (its own arrows). */
const MIC_REFUSED_AT_START =
  'Microphone access is denied. Allow Roger under System Settings \u2192 Privacy & Security \u2192 Microphone.';

const SILENT: ProbeOutcome = { kind: 'silent', audioMs: 2_000 };

const IDENTITIES: Record<'local' | 'adhoc', SigningIdentity> = {
  local: {
    kind: 'local-identity',
    requirement: 'identifier "ai.linkt.roger" and certificate leaf = H"b457"',
    requirementHash: 'a'.repeat(64),
  },
  adhoc: { kind: 'adhoc', requirement: 'cdhash H"01"', requirementHash: 'b'.repeat(64) },
};

/** Nothing answers at the API's address, as main's ApiClient reports it (api/http.ts). */
const offline: ApiRequest = (method, path) =>
  Promise.reject(
    new ApiError(
      0,
      'network_error',
      `${method} ${path} failed: connect ECONNREFUSED 127.0.0.1:8000`,
    ),
  );

interface Mac {
  microphone?: MediaAccessState;
  screen?: MediaAccessState;
  mode?: SystemCaptureMode;
  signing?: keyof typeof IDENTITIES;
  apiDown?: boolean;
  notification?: NotificationTestOutcome;
  /** What the person already pressed, in order, before the screen is shown. */
  pressed?: ('test-call-audio' | 'test-notification')[];
}

/** The status main answers for this Mac: PermissionService on fake ports. */
async function mainSays(mac: Mac): Promise<SetupStatus> {
  const ports: SetupPorts = {
    mediaAccess: (type) =>
      type === 'microphone' ? (mac.microphone ?? 'granted') : (mac.screen ?? 'granted'),
    askForMicrophone: () => Promise.resolve(true),
    readSigningIdentity: () => Promise.resolve(IDENTITIES[mac.signing ?? 'local']),
    findHelper: () => ({
      found: true,
      location: {
        origin: 'bundle',
        path: '/Applications/Roger.app/Contents/Resources/bin/roger-audio',
      },
    }),
    probe: () => Promise.resolve(SILENT),
    postTestNotification: () => Promise.resolve(mac.notification ?? { kind: 'shown' }),
    checkConnections: () =>
      mac.apiDown === true
        ? checkConnections({
            request: offline,
            baseUrl: API_URL,
            hasApiToken: true,
            sttProviderOverride: null,
            isKnownProvider: () => true,
            logger,
          })
        : Promise.resolve({
            api: { state: 'ok', message: null, relaunchNeeded: false },
            stt: { state: 'ok', message: null, relaunchNeeded: false },
          }),
    openExternal: () => Promise.resolve(),
    relaunch: () => undefined,
  };
  const service = new PermissionService({
    ports,
    systemAudio: {
      source: { mode: mac.mode ?? 'tap', rebuild: () => undefined },
      verification: null,
    },
    store: new InMemoryTranscriptStore(),
    isPackaged: true,
    logger,
  });
  for (const press of mac.pressed ?? []) {
    if (press === 'test-call-audio') await service.testSystemAudio();
    else await service.testNotification();
  }
  return service.status();
}

let FIRST_RUN: SetupStatus;
let REFUSED: SetupStatus;
let PENDING: SetupStatus;
let ELECTRON: SetupStatus;

beforeAll(async () => {
  FIRST_RUN = await mainSays({ microphone: 'not-determined', signing: 'local' });
  REFUSED = await mainSays({
    microphone: 'denied',
    signing: 'adhoc',
    apiDown: true,
    notification: { kind: 'failed', error: 'Notifications are not allowed for this application' },
    pressed: ['test-call-audio', 'test-call-audio', 'test-notification'],
  });
  PENDING = await mainSays({ pressed: ['test-call-audio'] });
  ELECTRON = await mainSays({ mode: 'electron', screen: 'denied' });
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m2-t19', Task: 'M2-T19 permission setup screen' });
});

function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

const row = (id: string): string => `.setup-row[data-row="${id}"]`;

/** Waits for the setup route to show the rows main answered. */
async function waitForSetup(page: Page): Promise<void> {
  await page.waitForSelector('.setup-list');
  await qa.settle(page);
  expect(await page.locator('h1.page-title').textContent()).toBe('Set up Roger');
  // Full-window: no sidebar on this route.
  expect(await page.locator('nav.sidebar').count()).toBe(0);
  expect(await page.locator('.setup-row').count()).toBe(6);
}

/** Opens the setup route as the app menu does. */
async function openFromMenu(page: Page, status: SetupStatus | null): Promise<void> {
  if (status !== null) await qa.emitEvent(page, IpcChannel.SetupGetStatus, status);
  await qa.emitEvent(page, IpcChannel.AppNavigate, 'setup');
  await waitForSetup(page);
}

async function tone(page: Page, id: string): Promise<string | null> {
  return page.locator(row(id)).getAttribute('data-tone');
}

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent()) ?? '';
}

/** A row's button by its action (`data-action`): plain CSS, as qa.expectVisible queries it. */
const button = (rowId: string, action: SetupActionKind): string =>
  `${row(rowId)} button[data-action="${action}"]`;

/** Presses a row's button as a person would: it must be in sight first. */
async function press(page: Page, rowId: string, action: SetupActionKind): Promise<void> {
  await qa.fitShellPage(page);
  await qa.expectVisible(page, button(rowId, action));
  await page.locator(button(rowId, action)).click();
  await qa.settle(page);
}

/**
 * Text reads the ink tokens (setup.css): a message in --ink, a description in --muted, a state
 * label in --ink. Compared as the browser resolves each token in this theme.
 */
async function expectInkText(page: Page): Promise<void> {
  const mismatches = await page.evaluate(() => {
    const resolve = (token: string): string => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    const wants: [string, string][] = [
      ['.setup-row-message', '--ink'],
      ['.setup-row-description', '--muted'],
      ['.setup-state', '--ink'],
      ['.setup-row-title', '--ink'],
    ];
    return wants.flatMap(([selector, token]) =>
      [...document.querySelectorAll(selector)].flatMap((element) => {
        const seen = getComputedStyle(element).color;
        return seen === resolve(token) ? [] : [`${selector} is ${seen}, not ${token}`];
      }),
    );
  });
  expect(mismatches).toEqual([]);
}

/** The checks every shot shares, then the shot. */
async function shoot(
  preview: qa.PreviewPage,
  group: string,
  name: string,
  caption: string,
  note: string,
): Promise<void> {
  const { page } = preview;
  await qa.fitShellPage(page);
  await qa.expectNoPageOverflow(page);
  await expectInkText(page);
  qa.expectNoConsoleErrors(preview);
  await gallery.shoot(page, group, name, caption, 'pass', note);
}

/**
 * Holds main's first-run answer from the page's first request on: the banner reads the status
 * once, as the page loads, before a script can seed the preview's fake (the hub keeps no event
 * for a listener that comes later). Runs in the page before its own scripts, so it wraps the
 * fake as preview/main.tsx assigns it; `__m2t19Live` hands the requests back to the fake.
 */
function holdFirstRun(status: SetupStatus): void {
  Object.defineProperty(window, 'roger', {
    configurable: true,
    set(roger: RogerApi) {
      const read = roger.getSetupStatus.bind(roger);
      roger.getSetupStatus = () => (window.__m2t19Live === true ? read() : Promise.resolve(status));
      Object.defineProperty(window, 'roger', {
        value: roger,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
  });
}

/**
 * qa.openPreview with the init script above. The driver's own open takes none (qa/driver.ts is
 * not this task's), so this repeats its steps: a fresh context with the theme forced as the
 * system scheme and as the app's preference, errors collected, and the preview's ready state.
 */
async function openFirstRun(theme: ForcedTheme, width: number): Promise<qa.PreviewPage> {
  const context = await run.browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  try {
    await context.addInitScript(holdFirstRun, FIRST_RUN);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await page.goto(`${run.origin}/${previewSearch({ scenario: 'empty-mac', theme })}`, {
      waitUntil: 'load',
    });
    await page.waitForSelector('html[data-state="ready"]', { state: 'attached' });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    return { page, errors, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

it(
  'opens by itself on a first run, and Allow turns the microphone row green',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await openFirstRun(theme, width);
      const { page } = preview;
      // No navigation from the script: the banner's watch opened the route.
      await waitForSetup(page);
      expect(await tone(page, 'microphone')).toBe('attention');
      expect(await textOf(page, `${row('microphone')} .setup-state`)).toContain('Not asked yet');
      expect(await textOf(page, `${row('callAudio')} .setup-state`)).toContain('Not tested');
      await qa.fitShellPage(page);
      await qa.expectVisible(page, `${row('microphone')} button.setup-primary`);
      await shoot(
        preview,
        'First run',
        `first-run-${theme}-${width}`,
        `Opened by itself on a first run (${theme}, ${width})`,
        'The page loaded on Home and the banner sent it here because main said the microphone is not-determined. Allow microphone is the lead button; call audio not tested yet. No sideways scroll; text in ink tokens; no console errors.',
      );

      await qa.emitEvent(page, IpcChannel.SetupGetStatus, FIRST_RUN);
      await page.evaluate(() => {
        window.__m2t19Live = true;
      });
      await press(page, 'microphone', 'request-microphone');
      await page.waitForSelector(`${row('microphone')}[data-tone="ok"]`);
      expect(await page.locator(`${row('microphone')} button`).count()).toBe(0);
      await press(page, 'callAudio', 'test-system-audio');
      await page.waitForSelector(`${row('callAudio')}[data-tone="ok"]`);
      await shoot(
        preview,
        'First run',
        `first-run-done-${theme}-${width}`,
        `After Allow and the call audio test (${theme}, ${width})`,
        'Allow microphone answered granted and the test heard its sound: both rows turn green, the microphone row has no button left.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'opens from the app menu on a ready Mac, and Done goes Home',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      // The fake starts on a ready Mac: the banner sent the page nowhere.
      expect(await page.locator('.setup-list').count()).toBe(0);
      await openFromMenu(page, null);
      expect(await textOf(page, '.setup-summary')).toBe('Roger has what it needs on this Mac.');
      await press(page, 'notifications', 'test-notification');
      await page.waitForSelector(`${row('notifications')}[data-tone="ok"]`);
      await shoot(
        preview,
        'Ready Mac',
        `ready-${theme}-${width}`,
        `From the app menu on a ready Mac (${theme}, ${width})`,
        'Every row green after the test notification showed; only the tests are offered. The privacy note says the audio backup never leaves the Mac.',
      );
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await qa.settle(page);
      expect(await page.locator('.setup-list').count()).toBe(0);
      expect(await page.locator('nav.sidebar').count()).toBe(1);
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'opens by itself when a Start is refused for the microphone, on rows that say how to fix each',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      await qa.emitEvent(page, IpcChannel.SetupGetStatus, REFUSED);
      // Main's answer to a Start it refused: the idle status, carrying why.
      const idle = await page.evaluate(() => window.roger.getCaptureStatus());
      await qa.emitEvent(page, IpcChannel.CaptureStatusChanged, {
        ...idle,
        error: MIC_REFUSED_AT_START,
      });
      await waitForSetup(page);
      expect(await tone(page, 'microphone')).toBe('problem');
      expect(await textOf(page, `${row('microphone')} .setup-row-message`)).toBe(
        'Roger is not allowed to use the microphone. Turn on Roger under System Settings > Privacy & Security > Microphone, then relaunch Roger.',
      );
      expect(await tone(page, 'callAudio')).toBe('problem');
      expect(await tone(page, 'notifications')).toBe('problem');
      expect(await tone(page, 'signing')).toBe('problem');
      // Main's reading of the raw ApiError; the raw text never reaches the screen.
      expect(await textOf(page, `${row('server')} .setup-row-message`)).toBe(
        "Roger can't reach its server at http://127.0.0.1:8000. Check that the Roger API is running and that this Mac is online.",
      );
      expect(await textOf(page, `${row('speechToText')} .setup-row-message`)).toBe(
        "Not checked: Roger can't reach its server.",
      );
      const screen = await textOf(page, '.setup');
      expect(screen).not.toMatch(/ECONNREFUSED|failed:|POST \/v1/);
      expect(await textOf(page, '.setup-summary')).toBe('5 checks need you.');
      await qa.fitShellPage(page);
      await qa.expectVisible(page, button('microphone', 'relaunch'));
      await shoot(
        preview,
        'Refused Mac (failure path)',
        `refused-${theme}-${width}`,
        `Opened by itself after a refused Start (${theme}, ${width})`,
        'The capture error turned non-null while main said the microphone is denied, so the banner sent the page here. Each refused row names its pane and switch and offers its fix; Relaunch Roger where macOS needs it. The server row is how main puts "POST /v1/stt/token failed: connect ECONNREFUSED" in plain words; speech-to-text is not double-flagged.',
      );

      // An action that fails says why on its own row.
      await qa.failNextRequest(
        page,
        'Roger could not open System Settings > Privacy & Security > Microphone: no application can open the URL',
      );
      await press(page, 'microphone', 'open-pane');
      await page.waitForSelector(`${row('microphone')} .setup-row-error`);
      expect(await textOf(page, `${row('microphone')} .setup-row-error`)).toBe(
        'Roger could not open System Settings > Privacy & Security > Microphone: no application can open the URL',
      );
      expect(await page.locator('.setup-row-error').count()).toBe(1);
      await shoot(
        preview,
        'Refused Mac (failure path)',
        `action-failed-${theme}-${width}`,
        `A fix that failed, on its own row (${theme}, ${width})`,
        'Main refused to open the pane: its sentence shows on the microphone row only, without the IPC wrapper Electron adds.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'asks for I allowed it after the first silent test, and hears the sound after it',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      await openFromMenu(page, PENDING);
      expect(await tone(page, 'callAudio')).toBe('attention');
      expect(await textOf(page, `${row('callAudio')} button.setup-primary`)).toBe('I allowed it');
      await shoot(
        preview,
        'Call audio',
        `pending-${theme}-${width}`,
        `The first silent test for this signing identity (${theme}, ${width})`,
        'Main says pending: macOS may still be asking. I allowed it leads; the System Audio pane and Test again follow.',
      );
      await press(page, 'callAudio', 'confirm-system-audio');
      await page.waitForSelector(`${row('callAudio')}[data-tone="ok"]`);
      expect(await textOf(page, `${row('callAudio')} .setup-state`)).toContain('Heard');
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  "shows Screen Recording as call audio on Electron's path",
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      await openFromMenu(page, ELECTRON);
      expect(await tone(page, 'callAudio')).toBe('problem');
      expect(await textOf(page, `${row('callAudio')} .setup-row-description`)).toContain(
        'Screen Recording',
      );
      await qa.fitShellPage(page);
      await qa.expectVisible(page, button('callAudio', 'open-pane'));
      expect(await textOf(page, button('callAudio', 'open-pane'))).toBe(
        'Open Screen Recording settings',
      );
      await shoot(
        preview,
        'Call audio',
        `electron-${theme}-${width}`,
        `Electron's fallback path, Screen Recording refused (${theme}, ${width})`,
        'No helper in use, so no sound test: the call audio row is Screen Recording, with its pane and Relaunch Roger.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);
