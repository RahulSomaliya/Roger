import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { CaptureReport, CaptureStatus, TranscriptSegmentChange } from '../src/shared/capture';
import { IpcChannel } from '../src/shared/ipc';

/*
 * Browser QA for M2-T20b, the capture details UI (qa/README.md): both themes, 1440 and 390 wide.
 *  - The past meeting's page after Stop: the audio note ("kept for a re-run", the delete with its
 *    confirmation, the re-run and its progress), the echo lines and their toggle (Unhide on the
 *    hidden lines only; a failed Unhide), and the capture report.
 *  - The live call: the "Roger restarted and kept taking notes" notice and its Stop, the toggle
 *    against the real transcript, and the banner's "the call ended" notice after Stop.
 * Every check runs before its shot.
 *
 * It stands in for the plan's file name: M2-T20a's `m2-t20a.qa.e2e.ts` set the pattern (the preview
 * and its fake `window.roger`, not Electron), so every status, report and list here is one this
 * script sends through the hub (`hub.emit(IpcChannel.CaptureGetReport, report)`, as the build
 * order's section 10 says), never one main built: main's timing and IPC are not shot. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/capture-details.shots.e2e.ts
 */

let run: qa.QaRun;
const gallery = new qa.Gallery('M2-T20b capture details', 'm2-t20b');
const FLOW_TIMEOUT_MS = 420_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m2-t20b', Task: 'M2-T20b' });
});

const NOTE = '[aria-label="Audio kept"]';
const REPORT = '[aria-label="Capture report"]';
const ECHO = '[aria-label="Echo filter"]';
const TOGGLE = `${ECHO} .echo-lines-head .shell-button`;

const PAST = PAST_MEETING.meetingId;
const OTHER = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
const ahead = (days: number): string =>
  new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

/** The past meeting's report: three gaps (one filled, one failed, one waiting), a call that ended. */
function pastReport(echo: { hidden: number; trimmed: number }): CaptureReport {
  return {
    meetingId: PAST,
    stopReason: 'call-ended',
    gaps: [
      {
        id: 'g1',
        source: 'system',
        startMs: 61_000,
        endMs: 125_000,
        reason: 'offline',
        recoveredAt: ago(600),
        recoverError: null,
      },
      {
        id: 'g2',
        source: 'mic',
        startMs: 300_000,
        endMs: 312_000,
        reason: 'stt_failed',
        recoveredAt: null,
        recoverError: 'the vendor refused the re-run: 4008',
      },
      {
        id: 'g3',
        source: 'system',
        startMs: 540_000,
        endMs: 600_000,
        reason: 'budget',
        recoveredAt: null,
        recoverError: null,
      },
    ],
    events: [
      {
        at: ago(3600),
        offsetMs: 60_000,
        source: 'system',
        kind: 'warning',
        detail: { warning: 'offline', loud: true },
      },
      {
        at: ago(3500),
        offsetMs: 155_000,
        source: 'system',
        kind: 'warning-cleared',
        detail: { warning: 'offline', lastedMs: 95_000 },
      },
      {
        at: ago(3400),
        offsetMs: 240_000,
        source: 'mic',
        kind: 'device-switched',
        detail: { device: "Rahul's AirPods Pro (2nd generation)" },
      },
      {
        at: ago(3300),
        offsetMs: 300_000,
        source: 'mic',
        kind: 'stt-failed',
        detail: { stage: 'reopen', reason: 'could not reconnect: 1006', retryInMs: 4_000 },
      },
      {
        at: ago(3200),
        offsetMs: 540_000,
        source: 'system',
        kind: 'stt-budget-refused',
        detail: { limit: 'per-meeting', retryInMs: null },
      },
      {
        at: ago(3100),
        offsetMs: 700_000,
        source: null,
        kind: 'resumed_after_crash',
        detail: { downMs: 4_000, trigger: 'relaunch', callApp: null, gaps: 1 },
      },
    ],
    echo: { ...echo, held: 0 },
    backup: {
      state: 'kept',
      bytes: 13_002_342,
      keepUntil: ahead(30),
      keptForRerun: true,
      message: null,
    },
  };
}

const hiddenLine = (line: number, text: string): TranscriptSegmentChange => ({
  meetingId: PAST,
  segmentId: segmentIdForLine(PAST, line),
  source: 'mic',
  change: 'hidden',
  reason: 'echo',
  echoOf: segmentIdForLine(PAST, line + 1),
  text,
});

const trimmedLine = (line: number, text: string): TranscriptSegmentChange => ({
  ...hiddenLine(line, text),
  change: 'trimmed',
});

function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

async function openMeeting(page: Page, title: string): Promise<void> {
  const selector = `.recent-meetings-list button[title="${title}"]`;
  await qa.expectVisible(page, selector, { within: '.recent-meetings-list' });
  await page.locator(selector).click();
  await page.waitForFunction(
    (wanted) => document.querySelector('.meeting-page h1')?.textContent === wanted,
    title,
  );
  await qa.settle(page);
}

async function emit(page: Page, channel: string, payload: unknown): Promise<void> {
  await qa.emitEvent(page, channel, payload);
  await qa.settle(page);
  await qa.fitShellPage(page);
}

async function textOf(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent()) ?? '';
}

/** Polls from Node: Playwright's waitForFunction would resolve at once on a promise. */
async function waitFor(page: Page, what: string, check: () => Promise<boolean>): Promise<void> {
  await expect.poll(check, { message: what, timeout: 10_000 }).toBe(true);
  await qa.settle(page);
  await qa.fitShellPage(page);
}

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

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
      const probed = cssProperty === 'border-left-color' ? 'color' : cssProperty;
      probe.style.setProperty(probed, `var(${name})`);
      parent.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(probed);
      probe.remove();
      return [getComputedStyle(element).getPropertyValue(cssProperty), resolved];
    },
    { target: selector, name: token, cssProperty: property },
  );
  if (actual !== expected) throw new Error(`${selector} ${property} is ${actual}, not ${token}`);
}

/** Same checks on every shot: nothing scrolls sideways, nothing logged an error. */
async function expectClean(preview: qa.PreviewPage): Promise<void> {
  await qa.expectNoPageOverflow(preview.page);
  qa.expectNoConsoleErrors(preview);
}

it(
  'shows the audio note, echo lines and capture report of a past meeting',
  async () => {
    for (const { theme, width } of combos()) {
      const tag = `${theme}-${width}`;
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      // Main's answers, as the fake keeps them: the report is read when a page opens.
      await qa.emitEvent(page, IpcChannel.CaptureGetReport, pastReport({ hidden: 2, trimmed: 1 }));
      await openMeeting(page, PAST_MEETING.title);
      // The filter's changes arrive as events once the page listens: the only way it learns text.
      await qa.emitEvent(
        page,
        IpcChannel.TranscriptSegmentChanged,
        hiddenLine(2, 'so we ship on friday'),
      );
      await qa.emitEvent(
        page,
        IpcChannel.TranscriptSegmentChanged,
        hiddenLine(4, 'yeah that works for me, thanks'),
      );
      await qa.emitEvent(
        page,
        IpcChannel.TranscriptSegmentChanged,
        trimmedLine(6, 'and then the budget'),
      );
      await qa.settle(page);
      await qa.fitShellPage(page);

      // The audio note: kept for a re-run, with both actions; the report says why and how.
      await qa.expectVisible(page, NOTE);
      expect(await textOf(page, NOTE)).toContain('Audio kept for a re-run until');
      expect(await textOf(page, NOTE)).toContain('2 gaps are not filled yet.');
      expect(await textOf(page, NOTE)).toContain('12.4 MB');
      expect(await textOf(page, `${NOTE} .audio-actions`)).toBe('Re-run gapsDelete audio');
      await qa.expectVisible(page, REPORT);
      expect(await textOf(page, `${REPORT} .report-stop`)).toBe(
        'Roger stopped because the call ended.',
      );
      expect(await textOf(page, `${REPORT} .report-gap-summary`)).toBe(
        '3 gaps, 1 filled by a re-run.',
      );
      expect(await count(page, '.report-gap')).toBe(3);
      expect(
        await page
          .locator('.report-gap')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status'))),
      ).toEqual(['recovered', 'failed', 'waiting']);
      await expectToken(
        page,
        '.report-gap[data-status="failed"] .report-gap-status',
        'color',
        '--danger-ink',
      );
      expect(await textOf(page, '.report-timeline summary')).toBe('Timeline (6 events)');
      expect(
        await page.locator('.report-timeline').evaluate((el) => (el as HTMLDetailsElement).open),
      ).toBe(false);
      // The echo summary reads main's counts; the list is closed until the toggle opens it.
      expect(await textOf(page, `${ECHO} .echo-lines-summary`)).toBe(
        'Roger hid 2 mic lines that repeated the call audio, and cut repeated words out of 1 more.',
      );
      expect(await page.locator(TOGGLE).getAttribute('aria-pressed')).toBe('false');
      expect(await count(page, '.echo-line')).toBe(0);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Past meeting',
        `past-${tag}`,
        `Audio kept for a re-run, the echo filter and the capture report (${theme}, ${width})`,
        'pass',
        'The note says audio is kept for a re-run until a date, 12.4 MB, 2 gaps unfilled, with Re-run gaps and Delete audio; the echo summary has its toggle off and no text shown; the report says the call ended, 3 gaps (filled in the ok edge, failed in the danger edge with the vendor code, waiting in the warn edge) and a closed timeline of 6 events.',
      );

      // The timeline, opened: each event in words, never transcript text.
      await page.locator('.report-timeline summary').click();
      await qa.settle(page);
      await qa.fitShellPage(page);
      expect(await count(page, '.report-event')).toBe(6);
      expect(await textOf(page, '.report-events')).toContain(
        'Cleared: the Mac is offline (lasted 1m 35s)',
      );
      expect(await textOf(page, '.report-events')).toContain(
        "Mic switched to Rahul's AirPods Pro (2nd generation)",
      );
      expect(await textOf(page, '.report-events')).toContain(
        'Roger restarted after 4s and kept taking notes',
      );
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Past meeting',
        `timeline-${tag}`,
        `The capture report's timeline, opened (${theme}, ${width})`,
        'pass',
        'Six events in words with their clock time: warning and cleared with how long it lasted, the AirPods switch with its full name, a failed reopen with its retry, the budget refusal and the crash resume. No transcript text anywhere.',
      );
      await page.locator('.report-timeline summary').click();

      // The toggle: the hidden and trimmed text shows, Unhide on the hidden lines only.
      await page.locator(TOGGLE).click();
      await qa.settle(page);
      await qa.fitShellPage(page);
      expect(await page.locator(TOGGLE).getAttribute('aria-pressed')).toBe('true');
      expect(await textOf(page, TOGGLE)).toBe('Hide echo text');
      expect(await count(page, '.echo-line')).toBe(3);
      expect(await count(page, '.echo-line[data-echo-line="hidden"] .echo-line-unhide')).toBe(2);
      expect(await count(page, '.echo-line[data-echo-line="trimmed"] button')).toBe(0);
      expect(await textOf(page, '.echo-line[data-echo-line="trimmed"] .echo-line-text')).toBe(
        'and then the budget',
      );
      await qa.expectVisible(page, '.echo-line-unhide');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Echo lines',
        `echo-on-${tag}`,
        `The toggle on: hidden and trimmed text, Unhide on hidden lines only (${theme}, ${width})`,
        'pass',
        'Three lines listed with their tags; the two hidden ones carry an Unhide button, the trimmed one has none (main refuses to unhide it); hidden text in the muted ink, the trimmed text in the main ink.',
      );

      // Failure path: an Unhide main refuses shows why, and the line stays.
      await qa.failNextRequest(page, 'Line is not hidden: only a hidden line can be shown again.');
      await page.locator('.echo-line-unhide').first().click();
      await waitFor(
        page,
        'the unhide failure shows',
        async () => (await count(page, '.echo-lines-error')) === 1,
      );
      expect(await textOf(page, '.echo-lines-error')).toContain(
        'Roger could not show that line again',
      );
      expect(await textOf(page, '.echo-lines-error')).toContain(
        'only a hidden line can be shown again',
      );
      expect(await page.locator('.echo-lines-error').getAttribute('role')).toBe('alert');
      expect(await count(page, '.echo-line')).toBe(3);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Echo lines',
        `unhide-failed-${tag}`,
        `An Unhide main refused (${theme}, ${width})`,
        'pass',
        "The alert says what Roger tried and main's reason, below the list; all three lines are still listed and the buttons are enabled again.",
      );

      // Unhide: main answers with an event, and the counts it reports now are one lower. The fake
      // reports whatever the script sent, so send the new counts first, as main's would be.
      await qa.emitEvent(page, IpcChannel.CaptureGetReport, pastReport({ hidden: 1, trimmed: 1 }));
      await page.locator('.echo-line-unhide').first().click();
      await waitFor(
        page,
        'the line leaves the list',
        async () => (await count(page, '.echo-line')) === 2,
      );
      expect(await count(page, '.echo-line-unhide')).toBe(1);
      expect(await count(page, '.echo-lines-error')).toBe(0);
      await waitFor(page, 'the counts are read again', async () =>
        (await textOf(page, `${ECHO} .echo-lines-summary`)).startsWith('Roger hid 1 mic line '),
      );
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Echo lines',
        `unhidden-${tag}`,
        `After an Unhide (${theme}, ${width})`,
        'pass',
        'The unhidden line left the list (it uploads now and reads as any other), one hidden and one trimmed remain, the summary counts one hidden line, and the error is gone.',
      );
      await page.locator(TOGGLE).click();
      await qa.settle(page);

      // Re-run progress, then why a re-run is refused while another recording runs.
      const base = await page.evaluate(() => window.roger.getCaptureStatus());
      const status = (fields: Partial<CaptureStatus>): CaptureStatus => ({ ...base, ...fields });
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        status({ rerun: { meetingId: PAST, state: 'running', gaps: 2, finished: 1 } }),
      );
      await qa.expectVisible(page, `${NOTE} .rerun-progress`);
      expect(await textOf(page, `${NOTE} .rerun-progress-text`)).toBe(
        'Re-running 2 gaps from the audio backup: 1 of 2 done.',
      );
      expect(
        await page.locator(`${NOTE} progress`).evaluate((el) => (el as HTMLProgressElement).value),
      ).toBe(1);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Audio note',
        `rerun-${tag}`,
        `A re-run under way, from CaptureStatus.rerun (${theme}, ${width})`,
        'pass',
        'The note shows "Re-running 2 gaps from the audio backup: 1 of 2 done." with its bar half full.',
      );
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        status({ rerun: { meetingId: PAST, state: 'waiting', gaps: 2, finished: 1 } }),
      );
      expect(await textOf(page, `${NOTE} .rerun-progress-text`)).toBe(
        'Re-run waiting for a free speech-to-text slot: 1 of 2 gaps done.',
      );

      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        status({ rerun: null, phase: 'recording', meetingId: OTHER, startedAt: ago(30) }),
      );
      expect(await count(page, `${NOTE} progress`)).toBe(0);
      expect(
        await page.locator(`${NOTE} .shell-button`, { hasText: 'Re-run gaps' }).isDisabled(),
      ).toBe(true);
      expect(await textOf(page, `${NOTE} .audio-actions-hint`)).toBe(
        'Roger is recording: gaps are re-run once the recording stops.',
      );
      // Only the meeting being recorded refuses a delete, so this one's stays on.
      expect(
        await page.locator(`${NOTE} .shell-button`, { hasText: 'Delete audio' }).isDisabled(),
      ).toBe(false);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Audio note',
        `rerun-blocked-${tag}`,
        `A re-run refused while another recording runs (${theme}, ${width})`,
        'pass',
        "Re-run gaps is disabled and the note says why in main's words; Delete audio is still on.",
      );
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        status({ phase: 'idle', meetingId: null, startedAt: null }),
      );

      // Re-run: the fake fills every gap, as a re-run with the audio kept would.
      await page.locator(`${NOTE} .shell-button`, { hasText: 'Re-run gaps' }).click();
      await waitFor(
        page,
        'the report says every gap is filled',
        async () =>
          (await textOf(page, `${REPORT} .report-gap-summary`)) ===
          '3 gaps, all filled by a re-run.',
      );
      expect(await textOf(page, NOTE)).toContain('Audio kept on this Mac until');
      expect(await textOf(page, NOTE)).not.toContain('re-run');
      expect(await count(page, `${NOTE} .shell-button`)).toBe(1);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Audio note',
        `rerun-done-${tag}`,
        `After the re-run: every gap filled (${theme}, ${width})`,
        'pass',
        "The report (a separate region) re-read after the note's action: all three gaps filled; the note no longer says kept for a re-run and offers only the delete.",
      );

      // Delete: asks first; Keep it backs out; Delete removes the audio, and the lines stay.
      await page.locator(`${NOTE} .shell-button`, { hasText: 'Delete audio' }).click();
      await qa.settle(page);
      await qa.fitShellPage(page);
      expect(await textOf(page, `${NOTE} .audio-confirm`)).toContain(
        'Delete this meeting’s audio? Its lines stay.',
      );
      await expectToken(page, `${NOTE} .capture-danger-button`, 'background-color', '--danger');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Audio note',
        `delete-confirm-${tag}`,
        `The delete asks first (${theme}, ${width})`,
        'pass',
        '"Delete this meeting\'s audio? Its lines stay." with a danger-filled Delete and a Keep it button.',
      );
      await page.locator(`${NOTE} .shell-button`, { hasText: 'Keep it' }).click();
      await qa.settle(page);
      expect(await count(page, `${NOTE} .audio-confirm`)).toBe(0);
      await page.locator(`${NOTE} .shell-button`, { hasText: 'Delete audio' }).click();
      await page.locator(`${NOTE} .capture-danger-button`).click();
      await waitFor(page, 'the note says the audio is deleted', async () =>
        (await textOf(page, NOTE)).startsWith('This meeting’s audio is deleted.'),
      );
      expect(await count(page, `${NOTE} button`)).toBe(0);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Audio note',
        `deleted-${tag}`,
        `After the delete (${theme}, ${width})`,
        'pass',
        'The note says the audio is deleted and the lines stay, with no button left; the report and the transcript are unchanged.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'tells the live call’s resume, its echo toggle against the transcript, and the call ending',
  async () => {
    for (const { theme, width } of combos()) {
      const tag = `${theme}-${width}`;
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      await openMeeting(page, LIVE_CALL.title);
      await qa.stopScenario(page);
      await qa.settle(page);
      const base = await page.evaluate(() => window.roger.getCaptureStatus());
      expect(base.meetingId).toBe(LIVE_CALL.meetingId);
      const line = segmentIdForLine(LIVE_CALL.meetingId, 40);
      const row = `[data-segment-id="${line}"]`;
      expect(await count(page, row)).toBe(1);

      // The echo filter hides line 40 live: the transcript drops it; the toggle brings it back,
      // marked, and Unhide shows it as any other line.
      const live = (fields: Partial<CaptureStatus>): CaptureStatus => ({
        ...base,
        warnings: [],
        notices: [],
        ...fields,
      });
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        live({ echo: { hidden: 1, trimmed: 0, held: 0 } }),
      );
      await qa.emitEvent(page, IpcChannel.TranscriptSegmentChanged, {
        meetingId: LIVE_CALL.meetingId,
        segmentId: line,
        source: 'mic',
        change: 'hidden',
        reason: 'echo',
        echoOf: segmentIdForLine(LIVE_CALL.meetingId, 41),
        text: 'a line the speakers sent back into the mic',
      } satisfies TranscriptSegmentChange);
      await waitFor(
        page,
        'the transcript drops the line',
        async () => (await count(page, row)) === 0,
      );
      await qa.expectVisible(page, ECHO);
      expect(await textOf(page, `${ECHO} .echo-lines-summary`)).toBe(
        'Roger hid 1 mic line that repeated the call audio.',
      );
      // Recording: the report waits for Stop, the echo lines do not.
      expect(await count(page, REPORT)).toBe(0);
      await page.locator(TOGGLE).click();
      await waitFor(
        page,
        'the transcript shows the line, marked',
        async () => (await count(page, row)) === 1,
      );
      expect(await page.locator(row).getAttribute('data-echo')).toBe('hidden');
      expect(await count(page, '.echo-line-unhide')).toBe(1);
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Live call',
        `live-echo-${tag}`,
        `The toggle on while recording: the transcript shows the hidden line (${theme}, ${width})`,
        'pass',
        "The echo summary reads main's live count; the toggle drove the transcript (line 40 is back, marked echo) and the list gives its text with an Unhide; no capture report while the call records.",
      );
      await page.locator('.echo-line-unhide').click();
      await waitFor(
        page,
        'the line is shown again',
        async () => (await count(page, '.echo-line')) === 0,
      );
      expect(await count(page, row)).toBe(1);
      expect(await page.locator(row).getAttribute('data-echo')).toBeNull();
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        live({ echo: { hidden: 0, trimmed: 0, held: 0 } }),
      );
      expect(await count(page, ECHO)).toBe(0);

      // Roger restarted and kept taking notes: the notice with its Stop, nowhere else.
      await emit(
        page,
        IpcChannel.CaptureStatusChanged,
        live({
          notices: [
            {
              kind: 'device-switched',
              source: 'mic',
              at: ago(120),
              message: 'Switched to MacBook Pro Microphone',
            },
            {
              kind: 'resumed-after-crash',
              source: null,
              at: ago(300),
              message: 'Roger restarted and kept taking notes',
            },
          ],
        }),
      );
      await qa.expectVisible(page, '.resumed-notice .shell-button');
      expect(await textOf(page, '.resumed-notice')).toContain(
        'Roger restarted and kept taking notes',
      );
      expect(await textOf(page, '.resumed-notice .shell-button')).toBe('Stop recording');
      expect(await page.locator('.resumed-notice').getAttribute('role')).toBe('status');
      // The recoveries list shows the device switch, and not the resume a second time.
      expect(await count(page, '.capture-notices .capture-notice')).toBe(1);
      expect(await textOf(page, '.capture-notices')).not.toContain('kept taking notes');
      await expectToken(page, '.resumed-notice', 'background-color', '--chip-bg');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Live call',
        `resumed-${tag}`,
        `"Roger restarted and kept taking notes", with Stop (${theme}, ${width})`,
        'pass',
        'A quiet notice under the capture status with its time and a Stop recording button; the recoveries list beside it holds only the device switch.',
      );

      // Stop from the notice: the recording ends and the notice goes with it; Roger's own stop
      // notice for the call ending is the shell's banner, which this task relies on. The report
      // main would hold after this stop is sent first: the page reads it when the phase changes.
      await qa.emitEvent(page, IpcChannel.CaptureGetReport, {
        meetingId: LIVE_CALL.meetingId,
        stopReason: 'call-ended',
        gaps: [],
        events: [],
        echo: { hidden: 0, trimmed: 0, held: 0 },
        backup: { state: 'deleted', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
      } satisfies CaptureReport);
      await page.locator('.resumed-notice .shell-button').click();
      await waitFor(
        page,
        'the recording stops',
        async () => (await count(page, '.resumed-notice')) === 0,
      );
      const stopped = await page.evaluate(() => window.roger.getCaptureStatus());
      expect(stopped.phase).toBe('idle');
      await emit(page, IpcChannel.CaptureStatusChanged, {
        ...stopped,
        notice: 'Stopped at 10:58: the call in Zoom ended.',
      } satisfies CaptureStatus);
      await qa.expectVisible(page, '.banner-slot .notice');
      expect(await textOf(page, '.banner-slot .notice')).toBe(
        'Stopped at 10:58: the call in Zoom ended.',
      );
      await waitFor(page, 'the report shows', async () => (await count(page, REPORT)) === 1);
      expect(await textOf(page, `${REPORT} .report-stop`)).toBe(
        'Roger stopped because the call ended.',
      );
      expect(await textOf(page, NOTE)).toContain('audio is deleted');
      await expectClean(preview);
      await gallery.shoot(
        page,
        'Live call',
        `call-ended-${tag}`,
        `After Stop: the call-ended notice (${theme}, ${width})`,
        'pass',
        'The resume notice left with the recording; the banner above the page says "Stopped at 10:58: the call in Zoom ended." (main\'s own words, CaptureStatus.notice); the capture report now says the call ended with no gaps, and the audio note that the audio is deleted.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);
