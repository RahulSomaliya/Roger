import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { LIVE_CALL, LIVE_CALL_FIRST_LINES, PAST_MEETING } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { CaptureStatus, TranscriptSegmentChange } from '../src/shared/capture';
import { captureChannels } from '../src/shared/ipc/capture';
import type { AudioSource, TranscriptSegment } from '../src/shared/transcript';

/**
 * M3-T9's browser QA: the live transcript and the jargon list where M3-T9 mounts them, in the real
 * shell (the meeting page's transcript region, the Settings page), both themes, 1440 and 390 wide,
 * through the preview (qa/README.md). A 500-line call with an interim, reading back with "Jump to
 * live" while lines and a capture error arrive, an echo line hidden and shown, Stop with Roger's
 * stop notice (the last line stays in view), a new meeting's empty transcript, a past meeting,
 * the store failing while a call records, saving the list, and the API failing it. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/m3-t9.qa.e2e.ts
 */

declare global {
  interface Window {
    /** While true, the page's store reads fail as main's would (failStoreReads). */
    __m3t9FailReads?: boolean;
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M3-T9 live transcript and jargon list in the app', 'm3-t9');
const FLOW_TIMEOUT_MS = 300_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m3-t9', Task: 'M3-T9 mount the transcript and the editor' });
});

const PAGE_PANEL = '.meeting-page .live-transcript';
const LINES = `${PAGE_PANEL} .live-transcript-lines`;
const FINALS = `${LINES} > p[data-segment-id]`;
const INTERIMS = `${LINES} > p[data-interim]`;
const JUMP = `${PAGE_PANEL} .jump-to-live`;
const TITLE = '.meeting-page h1';
const STOP = '.meeting-header button.stop';
const NOTICE = '.banner-slot .notice';
const STAND_IN = '.qa-show-hidden input';
const STOP_NOTICE = 'Stopped at 14:32 because the Mac went to sleep.';

/**
 * A renderer file as the preview serves it: Vite serves files outside its root (preview/) as
 * `/@fs/<real path>`, the URL the app itself imports them from, so an import of it in the page
 * gets the app's own module, not a copy.
 */
function servedUrl(path: string): string {
  return `/@fs${realpathSync(fileURLToPath(new URL(path, import.meta.url)))}`;
}

const RENDERER_ENTRY_URL = servedUrl('../src/renderer/src/main.tsx');
const SLOTS_URL = servedUrl('../src/renderer/src/app/slots.ts');
const USE_MEETING_URL = servedUrl('../src/renderer/src/meeting/useMeeting.ts');

function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

async function waitForTitle(page: Page, title: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, wanted }) => document.querySelector(selector)?.textContent === wanted,
    { selector: TITLE, wanted: title },
  );
  await qa.settle(page);
}

/** Opens a meeting from the sidebar, as a person would. */
async function clickInSidebar(page: Page, title: string): Promise<void> {
  const selector = `.recent-meetings-list button[title="${title}"]`;
  await qa.expectVisible(page, selector, { within: '.recent-meetings-list' });
  await page.locator(selector).click();
}

async function count(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

/**
 * Marks the newest final line, which no CSS selector picks while an interim follows it, so
 * qa.expectVisible can check it. Returns its id.
 */
async function markNewestFinal(page: Page): Promise<string> {
  return page.evaluate((finals) => {
    const all = document.querySelectorAll(finals);
    for (const line of all) line.removeAttribute('data-qa-newest');
    const newest = all.item(all.length - 1);
    newest.setAttribute('data-qa-newest', '');
    const id = newest.getAttribute('data-segment-id');
    if (id === null) throw new Error('the newest final line has no id');
    return id;
  }, FINALS);
}

/**
 * Where the newest final line sits in the transcript's scroll box, without the viewport: whether
 * the whole line is inside the box, and how far the box is from its bottom. On a narrow window
 * the shell's column scrolls, so a check against the viewport would test the column instead.
 */
async function newestLineInBox(page: Page): Promise<{ inside: boolean; fromBottom: number }> {
  await markNewestFinal(page);
  return page.evaluate((lines) => {
    const box = document.querySelector(lines);
    const line = document.querySelector('[data-qa-newest]');
    if (box === null || line === null) throw new Error('no transcript or no final line');
    const area = box.getBoundingClientRect();
    const row = line.getBoundingClientRect();
    return {
      inside: row.top >= area.top - 0.5 && row.bottom <= area.bottom + 0.5,
      fromBottom: box.scrollHeight - box.clientHeight - box.scrollTop,
    };
  }, LINES);
}

type Speaker = 'Me' | 'Them';

/**
 * A speaker's lines as M2-T13's Electron smoke test finds them (`linesOf` in e2e/capture.e2e.ts):
 * by the region's label and the speaker's word, never by class. That test needs Electron on a Mac,
 * so this browser QA checks its locator against LiveTranscript too; keep the two in step.
 */
function smokeTestLines(page: Page, speaker: Speaker): Locator {
  return page
    .locator('[aria-label="Transcript"] p')
    .filter({ has: page.getByText(speaker, { exact: true }) });
}

/**
 * How many of a speaker's lines a person could see, counted as the smoke test counts them after
 * Stop (`visibleLines` in e2e/capture.e2e.ts): the line has a size, its centre is inside the
 * viewport, and `document.elementFromPoint` there is the line or inside it.
 */
function visibleSmokeTestLines(page: Page, speaker: Speaker): Promise<number> {
  return smokeTestLines(page, speaker).evaluateAll(
    (lines) =>
      lines.filter((line) => {
        const box = line.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top !== null && (top === line || line.contains(top));
      }).length,
  );
}

async function scrollTopOf(page: Page): Promise<number> {
  return page.locator(LINES).evaluate((box) => box.scrollTop);
}

/** Scrolls the transcript up with the mouse wheel, as a reader would, until it pauses. */
async function readBack(page: Page): Promise<void> {
  const area = await page.locator(LINES).boundingBox();
  if (area === null) throw new Error('the transcript has no box to scroll');
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(0, -2400);
  await page.waitForSelector(JUMP);
  await qa.settle(page);
}

/** The newest line main has stored for a meeting, as the page's store read answers it. */
async function lastStoredLine(page: Page, meetingId: string): Promise<TranscriptSegment> {
  const meeting = await page.evaluate(
    (id) => window.roger.getMeeting({ meetingId: id }),
    meetingId,
  );
  const last = meeting?.segments.at(-1);
  if (last === undefined) throw new Error(`meeting ${meetingId} has no stored line`);
  return last;
}

/**
 * Sends new final lines for a meeting, as main does while it records: after its last stored
 * line, Them then Me in turn, the last one Me (the one an echo check can hide). Returns them.
 */
async function sayLines(
  page: Page,
  meetingId: string,
  texts: string[],
): Promise<TranscriptSegment[]> {
  const last = await lastStoredLine(page, meetingId);
  let cursorMs = last.endMs + 600;
  const lines = texts.map((text, index): TranscriptSegment => {
    const source: AudioSource = (texts.length - 1 - index) % 2 === 0 ? 'mic' : 'system';
    const startMs = cursorMs;
    const endMs = startMs + 2400;
    cursorMs = endMs + 500;
    return {
      id: crypto.randomUUID(),
      meetingId,
      source,
      speaker: source === 'mic' ? 'me' : 'them',
      startMs,
      endMs,
      text,
      confidence: 0.93,
      words: null,
      createdAt: new Date().toISOString(),
    };
  });
  for (const line of lines) await qa.emitEvent(page, captureChannels.TranscriptSegment, line);
  await qa.settle(page);
  return lines;
}

/** Main's echo filter changing a line it has sent (M2's `transcript:segment-changed`). */
async function echoChange(
  page: Page,
  line: TranscriptSegment,
  change: TranscriptSegmentChange['change'],
  echoOf: string | null,
): Promise<void> {
  const payload: TranscriptSegmentChange = {
    meetingId: line.meetingId,
    segmentId: line.id,
    source: line.source,
    change,
    reason: 'echo',
    echoOf,
    text: line.text,
  };
  await qa.emitEvent(page, captureChannels.TranscriptSegmentChanged, payload);
  await qa.settle(page);
}

async function currentStatus(page: Page): Promise<CaptureStatus> {
  return page.evaluate(() => window.roger.getCaptureStatus());
}

async function sendStatus(page: Page, status: CaptureStatus): Promise<void> {
  await qa.emitEvent(page, captureChannels.CaptureStatusChanged, status);
  await qa.settle(page);
}

/**
 * Mounts a stand-in for M2-T20b's "show hidden lines" control (wave 8) in the meeting page's
 * `meetingAudioNote` slot: a checkbox on the page's own showHidden (useMeetingView), the state
 * M3-T9's slot hands the panel. Before the meeting page renders: the page reads its slots when it
 * renders. React must be the very module the app loaded (the URL with Vite's version hash), or
 * the hook runs against a second React and throws; the renderer's entry imports it, so its served
 * text names it. The code is a string, not a function: Vitest rewrites every `import()` in this
 * file for Node, and the page would get the rewrite.
 */
async function mountShowHiddenStandIn(page: Page): Promise<void> {
  const reactUrl = await page.evaluate(async (entry) => {
    const source = await (await fetch(entry)).text();
    const match = /"([^"]*\/deps\/react\.js\?v=[^"]+)"/.exec(source);
    if (match?.[1] === undefined) throw new Error(`${entry} imports no react through Vite's cache`);
    return match[1];
  }, RENDERER_ENTRY_URL);
  await page.evaluate(`(async () => {
    const [react, { slots }, { useMeetingView }] = await Promise.all([
      import(${JSON.stringify(reactUrl)}),
      import(${JSON.stringify(SLOTS_URL)}),
      import(${JSON.stringify(USE_MEETING_URL)}),
    ]);
    const { createElement } = react.default;
    function ShowHiddenStandIn() {
      const view = useMeetingView();
      return createElement(
        'label',
        { className: 'qa-show-hidden' },
        createElement('input', {
          type: 'checkbox',
          checked: view.showHidden,
          onChange: (event) => view.setShowHidden(event.target.checked),
        }),
        ' Show hidden lines (QA stand-in for M2-T20b)',
      );
    }
    if (!slots.meetingAudioNote.some((entry) => entry.id === 'qa-show-hidden')) {
      slots.meetingAudioNote.push({ id: 'qa-show-hidden', order: 99, component: ShowHiddenStandIn });
    }
  })()`);
}

/** Takes the stand-in out again; the page drops it at its next render. */
async function unmountShowHiddenStandIn(page: Page): Promise<void> {
  await page.evaluate(`import(${JSON.stringify(SLOTS_URL)}).then(({ slots }) => {
    const at = slots.meetingAudioNote.findIndex((entry) => entry.id === 'qa-show-hidden');
    if (at >= 0) slots.meetingAudioNote.splice(at, 1);
  })`);
}

/**
 * Makes the page's store reads (`meetings:get`) fail while `__m3t9FailReads` is true, with the
 * text Electron gives the renderer for a handler that threw (qa/README.md). Not failNextRequest:
 * Stop's own request would take that failure, not the read after it.
 */
async function failStoreReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const roger = window.roger;
    const read = roger.getMeeting.bind(roger);
    window.__m3t9FailReads = true;
    roger.getMeeting = (request) =>
      window.__m3t9FailReads === true
        ? Promise.reject(
            new Error(
              "Error invoking remote method 'meetings:get': Error: database disk image is malformed",
            ),
          )
        : read(request);
  });
}

/** The page's state checks every shot shares: fits the width, nothing logged. */
async function shoot(
  preview: qa.PreviewPage,
  group: string,
  name: string,
  caption: string,
  note: string,
): Promise<void> {
  await qa.expectNoPageOverflow(preview.page);
  qa.expectNoConsoleErrors(preview);
  await gallery.shoot(preview.page, group, name, caption, 'pass', note);
}

it(
  'shows a live call in the meeting page, through reading back, an echo line and Stop',
  async () => {
    for (const { theme, width } of combos()) {
      const shot = `${theme}-${width}`;
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      try {
        await mountShowHiddenStandIn(page);
        await clickInSidebar(page, LIVE_CALL.title);
        await waitForTitle(page, LIVE_CALL.title);
        // The call's interim before the page opened went to no one (the hub keeps no event):
        // stop once the next line's has come, so the still frame has one.
        await page.waitForSelector(INTERIMS);
        await qa.stopScenario(page);
        await qa.settle(page);

        // Live: every line so far, the newest in view, the next one's interim grey below it.
        expect(await count(page, FINALS)).toBeGreaterThanOrEqual(LIVE_CALL_FIRST_LINES);
        expect(await count(page, INTERIMS)).toBe(1);
        expect(await page.locator(PAGE_PANEL).getAttribute('data-following')).toBe('true');
        expect(await count(page, JUMP)).toBe(0);
        // M2-T13's Electron smoke test finds lines by these: the region's label, a speaker word.
        for (const speaker of ['Me', 'Them'] as const) {
          expect(await smokeTestLines(page, speaker).count()).toBeGreaterThan(0);
        }
        await qa.fitShellPage(page);
        await markNewestFinal(page);
        await qa.expectVisible(page, '[data-qa-newest]', { within: LINES });
        await qa.expectVisible(page, INTERIMS, { within: LINES });
        await shoot(
          preview,
          'Live call',
          `live-${shot}`,
          `A call recording, on its meeting page (${theme}, ${width})`,
          `${LIVE_CALL_FIRST_LINES}+ lines from the store and live; the newest in view with the next line's interim grey below it; following, so no Jump to live.`,
        );

        // Reading back: new lines and a capture error banner leave the reader's place alone.
        await readBack(page);
        const readingAt = await scrollTopOf(page);
        // Me, Them, then Me repeating Them: the mic heard the call on the laptop's speakers.
        const said = await sayLines(page, LIVE_CALL.meetingId, [
          'Procurement wants the renewal signed before the quarter closes.',
          'Then we send the order form to Northwind Traders today.',
          'we send the order form to Northwind Traders today',
        ]);
        const recording = await currentStatus(page);
        await sendStatus(page, {
          ...recording,
          error: 'Speech-to-text for Them stopped: the vendor closed the session. Reconnecting.',
        });
        await qa.expectVisible(page, '.banner-slot [role="alert"]');
        expect(await scrollTopOf(page)).toBe(readingAt);
        await qa.expectVisible(page, JUMP, { within: PAGE_PANEL });
        await shoot(
          preview,
          'Reading back',
          `reading-${shot}`,
          `Scrolled up while lines and a capture error arrive (${theme}, ${width})`,
          'Three new lines arrived and an error banner took height from the page: the view stayed where the reader scrolled, and Jump to live is offered.',
        );
        await sendStatus(page, recording);

        // Jump to live: the newest of the new lines comes into view.
        await page.locator(JUMP).click();
        await page.waitForSelector(JUMP, { state: 'detached' });
        await qa.settle(page);
        expect(await markNewestFinal(page)).toBe(said.at(-1)?.id);
        await qa.expectVisible(page, '[data-qa-newest]', { within: LINES });

        // An echo line: hidden by main's echo filter, shown marked with the page's showHidden.
        const echo = said[2];
        const original = said[1];
        if (echo === undefined || original === undefined) throw new Error('sayLines said too few');
        const echoRow = `${LINES} > p[data-segment-id="${echo.id}"]`;
        await echoChange(page, echo, 'hidden', original.id);
        expect(await count(page, echoRow)).toBe(0);
        await page.locator(STAND_IN).check();
        await qa.settle(page);
        expect(await page.locator(echoRow).getAttribute('data-echo')).toBe('hidden');
        expect(await page.locator(`${echoRow} .transcript-line-echo`).textContent()).toBe('echo');
        await qa.expectVisible(page, echoRow, { within: LINES });
        await shoot(
          preview,
          'Echo line',
          `echo-shown-${shot}`,
          `A line the echo filter hid, shown again (${theme}, ${width})`,
          'Hidden by main (transcript:segment-changed), then shown with the page\'s showHidden through the slot (checkbox: a QA stand-in for M2-T20b\'s control), greyed and marked "echo".',
        );
        await page.locator(STAND_IN).uncheck();
        await qa.settle(page);
        expect(await count(page, echoRow)).toBe(0);
        await echoChange(page, echo, 'unhidden', null);
        expect(await count(page, echoRow)).toBe(1);
        expect(await page.locator(echoRow).getAttribute('data-echo')).toBeNull();
        await unmountShowHiddenStandIn(page);

        // Stop, then Roger's stop notice above the page: the region gets shorter, and the
        // newest line must stay in view (the panel follows its size, not only new lines).
        const linesBeforeStop = await count(page, FINALS);
        await page.locator(STOP).click();
        await page.waitForFunction(() => document.querySelector('.meeting-phase') === null);
        await qa.settle(page);
        expect(await count(page, FINALS)).toBe(linesBeforeStop);
        expect(await count(page, STAND_IN)).toBe(0);
        const heightBefore = await page.locator(LINES).evaluate((box) => box.clientHeight);
        const stopped = await currentStatus(page);
        await sendStatus(page, { ...stopped, notice: STOP_NOTICE });
        await qa.expectVisible(page, NOTICE);
        const heightAfter = await page.locator(LINES).evaluate((box) => box.clientHeight);
        const placed = await newestLineInBox(page);
        expect(
          placed.inside,
          `newest line inside the box (box ${heightBefore} -> ${heightAfter} px)`,
        ).toBe(true);
        expect(placed.fromBottom).toBeLessThanOrEqual(1);
        await qa.fitShellPage(page);
        await qa.expectVisible(page, '[data-qa-newest]', { within: LINES });
        // The smoke test's checks after Stop, on its own locator: it finds exactly the final rows
        // of each side (each drawn once, no interim, no empty text), and a person can see a line
        // of each side in the scroll box.
        const seen = { Me: 0, Them: 0 };
        for (const [speaker, side] of [
          ['Me', 'me'],
          ['Them', 'them'],
        ] as const) {
          expect(await smokeTestLines(page, speaker).count()).toBe(
            await count(page, `${FINALS}[data-speaker="${side}"]`),
          );
          seen[speaker] = await visibleSmokeTestLines(page, speaker);
          expect(seen[speaker], `a ${speaker} line a person can see`).toBeGreaterThan(0);
        }
        await shoot(
          preview,
          'After Stop',
          `stopped-${shot}`,
          `After Stop, with Roger's stop notice (${theme}, ${width})`,
          `Every line kept (${linesBeforeStop}). The notice took height from the page (transcript box ${heightBefore} to ${heightAfter} px) and the newest line stayed in view, the box at its bottom. M2-T13's smoke-test locator finds exactly the final rows of each side; ${seen.Me} Me and ${seen.Them} Them lines on screen.`,
        );

        // New note: the next meeting's transcript, empty until someone speaks.
        await page.locator('.sidebar-action', { hasText: 'New note' }).click();
        // Main names a meeting it starts "Meeting 7 Oct 2026 09:30", and so does the fake.
        await page.waitForFunction(
          (selector) =>
            document.querySelector(selector)?.textContent.startsWith('Meeting ') === true,
          TITLE,
        );
        await qa.settle(page);
        await qa.fitShellPage(page);
        await qa.expectVisible(page, `${LINES} .live-transcript-empty`, { within: LINES });
        expect(await page.locator(`${LINES} .live-transcript-empty`).textContent()).toBe(
          'Listening. Lines appear here as people speak.',
        );
        await shoot(
          preview,
          'New meeting',
          `new-meeting-${shot}`,
          `A new meeting before anyone speaks (${theme}, ${width})`,
          'Recording, no lines yet: the transcript says it is listening.',
        );
      } finally {
        await preview.close();
      }
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'shows a past meeting from its start, and keeps the lines heard live when the store fails',
  async () => {
    for (const { theme, width } of combos()) {
      const shot = `${theme}-${width}`;
      const past = await run.open({ scenario: 'past-meeting', theme, width });
      try {
        await clickInSidebar(past.page, PAST_MEETING.title);
        await waitForTitle(past.page, PAST_MEETING.title);
        expect(await count(past.page, FINALS)).toBe(PAST_MEETING.lines.length);
        expect(await count(past.page, INTERIMS)).toBe(0);
        expect(await count(past.page, JUMP)).toBe(0);
        expect(await scrollTopOf(past.page)).toBe(0);
        await qa.fitShellPage(past.page);
        await qa.expectVisible(past.page, `${FINALS}:first-child`, { within: LINES });
        await shoot(
          past,
          'Past meeting',
          `past-${shot}`,
          `A past meeting from the sidebar (${theme}, ${width})`,
          `${PAST_MEETING.lines.length} stored lines from the first one; not live, so it neither follows nor offers Jump to live.`,
        );
      } finally {
        await past.close();
      }

      // Failure path: every store read fails while the call records and after Stop.
      const live = await run.open({ scenario: 'live-call', theme, width });
      const { page } = live;
      try {
        await failStoreReads(page);
        await clickInSidebar(page, LIVE_CALL.title);
        await waitForTitle(page, 'Could not read this meeting');
        // The store's lines are unread, so only those heard live since the page opened show.
        await page.waitForFunction(
          (finals) => document.querySelectorAll(finals).length >= 6,
          FINALS,
        );
        await qa.stopScenario(page);
        await qa.settle(page);
        const heard = await count(page, FINALS);
        expect(heard).toBeLessThan(LIVE_CALL_FIRST_LINES);
        await page.locator(STOP).click();
        await page.waitForFunction(() => document.querySelector('.meeting-phase') === null);
        await qa.settle(page);
        await qa.expectVisible(page, '.meeting-read-error');
        expect(await page.locator('.meeting-read-error').textContent()).toContain(
          'Roger could not read this meeting on this Mac: database disk image is malformed',
        );
        expect(await count(page, '.meeting-page .empty-state')).toBe(0);
        expect(await count(page, FINALS)).toBe(heard);
        await qa.fitShellPage(page);
        await markNewestFinal(page);
        await qa.expectVisible(page, '[data-qa-newest]', { within: LINES });
        await shoot(
          live,
          'Store reads fail',
          `reads-fail-${shot}`,
          `Every store read fails, during the call and after Stop (${theme}, ${width})`,
          `The alert with Try again; the ${heard} lines the page heard live stay after Stop instead of "The transcript shows here once Roger can read this meeting".`,
        );

        await page.evaluate(() => {
          window.__m3t9FailReads = false;
        });
        await page.locator('.meeting-read-error button', { hasText: 'Try again' }).click();
        await waitForTitle(page, LIVE_CALL.title);
        expect(await count(page, '.meeting-read-error')).toBe(0);
        expect(await count(page, FINALS)).toBeGreaterThanOrEqual(LIVE_CALL_FIRST_LINES + heard);
        qa.expectNoConsoleErrors(live);
      } finally {
        await live.close();
      }
    }
  },
  FLOW_TIMEOUT_MS,
);

it(
  'saves the jargon list from Settings, and says why the API refused it',
  async () => {
    for (const { theme, width } of combos()) {
      const shot = `${theme}-${width}`;
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await page
          .locator('nav.sidebar')
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
        await page.waitForSelector('.vocabulary .vocabulary-editor');
        await qa.settle(page);
        // Mounted once, by M3-T9's slot: no second section, and no QA mount any more.
        expect(await count(page, '.vocabulary')).toBe(1);

        await page.fill('.vocabulary-input', 'Linkt, Northwind Traders, Priya Raman');
        await page.press('.vocabulary-input', 'Enter');
        await qa.settle(page);
        await qa.fitShellPage(page);
        await qa.expectVisible(page, '.vocabulary-save');
        await page.click('.vocabulary-save');
        await page.waitForFunction(
          () => document.querySelector('.vocabulary-save-status')?.textContent !== 'Saving\u2026',
        );
        await qa.settle(page);
        expect(await page.locator('.vocabulary-save-status').textContent()).toBe(
          'Saved. New recordings use this list.',
        );
        const stored = await page.evaluate(() => window.roger.getVocabulary());
        for (const term of ['Linkt', 'Northwind Traders', 'Priya Raman']) {
          expect(stored).toContain(term);
        }
        await qa.fitShellPage(page);
        await shoot(
          preview,
          'Jargon list',
          `saved-${shot}`,
          `The jargon list in Settings, saved (${theme}, ${width})`,
          "Mounted by M3-T9's settings slot; three terms added and saved through the API.",
        );

        // Failure path: the API goes away, and Save says why and keeps the change.
        await qa.setApiOffline(page, true);
        await page.click('button[aria-label="Remove Priya Raman"]');
        await qa.fitShellPage(page);
        await page.click('.vocabulary-save');
        await page.waitForSelector('.vocabulary-editor .error');
        await qa.settle(page);
        await qa.fitShellPage(page);
        await qa.expectVisible(page, '.vocabulary-editor .error');
        const failure = (await page.locator('.vocabulary-editor .error').textContent()) ?? '';
        expect(failure).toContain('save the jargon list: PUT /v1/vocabulary failed');
        expect(await count(page, 'button[aria-label="Remove Priya Raman"]')).toBe(0);
        expect(await page.locator('.vocabulary-save').isDisabled()).toBe(false);
        await shoot(
          preview,
          'Jargon list',
          `save-failed-${shot}`,
          `Save while the API is offline (${theme}, ${width})`,
          'The reason shows; the removal of Priya Raman is kept and Save stays on to retry.',
        );
      } finally {
        await preview.close();
      }
    }
  },
  FLOW_TIMEOUT_MS,
);
