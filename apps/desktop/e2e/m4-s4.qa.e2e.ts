import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { LIVE_CALL, LIVE_CALL_FIRST_LINES, PAST_MEETING } from '../preview/scenarios';
import * as qa from '../qa/driver';
import { idleCaptureStatus } from '../src/shared/capture';
import { IpcChannel } from '../src/shared/ipc';
import type { CaptureApi } from '../src/shared/ipc/capture';

/**
 * M4-S4's browser QA: the meeting page and the sidebar's recent meetings, in both themes at 1440
 * and 390 wide, through the preview (qa/README.md). Run:
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/m4-s4.qa.e2e.ts
 */

/** What the page saw while New note started the next meeting (the A/B check below). */
interface AbWatch {
  placeholder: boolean;
  fewestLinesWhileShown: number;
}

declare global {
  interface Window {
    __abWatch?: AbWatch;
    /**
     * The preview's fake, as far as this script reads it. The renderer types the whole of it in
     * src/renderer/src/roger.d.ts, which this Node program (tsconfig.e2e.json) does not include.
     */
    roger?: Pick<CaptureApi, 'getCaptureStatus'>;
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-S4 meeting page', 'm4-s4');
const FLOW_TIMEOUT_MS = 240_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m4-s4', Task: 'M4-S4' });
});

const LINES = '.transcript > p.line:not(.interim)';
const TITLE = '.meeting-page h1';

/** Every theme at every width, as each gallery shoots them. */
function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

async function titleOf(page: Page): Promise<string | null> {
  return page.locator(TITLE).textContent();
}

async function waitForTitle(page: Page, title: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, wanted }) => document.querySelector(selector)?.textContent === wanted,
    { selector: TITLE, wanted: title },
  );
  await qa.settle(page);
}

/** Opens a meeting from the sidebar, as a person would: its button in the recent list. */
async function openFromSidebar(page: Page, title: string): Promise<void> {
  const selector = `.recent-meetings-list button[title="${title}"]`;
  await qa.expectVisible(page, selector, { within: '.recent-meetings-list' });
  await page.locator(selector).click();
  await waitForTitle(page, title);
}

async function lineCount(page: Page): Promise<number> {
  return page.locator(LINES).count();
}

/**
 * The newest final line shows inside the transcript: what a person sees of a meeting's lines.
 * Marked first, as no CSS selector picks the last final line when interim lines follow it.
 */
async function expectNewestLineVisible(page: Page): Promise<void> {
  await page.evaluate((lines) => {
    const all = document.querySelectorAll(lines);
    for (const line of all) line.removeAttribute('data-qa-newest');
    all.item(all.length - 1).setAttribute('data-qa-newest', '');
  }, LINES);
  await qa.expectVisible(page, '[data-qa-newest]', { within: '.transcript' });
}

it(
  'shows a stored meeting from the sidebar, and says why a read failed',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      await openFromSidebar(page, PAST_MEETING.title);
      expect(await lineCount(page)).toBe(PAST_MEETING.lines.length);
      await expectNewestLineVisible(page);
      await qa.expectVisible(page, TITLE);
      expect(await page.locator('.meeting-page .page-meta').textContent()).toMatch(/ to /);
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Stored meeting',
        `past-${theme}-${width}`,
        `The standup from the sidebar (${theme}, ${width})`,
        'pass',
        `${PAST_MEETING.lines.length} lines from the store, newest in view; title, day and span in the header; listed in the sidebar and marked current; no sideways scroll; no console errors.`,
      );

      // Failure path: the store read fails. React's StrictMode (the preview is a dev build) runs
      // the page's effect twice, and LatestRead.readFor reads once for both: fail that one.
      await page.locator('.sidebar button', { hasText: 'Home' }).click();
      await qa.settle(page);
      await qa.failNextRequest(page, 'database is locked');
      await page.locator(`.recent-meetings-list button[title="${PAST_MEETING.title}"]`).click();
      await page.waitForSelector('.meeting-read-error');
      await qa.settle(page);
      await qa.expectVisible(page, '.meeting-read-error');
      expect(await page.locator('.meeting-read-error').textContent()).toContain(
        'Roger could not read this meeting on this Mac: database is locked',
      );
      expect(await titleOf(page)).toBe('Untitled meeting');
      qa.expectNoConsoleErrors(preview);
      await qa.expectNoPageOverflow(page);
      await gallery.shoot(
        page,
        'Read failed',
        `read-failed-${theme}-${width}`,
        `The store read fails (${theme}, ${width})`,
        'pass',
        'The reason in an alert with Try again; the page keeps its frame and live lines would still show.',
      );
      await page.locator('.meeting-read-error button', { hasText: 'Try again' }).click();
      await waitForTitle(page, PAST_MEETING.title);
      expect(await page.locator('.meeting-read-error').count()).toBe(0);
      expect(await lineCount(page)).toBe(PAST_MEETING.lines.length);
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'records a live call, keeps it through Stop and New note, and drops a meeting nobody spoke in',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      await openFromSidebar(page, LIVE_CALL.title);
      await qa.stopScenario(page);
      await qa.settle(page);
      await qa.expectVisible(page, '.meeting-phase-recording');
      await qa.expectVisible(page, '.meeting-header button.stop');
      await qa.expectVisible(page, '[aria-label="Capture status"]');
      expect(await page.locator('[aria-label="Capture status"]').textContent()).toContain(
        'Speech-to-text',
      );
      expect(await lineCount(page)).toBeGreaterThanOrEqual(LIVE_CALL_FIRST_LINES);
      await expectNewestLineVisible(page);
      await qa.expectVisible(page, '.recent-meetings-list .recording-dot');
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Live call',
        `live-${theme}-${width}`,
        `A call recording (${theme}, ${width})`,
        'pass',
        `Recording state and Stop in the header, the live meter, ${LIVE_CALL_FIRST_LINES}+ lines with the newest in view, the live dot in the sidebar.`,
      );

      // Stop on the page; then Roger's own stop notice (sleep, the cap) arrives, as main sends it.
      const linesBeforeStop = await lineCount(page);
      await page.locator('.meeting-header button.stop').click();
      await page.waitForFunction(() => document.querySelector('.meeting-phase') === null);
      await qa.settle(page);
      expect(await lineCount(page)).toBe(linesBeforeStop);
      const stopped = await page.evaluate(() => {
        if (window.roger === undefined) throw new Error('No window.roger: not the preview page');
        return window.roger.getCaptureStatus();
      });
      await qa.emitEvent(page, IpcChannel.CaptureStatusChanged, {
        ...stopped,
        notice: 'Stopped at 14:32 because the Mac went to sleep.',
      });
      await qa.settle(page);
      await qa.expectVisible(page, '.banner-slot .notice');
      expect(await page.locator('[aria-label="Capture status"]').textContent()).toContain(
        'Last recording',
      );
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'After Stop',
        `stopped-${theme}-${width}`,
        `After Stop, with Roger's stop notice (${theme}, ${width})`,
        'pass',
        'Every line stays (read again from the store), the meter becomes "Last recording", the stop notice shows above the page.',
      );

      // New note from this page: main names the next meeting before the shell opens it. Watch
      // this page meanwhile: M4-S1's placeholder ("Roger can show only the meeting it recorded
      // last...") must never show, nor this meeting with fewer lines.
      await page.evaluate(
        ({ title, lines }) => {
          const seen: AbWatch = {
            placeholder: false,
            fewestLinesWhileShown: Number.POSITIVE_INFINITY,
          };
          const check = (): void => {
            if (document.body.textContent.includes('can show only the meeting it recorded last')) {
              seen.placeholder = true;
            }
            if (document.querySelector('.meeting-page h1')?.textContent === title) {
              seen.fewestLinesWhileShown = Math.min(
                seen.fewestLinesWhileShown,
                document.querySelectorAll(lines).length,
              );
            }
          };
          new MutationObserver(check).observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          window.__abWatch = seen;
        },
        { title: LIVE_CALL.title, lines: LINES },
      );
      await page.locator('.sidebar-action', { hasText: 'New note' }).click();
      await page.waitForFunction(
        ({ selector, previous }) => {
          const title = document.querySelector(selector)?.textContent ?? '';
          return title.startsWith('Meeting ') && title !== previous;
        },
        { selector: TITLE, previous: LIVE_CALL.title },
      );
      await qa.settle(page);
      const watch = await page.evaluate(() => window.__abWatch);
      if (watch === undefined) throw new Error('The A/B watch was not installed');
      expect(watch.placeholder).toBe(false);
      expect(watch.fewestLinesWhileShown).toBe(linesBeforeStop);
      await qa.expectVisible(page, '.meeting-phase-recording');
      expect(await page.locator('.transcript .empty').textContent()).toBe(
        'Lines appear here as people speak.',
      );
      const newTitle = (await titleOf(page)) ?? '';
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'New note',
        `new-note-${theme}-${width}`,
        `New note opens the new meeting (${theme}, ${width})`,
        'pass',
        `Named by main ("${newTitle}"), recording, no lines yet. While it started, the last meeting's page kept all ${linesBeforeStop} lines and never showed M4-S1's placeholder (MutationObserver).`,
      );

      // Failure path: Stop before anyone spoke. Main deletes such a meeting, and so does the fake.
      await page.locator('.meeting-header button.stop').click();
      await waitForTitle(page, 'This meeting is not on this Mac');
      await qa.expectVisible(page, '.meeting-page .empty-state');
      expect(await page.locator(`.recent-meetings-list button[title="${newTitle}"]`).count()).toBe(
        0,
      );
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Nobody spoke',
        `nobody-spoke-${theme}-${width}`,
        `Stop before anyone spoke (${theme}, ${width})`,
        'pass',
        "The page says this Mac keeps no such meeting and why; the meeting leaves the recent list; M1's status panel stays for the recording just stopped (the preview's fake vendor has no meter).",
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'lists thirty meetings, opens one, and handles a meeting this Mac never had',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      if (width >= 680) {
        await qa.expectVisible(page, '.recent-meetings .sidebar-empty');
      }
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Empty Mac',
        `empty-${theme}-${width}`,
        `No meetings yet (${theme}, ${width})`,
        'pass',
        width >= 680
          ? '"No meetings yet" in the sidebar once main has answered.'
          : 'The top bar hides the empty note at this width (app.css), as before.',
      );

      // Thirty meetings, one a day back from today, played as main sends them; the newest is the
      // live-call fixture's, for a long title.
      const ids = await page.evaluate(
        ({ status, newest, channels }) => {
          const control = window.__rogerPreview;
          if (control === undefined) throw new Error('not the preview page');
          const played: string[] = [];
          for (let day = 0; day < 30; day += 1) {
            const meetingId = day === 0 ? newest : crypto.randomUUID();
            const start = new Date();
            start.setDate(start.getDate() - day);
            start.setHours(9, 0, 0, 0);
            control.emit(channels.status, {
              ...status,
              phase: 'recording',
              meetingId,
              startedAt: start.toISOString(),
            });
            control.emit(channels.segment, {
              id: crypto.randomUUID(),
              meetingId,
              source: 'system',
              speaker: 'them',
              startMs: 1200,
              endMs: 4800,
              text: `Notes from day ${day}: the renewal, the pricing page and who follows up.`,
              confidence: 0.9,
              words: null,
              createdAt: new Date(start.getTime() + 61_000).toISOString(),
            });
            control.emit(channels.status, status);
            played.push(meetingId);
          }
          return played;
        },
        {
          status: idleCaptureStatus({
            state: 'idle',
            pending: 0,
            rejected: 0,
            lastError: null,
            nextAttemptAt: null,
          }),
          newest: LIVE_CALL.meetingId,
          channels: {
            status: IpcChannel.CaptureStatusChanged,
            segment: IpcChannel.TranscriptSegment,
          },
        },
      );
      expect(ids).toHaveLength(30);
      await page.waitForFunction(
        () => document.querySelectorAll('.recent-meetings-list > li').length === 30,
      );
      await qa.settle(page);
      await qa.expectVisible(page, '.recent-meetings-list > li:first-child button', {
        within: '.recent-meetings-list',
      });
      // Settings stays reachable however long the list (the list scrolls by itself).
      await qa.expectVisible(page, '.sidebar-foot button');
      await qa.expectNoPageOverflow(page);
      const listScrolls = await page.evaluate(() => {
        const list = document.querySelector('.recent-meetings-list');
        if (list === null) return false;
        return list.scrollHeight > list.clientHeight || list.scrollWidth > list.clientWidth;
      });
      expect(listScrolls).toBe(true);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Thirty meetings',
        `thirty-${theme}-${width}`,
        `Thirty meetings in the sidebar (${theme}, ${width})`,
        'pass',
        width >= 680
          ? 'Newest first, the long title cut short, days as labels; the list scrolls by itself, Settings stays at the bottom.'
          : 'A strip that scrolls sideways between Home and Settings; no sideways page scroll.',
      );

      // One from three weeks back: the list scrolls it into reach, the page shows its one line.
      const old = page.locator('.recent-meetings-list > li').nth(20).locator('button');
      const oldTitle = (await old.getAttribute('title')) ?? '';
      await old.click();
      await waitForTitle(page, oldTitle);
      expect(await lineCount(page)).toBe(1);
      expect(await page.locator('.meeting-page .page-meta').textContent()).toMatch(
        /9:00(\s?AM)? to 9:01(\s?AM)?$/,
      );
      expect(
        await page
          .locator('.recent-meetings-list button[aria-current="page"]')
          .getAttribute('title'),
      ).toBe(oldTitle);
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Thirty meetings',
        `old-meeting-${theme}-${width}`,
        `A meeting from three weeks back (${theme}, ${width})`,
        'pass',
        'Opened from the list: its day and span, its one line, marked current in the sidebar.',
      );

      // Failure path: main opens a meeting this Mac does not have (a link to a deleted one).
      await qa.emitEvent(page, IpcChannel.AppNavigate, `meeting/${crypto.randomUUID()}`);
      await waitForTitle(page, 'This meeting is not on this Mac');
      await qa.expectVisible(page, '.meeting-page .empty-state');
      expect(await page.locator('.meeting-page .transcript').count()).toBe(0);
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'Not on this Mac',
        `unknown-${theme}-${width}`,
        `A meeting this Mac never had (${theme}, ${width})`,
        'pass',
        'Opened through app:navigate: the page says so and why, with no transcript.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'reads a meeting while the API is offline: the store is on this Mac',
  async () => {
    for (const { theme, width } of combos()) {
      const preview = await run.open({ scenario: 'api-offline', theme, width });
      const { page } = preview;
      await openFromSidebar(page, PAST_MEETING.title);
      expect(await lineCount(page)).toBe(PAST_MEETING.lines.length);
      await qa.expectNoPageOverflow(page);
      qa.expectNoConsoleErrors(preview);
      await gallery.shoot(
        page,
        'API offline',
        `offline-${theme}-${width}`,
        `The API offline (${theme}, ${width})`,
        'pass',
        'The meeting and the recent list read from this Mac while every API request fails.',
      );
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);
