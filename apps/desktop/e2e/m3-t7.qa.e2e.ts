import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import type * as ReactNamespace from 'react';
import type * as ReactDomClient from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { TranscriptSegmentChange } from '../src/shared/capture';
import { captureChannels } from '../src/shared/ipc/capture';
import {
  type AudioSource,
  type InterimTranscript,
  SPEAKER_FOR_SOURCE,
  type TranscriptSegment,
} from '../src/shared/transcript';

/*
 * Browser QA for M3-T7's transcript panel (qa/README.md): both themes, 1440 and 390 wide, a
 * 500-line live call, reading back with "Jump to live", an echo line shown again, a past meeting,
 * the empty states, and a failure path (another meeting's events, a hide before its line, a stale
 * interim).
 *
 * Nothing mounts LiveTranscript in the app until M3-T9, so this script mounts it alone on the
 * preview's `empty-mac` page, in the meeting page's frame (app.css `.meeting-page`), with the
 * app's styles and theme, and drives it through the preview's fake `window.roger`: the events the
 * panel gets are the ones main sends. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m3-t7.qa.e2e.ts
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
/** Vite serves files outside the preview root under /@fs/ plus their absolute path. */
const servedAt = (path: string): string => `/@fs${SOURCE_ROOT}${path}`;
const RENDERER_ENTRY_URL = servedAt('renderer/src/main.tsx');
const PANEL_URL = servedAt('renderer/src/transcript/LiveTranscript.tsx');
const NAVIGATOR_URL = servedAt('renderer/src/transcript/transcriptNavigator.ts');

/**
 * LiveTranscript's props (src/renderer/src/transcript/LiveTranscript.tsx), restated: that file is
 * JSX and reads the renderer's `window.roger` type, neither of which this program (tsconfig.e2e)
 * has. Change both together.
 */
interface PanelProps {
  meetingId: string;
  storedLines: readonly TranscriptSegment[];
  showHidden: boolean;
  live: boolean;
}

interface PanelHarness {
  render(props: PanelProps, title: string): void;
}

declare global {
  interface Window {
    __m3t7?: { modules: unknown[]; harness?: PanelHarness };
  }
}

/** A CommonJS package as Vite's dependency cache serves it: its exports on `default`. */
interface CommonJsModule<T> {
  default: T;
}

/**
 * Mounts the panel on the preview page, over the hidden app. React and ReactDOM must be the very
 * modules the app loaded (the URLs with Vite's version hash), or the panel's hooks run against a
 * second React and throw; the renderer's entry imports both, so its served text names them.
 */
async function mountHarness(page: Page): Promise<void> {
  const reactUrls = await page.evaluate(async (entry) => {
    const source = await (await fetch(entry)).text();
    const find = (name: string): string => {
      const match = new RegExp(`"([^"]*/deps/${name}\\.js\\?v=[^"]+)"`).exec(source);
      if (match?.[1] === undefined) {
        throw new Error(`${entry} imports no ${name} through Vite's dependency cache`);
      }
      return match[1];
    };
    return [find('react'), find('react-dom_client')];
  }, RENDERER_ENTRY_URL);
  // A string, not a function: Vitest rewrites every import() in this file for Node
  // (`__vite_ssr_dynamic_import__`), and page.evaluate sends a function as its compiled text, so
  // the page would get the rewrite and throw a ReferenceError.
  const urls = JSON.stringify([...reactUrls, PANEL_URL, NAVIGATOR_URL]);
  await page.evaluate(
    `Promise.all(${urls}.map((url) => import(url))).then((modules) => { window.__m3t7 = { modules }; })`,
  );
  await page.evaluate(() => {
    const loaded = window.__m3t7;
    if (loaded === undefined) throw new Error('The panel modules did not load');
    const [reactModule, domModule, panelModule, navigatorModule] = loaded.modules as [
      CommonJsModule<typeof ReactNamespace>,
      CommonJsModule<typeof ReactDomClient>,
      { LiveTranscript: ReactNamespace.ComponentType<PanelProps> },
      { CitationNavigatorProvider: ReactNamespace.ComponentType<{ children?: unknown }> },
    ];
    const { createElement } = reactModule.default;
    const app = document.getElementById('root');
    if (app !== null) app.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'm3-t7-harness';
    // The shell page's box: as tall as the window, with its gutters. No colour: the page's own.
    host.style.cssText = 'height: 100vh; padding: 24px 16px; box-sizing: border-box;';
    document.body.append(host);
    const root = domModule.default.createRoot(host);
    loaded.harness = {
      render: (props, title) => {
        root.render(
          createElement(
            'div',
            { className: 'meeting-page' },
            createElement(
              'header',
              { className: 'page-header' },
              createElement('h1', { className: 'page-title' }, title),
            ),
            createElement(navigatorModule.CitationNavigatorProvider, {
              children: createElement(panelModule.LiveTranscript, props),
            }),
          ),
        );
      },
    };
  });
}

async function renderPanel(page: Page, props: PanelProps, title: string): Promise<void> {
  await page.evaluate(
    ({ next, heading }) => {
      const harness = window.__m3t7?.harness;
      if (harness === undefined) throw new Error('The panel harness is not mounted');
      harness.render(next, heading);
    },
    { next: props, heading: title },
  );
  // The panel subscribes in an effect; the preview's hub drops events nobody listens to yet.
  await qa.settle(page);
}

type MainEvent =
  | { channel: typeof captureChannels.TranscriptSegment; payload: TranscriptSegment }
  | { channel: typeof captureChannels.TranscriptInterim; payload: InterimTranscript }
  | { channel: typeof captureChannels.TranscriptSegmentChanged; payload: TranscriptSegmentChange };

/** Sends main's events in one go, as one IPC burst would arrive. */
async function emitAll(page: Page, events: readonly MainEvent[]): Promise<void> {
  await page.evaluate((burst) => {
    const control = window.__rogerPreview;
    if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
    for (const { channel, payload } of burst) control.emit(channel, payload);
  }, events);
}

const final = (segment: TranscriptSegment): MainEvent => ({
  channel: captureChannels.TranscriptSegment,
  payload: segment,
});

const interimOf = (segment: TranscriptSegment, words: number): MainEvent => ({
  channel: captureChannels.TranscriptInterim,
  payload: {
    meetingId: segment.meetingId,
    source: segment.source,
    text: segment.text.split(/\s+/).slice(0, words).join(' '),
    startMs: segment.startMs,
    endMs: segment.startMs + words * MS_PER_WORD,
  },
});

const changeOf = (
  segment: TranscriptSegment,
  change: TranscriptSegmentChange['change'],
  echoOf: string | null,
): MainEvent => ({
  channel: captureChannels.TranscriptSegmentChanged,
  payload: {
    meetingId: segment.meetingId,
    segmentId: segment.id,
    source: segment.source,
    change,
    reason: 'echo',
    echoOf,
    text: segment.text,
  },
});

/** About 330 ms a word with a pause between lines, as the preview's live call times its lines. */
const MS_PER_WORD = 330;
const PAUSE_MS = 450;

function segment(
  meetingId: string,
  line: number,
  source: AudioSource,
  startMs: number,
  text: string,
): TranscriptSegment {
  const words = text.split(/\s+/).length;
  return {
    id: segmentIdForLine(meetingId, line),
    meetingId,
    source,
    speaker: SPEAKER_FOR_SOURCE[source],
    startMs,
    endMs: startMs + Math.max(900, words * MS_PER_WORD),
    text,
    confidence: 0.92,
    words: null,
    createdAt: '2026-10-06T10:00:00.000Z',
  };
}

/** The live call's first `count` lines: its script, round and round, timed from the start. */
function liveCallLines(count: number): TranscriptSegment[] {
  const lines: TranscriptSegment[] = [];
  let cursorMs = PAUSE_MS;
  for (let line = 1; line <= count; line += 1) {
    const script = LIVE_CALL.script[(line - 1) % LIVE_CALL.script.length];
    if (script === undefined) throw new Error('live-call.json has no lines');
    const next = segment(LIVE_CALL.meetingId, line, script.source, cursorMs, script.text);
    lines.push(next);
    cursorMs = next.endMs + PAUSE_MS;
  }
  return lines;
}

const PAST_LINES: TranscriptSegment[] = PAST_MEETING.lines.map((line, index) => ({
  ...segment(PAST_MEETING.meetingId, index + 1, line.source, line.startMs, line.text),
  endMs: line.endMs,
}));

const FIRST_LINES = 500;
const LONG_LINK =
  'The countersigned copy is at https://northwind.example.com/legal/contracts/2026/renewal/data-processing-addendum-v7-final-countersigned-by-procurement.pdf if anyone needs it.';

/**
 * Waits two animation frames: the panel draws events once per frame, so a check that something
 * did NOT appear must give it that frame first, or it passes on a panel that has not drawn yet.
 */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

const rowsIn = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll('.live-transcript [data-segment-id]').length);

async function waitForRows(page: Page, rows: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.live-transcript [data-segment-id]').length === count,
    rows,
  );
}

async function following(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector('.live-transcript')?.getAttribute('data-following') === 'true',
  );
}

/** Pixels between the log's view and its last line: 0 when it shows the newest line. */
function distanceFromBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const log = document.querySelector('.live-transcript-lines');
    if (log === null) throw new Error('No transcript log on the page');
    return log.scrollHeight - log.clientHeight - log.scrollTop;
  });
}

/** Fails unless `selector`'s computed `color` is the theme token `token` as the page resolves it. */
async function expectTokenColour(page: Page, selector: string, token: string): Promise<void> {
  const [actual, expected] = await page.evaluate(
    ({ target, name }) => {
      const element = document.querySelector(target);
      const parent = element?.parentElement ?? null;
      if (element === null || parent === null) {
        throw new Error(`No ${target} to read a colour from`);
      }
      // A probe beside it, so the token resolves in the same theme scope as the element.
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      parent.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(element).color, resolved];
    },
    { target: selector, name: token },
  );
  if (actual !== expected) {
    throw new Error(`${selector} is ${actual}, not ${token} (${expected})`);
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M3-T7 live transcript panel', 'm3-t7');
const results: { shot: string; check: qa.ShotCheck; note?: string }[] = [];

/**
 * Runs a shot's checks, then shoots it marked pass or fail with the reason, so the gallery shows a
 * failed check next to its picture; a failure still fails the test afterwards.
 */
async function shootChecked(
  preview: qa.PreviewPage,
  group: string,
  name: string,
  caption: string,
  checks: () => Promise<void>,
): Promise<void> {
  let failure: Error | null = null;
  try {
    await checks();
    await qa.expectNoPageOverflow(preview.page);
    qa.expectNoConsoleErrors(preview);
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error(`A check threw ${typeof error}`, { cause: error });
  }
  const note = failure?.message;
  await gallery.shoot(preview.page, group, name, caption, failure === null ? 'pass' : 'fail', note);
  results.push(
    note === undefined ? { shot: name, check: 'pass' } : { shot: name, check: 'fail', note },
  );
  if (failure !== null) throw failure;
}

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m3-t7',
      Harness: 'LiveTranscript mounted alone on the preview page until M3-T9 mounts it',
      Data: `${FIRST_LINES} lines of the live-call fixture, the past-meeting standup`,
    },
    'Live and past transcripts, echo lines, Jump to live, empty states and a failure path',
  );
  process.stdout.write(
    `\nM3-T7 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

describe.each(qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width }))))(
  'the transcript panel in $theme at $width px',
  ({ theme, width }) => {
    const tag = `${theme}-${String(width)}`;

    it('follows a long live call, reads back, shows echo lines, and keeps other meetings out', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await mountHarness(page);
        const call = liveCallLines(FIRST_LINES + 12);
        const stored = call.slice(0, FIRST_LINES);
        const props: PanelProps = {
          meetingId: LIVE_CALL.meetingId,
          storedLines: stored,
          showHidden: false,
          live: true,
        };
        // First drawn as not live, as a page does before main's capture status arrives: the
        // panel must follow once it learns the meeting is recording.
        await renderPanel(page, { ...props, live: false }, LIVE_CALL.title);
        await waitForRows(page, FIRST_LINES);
        await renderPanel(page, props, LIVE_CALL.title);

        // Live: three new finals (one with a long link), then both speakers mid-sentence.
        const [n1, n2, n3, ...later] = call.slice(FIRST_LINES);
        const upcomingMic = later.find((line) => line.source === 'mic');
        const upcomingSystem = later.find((line) => line.source === 'system');
        const rest = later.filter((line) => line !== upcomingMic && line !== upcomingSystem);
        if (!n1 || !n2 || !n3 || !upcomingMic || !upcomingSystem || rest.length < 4) {
          throw new Error('Too few call lines');
        }
        const linked = { ...n3, text: LONG_LINK, endMs: n3.startMs + 6000 };
        await emitAll(page, [
          interimOf(n1, 3),
          final(n1),
          final(n2),
          final(linked),
          interimOf(upcomingMic, 4),
          interimOf(upcomingSystem, 5),
        ]);
        await waitForRows(page, FIRST_LINES + 3);
        await shootChecked(
          preview,
          'Live call',
          `live-${tag}`,
          `${FIRST_LINES} lines and counting: the newest final line and both speakers' interims (grey, italic) at the bottom, followed live`,
          async () => {
            expect(await following(page)).toBe(true);
            expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1);
            expect(await page.locator('[data-interim]').count()).toBe(2);
            await qa.expectVisible(page, '[data-interim]', { within: '.live-transcript-lines' });
            await qa.expectVisible(page, '.live-transcript-lines > :last-child', {
              within: '.live-transcript-lines',
            });
            await qa.expectVisible(page, `[data-segment-id="${linked.id}"]`, {
              within: '.live-transcript-lines',
            });
            await expectTokenColour(page, '[data-interim] .transcript-line-text', '--interim-ink');
            await expectTokenColour(
              page,
              '[data-speaker="them"]:not([data-interim]) .transcript-line-speaker',
              '--accent-ink',
            );
            expect(await page.locator('.jump-to-live').count()).toBe(0);
          },
        );

        // Reading back: scroll up; new lines must not pull the view, and Jump to live shows.
        await page.evaluate(() => {
          const log = document.querySelector('.live-transcript-lines');
          if (log === null) throw new Error('No transcript log on the page');
          log.scrollTop = log.scrollHeight / 2;
        });
        await page.waitForFunction(
          () =>
            document.querySelector('.live-transcript')?.getAttribute('data-following') === 'false',
        );
        const readingAt = await page.evaluate(
          () => document.querySelector('.live-transcript-lines')?.scrollTop ?? -1,
        );
        const [n4, n5, them, meEcho] = rest;
        if (!n4 || !n5 || !them || !meEcho) throw new Error('Too few call lines');
        await emitAll(page, [final(upcomingMic), final(n4), final(n5)]);
        await waitForRows(page, FIRST_LINES + 6);
        await shootChecked(
          preview,
          'Reading back',
          `reading-${tag}`,
          'Scrolled up mid-call: new lines arrive without moving the view, and Jump to live shows',
          async () => {
            expect(await following(page)).toBe(false);
            expect(
              await page.evaluate(
                () => document.querySelector('.live-transcript-lines')?.scrollTop ?? -1,
              ),
            ).toBe(readingAt);
            await qa.expectVisible(page, '.jump-to-live');
          },
        );
        await page.click('.jump-to-live');
        await page.waitForFunction(
          () =>
            document.querySelector('.live-transcript')?.getAttribute('data-following') === 'true',
        );
        expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1);
        expect(await page.locator('.jump-to-live').count()).toBe(0);

        // Echo: a mic line that repeats the call audio, hidden by M2's filter after it showed.
        const echoed: TranscriptSegment = {
          ...meEcho,
          source: 'mic',
          speaker: 'me',
          startMs: them.startMs + 300,
          endMs: them.endMs + 300,
          text: them.text,
        };
        const callAudio: TranscriptSegment = { ...them, source: 'system', speaker: 'them' };
        await emitAll(page, [final(callAudio), final(echoed)]);
        await waitForRows(page, FIRST_LINES + 8);
        await emitAll(page, [changeOf(echoed, 'hidden', callAudio.id)]);
        await waitForRows(page, FIRST_LINES + 7);
        await renderPanel(page, { ...props, showHidden: true }, LIVE_CALL.title);
        await waitForRows(page, FIRST_LINES + 8);
        await shootChecked(
          preview,
          'Echo lines',
          `echo-${tag}`,
          'Hidden lines shown: the mic line that repeated the call audio is back, greyed and marked echo',
          async () => {
            await qa.expectVisible(page, `[data-segment-id="${echoed.id}"][data-echo]`, {
              within: '.live-transcript-lines',
            });
            await expectTokenColour(
              page,
              `[data-segment-id="${echoed.id}"] .transcript-line-text`,
              '--hidden-ink',
            );
            await qa.expectVisible(page, `[data-segment-id="${echoed.id}"] .transcript-line-echo`);
          },
        );
        await renderPanel(page, props, LIVE_CALL.title);
        await waitForRows(page, FIRST_LINES + 7);
        expect(await page.locator(`[data-segment-id="${echoed.id}"]`).count()).toBe(0);
      } finally {
        await preview.close();
      }
    });

    it('shows a past meeting from its first line, the empty states, and a failure path', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await mountHarness(page);
        const past: PanelProps = {
          meetingId: PAST_MEETING.meetingId,
          storedLines: PAST_LINES,
          showHidden: false,
          live: false,
        };
        await renderPanel(page, past, PAST_MEETING.title);
        await waitForRows(page, PAST_LINES.length);
        const first = PAST_LINES[0];
        if (first === undefined) throw new Error('past-meeting.json has no lines');
        await shootChecked(
          preview,
          'Past meeting',
          `past-${tag}`,
          'A standup that ended: the same panel, from its first line, with no Jump to live',
          async () => {
            await qa.expectVisible(page, `[data-segment-id="${first.id}"]`, {
              within: '.live-transcript-lines',
            });
            expect(
              await page.evaluate(
                () => document.querySelector('.live-transcript-lines')?.scrollTop ?? -1,
              ),
            ).toBe(0);
            expect(await page.locator('.jump-to-live').count()).toBe(0);
          },
        );

        // Failure path 1: the meeting recording now sends lines while a past one is open.
        const intruder = liveCallLines(3);
        const [live1, live2, live3] = intruder;
        if (!live1 || !live2 || !live3) throw new Error('Too few call lines');
        await emitAll(page, [
          final(live1),
          interimOf(live2, 4),
          changeOf({ ...first, meetingId: LIVE_CALL.meetingId }, 'hidden', live3.id),
        ]);
        await nextFrames(page);
        expect(await rowsIn(page)).toBe(PAST_LINES.length);
        expect(await page.locator('[data-interim]').count()).toBe(0);
        await qa.expectVisible(page, `[data-segment-id="${first.id}"]`);

        // Empty states.
        const quiet = '3e8b6c1d-9f2a-4b7c-8d5e-6a1f0c2b9d47';
        await renderPanel(
          page,
          { meetingId: quiet, storedLines: [], showHidden: false, live: true },
          'Weekly sync with Rotterdam',
        );
        await shootChecked(
          preview,
          'Empty',
          `empty-live-${tag}`,
          'A meeting that just started: nobody has spoken yet',
          async () => {
            await qa.expectVisible(page, '.live-transcript-empty');
            expect(await page.textContent('.live-transcript-empty')).toBe(
              'Listening. Lines appear here as people speak.',
            );
          },
        );
        await renderPanel(
          page,
          { meetingId: quiet, storedLines: [], showHidden: false, live: false },
          'Weekly sync with Rotterdam',
        );
        await shootChecked(
          preview,
          'Empty',
          `empty-past-${tag}`,
          'A past meeting with no lines',
          async () => {
            expect(await page.textContent('.live-transcript-empty')).toBe(
              'Nothing was transcribed in this meeting.',
            );
          },
        );

        // Failure path 2, live: a hide that comes before its line, and an interim already final.
        const fresh = 'a7d4c2e9-1b3f-4e6a-9c8d-2f5b7e1a0c64';
        const opening = [
          segment(fresh, 1, 'system', 1000, 'Can everyone see the pricing sheet?'),
          segment(fresh, 2, 'mic', 4200, 'Yes, the seat counts are on the second tab.'),
        ];
        await renderPanel(
          page,
          { meetingId: fresh, storedLines: opening, showHidden: false, live: true },
          'Pricing review',
        );
        await waitForRows(page, 2);
        const held = segment(fresh, 3, 'mic', 9000, 'Can everyone see the pricing sheet?');
        const late = segment(fresh, 4, 'system', 9100, 'Great, then let us start with seats.');
        await emitAll(page, [
          changeOf(held, 'hidden', opening[0]?.id ?? null),
          final(held),
          final(late),
          {
            channel: captureChannels.TranscriptInterim,
            payload: {
              meetingId: fresh,
              source: 'system',
              text: 'great then',
              startMs: late.startMs,
              endMs: late.startMs + 700,
            },
          },
        ]);
        await waitForRows(page, 3);
        await shootChecked(
          preview,
          'Failure path',
          `failure-${tag}`,
          "Out-of-order events: the echo hide that came before its line keeps it hidden, an interim that was already final never shows, and another meeting's lines never reached the past one",
          async () => {
            expect(await page.locator(`[data-segment-id="${held.id}"]`).count()).toBe(0);
            await qa.expectVisible(page, `[data-segment-id="${late.id}"]`);
            expect(await page.locator('[data-interim]').count()).toBe(0);
          },
        );
      } finally {
        await preview.close();
      }
    });
  },
);
