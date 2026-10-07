import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { LIVE_CALL } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { CaptureStatus, CaptureWarning, SourceStatus } from '../src/shared/capture';
import { IpcChannel } from '../src/shared/ipc';

/*
 * Browser QA for M2-T20a, the capture status UI (qa/README.md): both themes, 1440 and 390 wide.
 * On the preview's live call, main's status is replaced by the states a call goes through, as
 * main sends them (CaptureStatusChanged): healthy with levels and notices; the call audio helper
 * down (two loud warnings in one row), and the same banner on Home; a stream reconnecting with
 * main's countdown; the Mac offline with the backup paused and a quiet call-audio warning; a dead
 * mic and a stream that failed for good; and after Stop, with Roger's stop notice and the last
 * recording's meter. Every check runs before its shot. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m2-t20a.qa.e2e.ts
 */

let run: qa.QaRun;
const gallery = new qa.Gallery('M2-T20a capture status', 'm2-t20a');
const FLOW_TIMEOUT_MS = 300_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m2-t20a', Task: 'M2-T20a' });
});

const STATUS = '[aria-label="Capture status"]';
const row = (source: 'mic' | 'system'): string => `.capture-stream[data-source="${source}"]`;
const chip = (source: 'mic' | 'system'): string => `${row(source)} .stream-state`;
const warningRow = (source: 'mic' | 'system' | 'none'): string =>
  `.banner-slot .capture-warning[data-source="${source}"]`;

/** An ISO instant `seconds` ago: when a spell began or a notice came. */
const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

// Main's own words (main/capture/warnings.ts, main/audio/system/TapSystemAudio.ts,
// main/backup/AudioBackupWriter.ts, main/capture/CaptureSession.ts, CaptureService.ts).
const HELPER_HUNG = (): CaptureWarning => ({
  kind: 'helper-hung',
  source: 'system',
  since: ago(9),
  message: 'Call audio stopped: the call audio helper stopped responding, so Roger restarted it.',
  loud: true,
});
const NO_CALL_AUDIO = (): CaptureWarning => ({
  kind: 'no-audio',
  source: 'system',
  since: ago(12),
  message:
    'No call audio has reached Roger for 5 seconds: it cannot hear the call. If it does not come back, press Stop, then Start again.',
  loud: true,
});
const OFFLINE = (): CaptureWarning => ({
  kind: 'offline',
  source: null,
  since: ago(20),
  message:
    'The Mac is offline, so transcription stopped. Roger reconnects on its own when the network is back.',
  loud: true,
});
const BACKUP_PAUSED = (): CaptureWarning => ({
  kind: 'backup-paused',
  source: null,
  since: ago(95),
  message:
    "Less than 2 GB of disk is free, so Roger stopped keeping this call's audio. The transcript goes on; free some space and the backup starts again.",
  loud: true,
});
const CALL_SILENT = (): CaptureWarning => ({
  kind: 'call-audio-silent',
  source: 'system',
  since: ago(40),
  message:
    'Call audio is silent. That is normal in a pause; if the others are talking, Roger is not hearing them.',
  loud: false,
});
const MIC_DEAD = (): CaptureWarning => ({
  kind: 'mic-dead',
  source: 'mic',
  since: ago(14),
  message:
    'The mic sends only silence: Roger cannot hear you. Check that the input volume is not at 0 and that Roger is on under System Settings, Privacy & Security, Microphone.',
  loud: true,
});

const MIC_DEVICE = "Rahul's AirPods Pro (2nd generation)";
const OUTPUT_DEVICE = 'MacBook Pro Speakers';

function source(base: SourceStatus, fields: Partial<SourceStatus>): SourceStatus {
  return { ...base, signal: 'signal', levelDb: -20, ...fields };
}

/** Both sources live with levels and devices, a mic that switched twice, a helper restarted. */
function healthy(base: CaptureStatus): CaptureStatus {
  return {
    ...base,
    sources: {
      mic: source(base.sources.mic, { levelDb: -14.2, device: MIC_DEVICE }),
      system: source(base.sources.system, { levelDb: -23.8, device: OUTPUT_DEVICE }),
    },
    streams: { mic: 'open', system: 'open' },
    streamMessages: { mic: null, system: null },
    warnings: [],
    notices: [
      {
        kind: 'device-switched',
        source: 'mic',
        at: ago(600),
        message: 'Switched to MacBook Pro Microphone',
      },
      {
        kind: 'helper-restarted',
        source: 'system',
        at: ago(300),
        message: 'Roger restarted the call audio helper (once this recording); call audio is back.',
      },
      {
        kind: 'device-switched',
        source: 'mic',
        at: ago(120),
        message: `Switched to ${MIC_DEVICE}`,
      },
    ],
  };
}

/** The helper hung and was killed; 12 s on, no call audio has come back. */
function helperDown(base: CaptureStatus): CaptureStatus {
  const live = healthy(base);
  return {
    ...live,
    sources: {
      ...live.sources,
      system: { ...live.sources.system, health: 'stalled', levelDb: null },
    },
    warnings: [NO_CALL_AUDIO(), HELPER_HUNG()],
  };
}

/** The vendor dropped call audio's stream; its audio flows, so it reconnects in 4 s. */
function reconnecting(base: CaptureStatus): CaptureStatus {
  const live = healthy(base);
  const reason = 'the vendor closed the stream (code 1006)';
  return {
    ...live,
    streams: { mic: 'open', system: 'retrying' },
    streamMessages: { mic: null, system: reason },
    error: `Transcription of Them (system) stopped: ${reason}. Reconnecting when its audio flows, in 4 s.`,
  };
}

/** Offline (both streams), the disk nearly full, and call audio quiet for 40 s. */
function offline(base: CaptureStatus): CaptureStatus {
  const live = healthy(base);
  const message = 'the Mac is offline; reconnects when the network is back';
  return {
    ...live,
    sources: {
      ...live.sources,
      system: { ...live.sources.system, signal: 'quiet', levelDb: null },
    },
    streams: { mic: 'offline', system: 'offline' },
    streamMessages: { mic: message, system: message },
    warnings: [OFFLINE(), CALL_SILENT(), BACKUP_PAUSED()],
  };
}

/** The mic sends digital silence; call audio's stream spent the meeting's opens and failed. */
function micDead(base: CaptureStatus): CaptureStatus {
  const live = healthy(base);
  return {
    ...live,
    sources: {
      ...live.sources,
      mic: { ...live.sources.mic, signal: 'dead', levelDb: null },
    },
    streams: { mic: 'open', system: 'error' },
    streamMessages: {
      mic: null,
      system:
        'not reconnecting: 30 speech-to-text sessions were opened for this meeting, the most one meeting may open (sttOpensPerMeeting). Press Stop, then Start again.',
    },
    warnings: [MIC_DEAD()],
  };
}

/** Every theme at every width, as each gallery shoots them. */
function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

async function waitForTitle(page: Page, title: string): Promise<void> {
  await page.waitForFunction(
    (wanted) => document.querySelector('.meeting-page h1')?.textContent === wanted,
    title,
  );
  await qa.settle(page);
}

/** Opens the live call from the sidebar, as a person would. */
async function openLiveCall(page: Page): Promise<void> {
  const selector = `.recent-meetings-list button[title="${LIVE_CALL.title}"]`;
  await qa.expectVisible(page, selector, { within: '.recent-meetings-list' });
  await page.locator(selector).click();
  await waitForTitle(page, LIVE_CALL.title);
}

async function show(page: Page, status: CaptureStatus): Promise<void> {
  await qa.emitEvent(page, IpcChannel.CaptureStatusChanged, status);
  await qa.settle(page);
  await qa.fitShellPage(page);
}

/** Fails unless `selector`'s computed `property` is the theme token `token` as the page resolves it. */
async function expectToken(
  page: Page,
  selector: string,
  property: 'color' | 'background-color' | 'border-left-color',
  token: string,
): Promise<void> {
  const [actual, expected] = await page.evaluate(
    ({ target, name, cssProperty }) => {
      const element = document.querySelector(target);
      const parent = element?.parentElement ?? null;
      if (element === null || parent === null) throw new Error(`No ${target} to read`);
      // A probe beside it, so the token resolves in the same theme scope as the element.
      const probe = document.createElement('span');
      probe.style.setProperty(
        cssProperty === 'border-left-color' ? 'color' : cssProperty,
        `var(${name})`,
      );
      parent.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(
        cssProperty === 'border-left-color' ? 'color' : cssProperty,
      );
      probe.remove();
      return [getComputedStyle(element).getPropertyValue(cssProperty), resolved];
    },
    { target: selector, name: token, cssProperty: property },
  );
  if (actual !== expected) throw new Error(`${selector} ${property} is ${actual}, not ${token}`);
}

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent()) ?? '';
}

/** How far the level bar is filled, as the page draws it (0 to 1). */
async function fillOf(page: Page, source: 'mic' | 'system'): Promise<number> {
  return page.evaluate((target) => {
    const track = document.querySelector(`${target} .level-meter-track`);
    const fill = document.querySelector(`${target} .level-meter-fill`);
    if (track === null || fill === null) throw new Error(`No level meter in ${target}`);
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  }, row(source));
}

/** Same checks on every shot: nothing scrolls sideways, nothing logged an error. */
async function expectClean(preview: qa.PreviewPage): Promise<void> {
  await qa.expectNoPageOverflow(preview.page);
  qa.expectNoConsoleErrors(preview);
}

it(
  'shows each state of a call: levels, warnings, reconnects, offline, a dead mic, and Stop',
  async () => {
    for (const { theme, width } of combos()) {
      const tag = `${theme}-${width}`;
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      await openLiveCall(page);
      await qa.stopScenario(page);
      await qa.settle(page);
      const base = await page.evaluate(() => window.roger.getCaptureStatus());
      expect(base.meetingId).toBe(LIVE_CALL.meetingId);

      // Healthy: both transcribing, levels drawn to scale, the notices, no warning.
      await show(page, healthy(base));
      await qa.expectVisible(page, STATUS);
      for (const each of ['mic', 'system'] as const) {
        expect(await textOf(page, chip(each))).toBe('Transcribing');
        await expectToken(page, chip(each), 'background-color', '--ok-bg');
      }
      expect(await fillOf(page, 'mic')).toBeCloseTo(0.76, 1);
      expect(await fillOf(page, 'system')).toBeCloseTo(0.6, 1);
      await qa.expectVisible(page, `${row('mic')} .level-meter`);
      expect(await textOf(page, `${row('mic')} .capture-stream-detail`)).toContain(MIC_DEVICE);
      expect(await page.locator('.capture-notice').count()).toBe(2);
      expect(await textOf(page, '.capture-notice')).toContain('latest of 2 recent switches');
      await qa.expectVisible(page, '.capture-notice');
      expect(await page.locator('.capture-warning').count()).toBe(0);
      expect(await textOf(page, STATUS)).toContain('Speech-to-text');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Healthy call',
        `healthy-${tag}`,
        `Both streams transcribing, with levels (${theme}, ${width})`,
        'pass',
        'Transcribing on the ok tint for both; mic bar 76% (-14 dB), call audio 60% (-24 dB); devices in the detail line, the AirPods name in full; the latest switch with "latest of 2 recent switches" and the helper restart; the meter line; no warning.',
      );

      // Failure: the call audio helper is down. Two loud warnings, one row.
      await show(page, helperDown(base));
      await qa.expectVisible(page, warningRow('system'));
      expect(await page.locator(warningRow('system')).getAttribute('role')).toBe('alert');
      expect(await page.locator(`${warningRow('system')} li`).count()).toBe(2);
      expect(await page.locator('.banner-slot .capture-warning').count()).toBe(1);
      await expectToken(page, warningRow('system'), 'background-color', '--danger-bg');
      await expectToken(page, warningRow('system'), 'border-left-color', '--danger');
      await expectToken(
        page,
        `${warningRow('system')} .capture-warning-stream`,
        'color',
        '--danger-ink',
      );
      expect(await textOf(page, chip('system'))).toBe('Connected, no audio');
      await expectToken(page, `${row('system')} .capture-stream-detail`, 'color', '--danger-ink');
      expect(await textOf(page, `${row('system')} .level-meter-text`)).toBe('no audio');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Call audio helper down',
        `helper-down-${tag}`,
        `The helper hung: two loud warnings in the call audio row (${theme}, ${width})`,
        'pass',
        'One loud row (role alert, danger tint and edge) holds both messages, the helper restart and no call audio for 5 s, dated from the earlier; the call audio row says "Connected, no audio" in danger ink and its level "no audio".',
      );

      // The same banner on Home: a cut reaches the user wherever they are.
      await page.locator('.sidebar button', { hasText: 'Home' }).click();
      await page.waitForSelector('.meeting-page', { state: 'detached' });
      await qa.settle(page);
      await qa.fitShellPage(page);
      await qa.expectVisible(page, warningRow('system'));
      expect(await page.locator(`${warningRow('system')} li`).count()).toBe(2);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Banner on Home',
        `home-${tag}`,
        `The call audio warnings on Home (${theme}, ${width})`,
        'pass',
        'The banner sits above every page: the same loud call audio row shows on Home while the call records.',
      );
      await openLiveCall(page);

      // A vendor drop: Reconnecting while its audio flows, main's countdown in the banner.
      await show(page, reconnecting(base));
      expect(await textOf(page, chip('system'))).toBe('Reconnecting');
      await expectToken(page, chip('system'), 'background-color', '--warn-bg');
      expect(await textOf(page, `${row('system')} .capture-stream-reason`)).toBe(
        'The vendor closed the stream (code 1006)',
      );
      await qa.expectVisible(page, '.banner-slot .error');
      expect(await textOf(page, '.banner-slot .error')).toContain('in 4 s.');
      expect(await page.locator('.capture-warning').count()).toBe(0);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Reconnecting',
        `reconnecting-${tag}`,
        `Call audio reconnecting, with main's countdown (${theme}, ${width})`,
        'pass',
        'Call audio reads "Reconnecting" on the warn tint, with why it dropped on its own line and "was connected"; the banner counts the wait down ("in 4 s"), as main rewrites it every tick.',
      );

      // Failure: offline, the backup paused, and a quiet call audio warning below them.
      await show(page, offline(base));
      await qa.expectVisible(page, warningRow('none'));
      await qa.expectVisible(page, warningRow('system'));
      expect(await page.locator(`${warningRow('none')} li`).count()).toBe(2);
      expect(await textOf(page, `${warningRow('none')} .capture-warning-stream`)).toBe(
        'This recording',
      );
      expect(await page.locator(warningRow('system')).getAttribute('role')).toBe('status');
      await expectToken(page, warningRow('system'), 'background-color', '--warn-bg');
      await expectToken(page, warningRow('system'), 'border-left-color', '--warn');
      const order = await page.$$eval('.banner-slot .capture-warning', (rows) =>
        rows.map((each) => each.getAttribute('data-source')),
      );
      expect(order).toEqual(['none', 'system']);
      for (const each of ['mic', 'system'] as const) {
        expect(await textOf(page, chip(each))).toBe('Offline');
      }
      expect(await textOf(page, STATUS)).not.toContain('Reconnecting');
      expect(await page.locator('.banner-slot .error').count()).toBe(0);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Offline',
        `offline-${tag}`,
        `Offline, backup paused, call audio quiet (${theme}, ${width})`,
        'pass',
        'Loud "This recording" row first with both messages (offline, backup paused), then the quiet call audio row on the warn tint (role status); both streams "Offline" with the reason, no "Reconnecting" and no countdown.',
      );

      // Failure: a dead mic, and call audio's stream out of opens for this meeting.
      await show(page, micDead(base));
      await qa.expectVisible(page, warningRow('mic'));
      expect(await textOf(page, `${row('mic')} .level-meter-text`)).toBe('no signal');
      await expectToken(page, `${row('mic')} .level-meter-text`, 'color', '--danger-ink');
      await expectToken(
        page,
        `${row('mic')} .level-meter-track`,
        'background-color',
        '--danger-bg',
      );
      expect(await textOf(page, chip('system'))).toBe('Failed');
      await expectToken(page, chip('system'), 'background-color', '--danger-bg');
      expect(await textOf(page, `${row('system')} .capture-stream-reason`)).toMatch(
        /^Not reconnecting: 30 speech-to-text sessions/,
      );
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Dead mic, failed stream',
        `mic-dead-${tag}`,
        `A dead mic and a stream out of opens (${theme}, ${width})`,
        'pass',
        'The mic row of the banner is loud; its level reads "no signal" in danger ink on a danger track; call audio reads "Failed" on the danger tint with the budget refusal as a sentence, wrapped at 390.',
      );

      // After Stop: the stop notice above the page, the last recording's meter, no rows.
      const stopped = await page.evaluate(() => window.roger.stopCapture());
      await show(page, {
        ...stopped,
        notice: 'Stopped at 10:58 because no one spoke for 15 minutes.',
      });
      await page.waitForFunction(() => document.querySelector('.meeting-phase') === null);
      await qa.settle(page);
      await qa.fitShellPage(page);
      await qa.expectVisible(page, '.banner-slot .notice');
      await qa.expectVisible(page, STATUS);
      expect(await textOf(page, STATUS)).toContain('Last recording');
      expect(await textOf(page, STATUS)).not.toContain('Saved locally');
      expect(await page.locator('.capture-stream').count()).toBe(0);
      expect(await page.locator('.capture-warning').count()).toBe(0);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'After Stop',
        `stopped-${tag}`,
        `After Stop, with Roger's stop notice (${theme}, ${width})`,
        'pass',
        'The stop notice above the page; the capture status keeps the upload and the "Last recording" meter line, with no stream rows and no "0 lines saved"; the warnings are gone.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);
