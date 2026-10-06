import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import type * as ReactNamespace from 'react';
import type * as ReactDom from 'react-dom';
import type * as ReactDomClient from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { TranscriptSegmentChange } from '../src/shared/capture';
import { captureChannels } from '../src/shared/ipc/capture';
import type { CitationAttrs } from '../src/shared/notes';
import type { TranscriptSegment } from '../src/shared/transcript';

/*
 * Browser QA for M4-T21b, the citation navigator's reveal (qa/README.md): both themes, 1440 and
 * 390 wide. On the preview's 500-line live call, with a line every 200 ms: a chip for line 40
 * pauses following, centres the line, tints it for 2 s while new lines arrive below, and shows
 * "Jump to live"; a chip citing two lines out of order centres the first in transcript order, and
 * a second reveal clears the first one's tint; a chip for the newest line keeps it in view as lines
 * keep coming. On a phone the chip brings the transcript pane forward before it scrolls. Failure
 * path: chips whose lines are gone (never in the transcript, hidden as echo) say "Line removed"
 * and leave the transcript and the pane alone; with hidden lines shown, the echo line's chip finds
 * it. And a past meeting.
 *
 * Nothing mounts LiveTranscript or a chip in the app until M3-T9 and M4-T20, so this script mounts
 * the panel alone on the preview page, in the meeting page's frame and panes (app.css, meeting.css:
 * side by side when wide, one at a time when narrow), inside CitationNavigatorProvider with a
 * `showTranscript` like MeetingPage's (flushSync). The notes are lines with the real chip button
 * (CitationChipButton), revealing as CitationChip does. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m4-t21b.qa.e2e.ts
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
/** Vite serves files outside the preview root under /@fs/ plus their absolute path. */
const servedAt = (path: string): string => `/@fs${SOURCE_ROOT}${path}`;
const RENDERER_ENTRY_URL = servedAt('renderer/src/main.tsx');
/** Imports `react-dom` itself (flushSync), which the renderer's entry does not name. */
const MEETING_PAGE_URL = servedAt('renderer/src/meeting/MeetingPage.tsx');
const PANEL_URL = servedAt('renderer/src/transcript/LiveTranscript.tsx');
const NAVIGATOR_URL = servedAt('renderer/src/transcript/transcriptNavigator.ts');
const CHIP_URL = servedAt('renderer/src/notes/CitationChip.tsx');
/** The chip's styles: NoteEditor.tsx imports them, and nothing mounts the editor yet. */
const NOTES_CSS_URL = servedAt('renderer/src/notes/notes.css');

/**
 * The props of LiveTranscript, CitationNavigatorProvider and CitationChipButton, restated: those
 * files are JSX or read the renderer's `window.roger` type, which this program (tsconfig.e2e) does
 * not have. Change them together.
 */
interface PanelProps {
  meetingId: string;
  storedLines: readonly TranscriptSegment[];
  showHidden: boolean;
  live: boolean;
}

interface ProviderProps {
  children?: ReactNamespace.ReactNode;
  showTranscript?: () => void;
}

interface ChipButtonProps {
  attrs: CitationAttrs;
  removed: boolean;
  onReveal: () => void;
}

/** One line of the harness's AI notes and its chip. */
interface NoteLine {
  key: string;
  text: string;
  attrs: CitationAttrs;
}

/** What the harness draws: the meeting page's frame over one transcript panel and its notes. */
interface HarnessState extends PanelProps {
  title: string;
  notes: readonly NoteLine[];
}

interface Harness {
  render(state: HarnessState): void;
  /** Draws the last state with these changes: a new chip, hidden lines shown. */
  update(changes: Partial<HarnessState>): void;
}

/** A `data-cited` mark going on or off a line, and when (performance.now()). */
interface MarkChange {
  id: string;
  cited: boolean;
  at: number;
}

declare global {
  interface Window {
    __m4t21b?: { modules: unknown[]; harness?: Harness; marks: MarkChange[] };
  }
}

/** A CommonJS package as Vite's dependency cache serves it: its exports on `default`. */
interface CommonJsModule<T> {
  default: T;
}

const HARNESS = '#m4-t21b-harness';
const LOG = `${HARNESS} .live-transcript-lines`;
const lineSelector = (id: string): string => `${LOG} [data-segment-id="${id}"]`;
const chipSelector = (key: string): string => `${HARNESS} [data-note="${key}"] .citation-chip`;

/** The live call's line `n`, by the id the preview gives it. */
const liveLine = (n: number): string => segmentIdForLine(LIVE_CALL.meetingId, n);
const pastLine = (n: number): string => segmentIdForLine(PAST_MEETING.meetingId, n);
/** In no transcript: a line a re-run replaced, or that echo removal deleted. */
const REMOVED_LINE = '7c1e9a42-3b5d-4f68-9e0a-2d4c6b8f1a37';
/** A mic line of the live call that this script hides as echo for the failure path. */
const ECHO_LINE = 61;

/**
 * TipTap is not in the app's module graph until M4-T20 mounts the editor, and CitationChip.tsx
 * imports it, so the first import makes Vite bundle it and reload the page. One throwaway page
 * takes that reload, as e2e/m4-t17.qa.e2e.ts does; its failures are dropped on purpose (a warm
 * cache does not reload, and a real import error fails mountHarness on the next page).
 */
async function warmUpChipBundle(): Promise<void> {
  const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
  try {
    const reloaded = preview.page
      .waitForEvent('load', { timeout: 10_000 })
      .then(() => qa.settle(preview.page))
      .catch(() => undefined);
    // A string, not a function: Vitest rewrites every import() in this file for Node.
    await preview.page
      .evaluate(`import(${JSON.stringify(CHIP_URL)}).then(() => undefined)`)
      .catch(() => undefined);
    await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 3000))]);
  } finally {
    await preview.close();
  }
}

/**
 * Mounts the harness on the preview page, over the hidden app. React and ReactDOM must be the very
 * modules the app loaded (the URLs with Vite's version hash), or the panel's hooks run against a
 * second React and throw; the app's own files name them.
 */
async function mountHarness(page: Page): Promise<void> {
  const reactUrls = await page.evaluate(
    async ({ entry, meetingPage }) => {
      const find = async (url: string, name: string): Promise<string> => {
        const source = await (await fetch(url)).text();
        const match = new RegExp(`"([^"]*/deps/${name}\\.js\\?v=[^"]+)"`).exec(source);
        if (match?.[1] === undefined) {
          throw new Error(`${url} imports no ${name} through Vite's dependency cache`);
        }
        return match[1];
      };
      return [
        await find(entry, 'react'),
        await find(meetingPage, 'react-dom'),
        await find(entry, 'react-dom_client'),
      ];
    },
    { entry: RENDERER_ENTRY_URL, meetingPage: MEETING_PAGE_URL },
  );
  // A string, not a function: Vitest rewrites every import() in this file for Node
  // (`__vite_ssr_dynamic_import__`), and page.evaluate sends a function as its compiled text.
  const urls = JSON.stringify([...reactUrls, PANEL_URL, NAVIGATOR_URL, CHIP_URL, NOTES_CSS_URL]);
  await page.evaluate(
    `Promise.all(${urls}.map((url) => import(url))).then((modules) => { window.__m4t21b = { modules, marks: [] }; })`,
  );
  await page.evaluate(() => {
    const loaded = window.__m4t21b;
    if (loaded === undefined) throw new Error('The harness modules did not load');
    const [reactModule, domModule, clientModule, panelModule, navigatorModule, chipModule] =
      loaded.modules as [
        CommonJsModule<typeof ReactNamespace>,
        CommonJsModule<typeof ReactDom>,
        CommonJsModule<typeof ReactDomClient>,
        { LiveTranscript: ReactNamespace.ComponentType<PanelProps> },
        {
          CitationNavigatorProvider: ReactNamespace.ComponentType<ProviderProps>;
          useCitationNavigator: () => {
            reveal(segmentIds: readonly string[]): 'shown' | 'not_loaded';
          };
        },
        { CitationChipButton: ReactNamespace.ComponentType<ChipButtonProps> },
      ];
    const { createElement, useCallback, useState } = reactModule.default;
    const { flushSync } = domModule.default;
    const { CitationNavigatorProvider, useCitationNavigator } = navigatorModule;

    // As CitationChip reveals: ask the page's navigator, and say "Line removed" when the last
    // reveal found none of the lines.
    const Chip = ({ attrs }: { attrs: CitationAttrs }) => {
      const navigator = useCitationNavigator();
      const [removed, setRemoved] = useState(false);
      return createElement(chipModule.CitationChipButton, {
        attrs,
        removed,
        onReveal: () => {
          setRemoved(navigator.reveal(attrs.segmentIds) === 'not_loaded');
        },
      });
    };

    // Layout only; every colour is a theme token.
    const Notes = ({ notes }: { notes: readonly NoteLine[] }) =>
      createElement(
        'section',
        {
          'aria-label': 'AI notes',
          style: {
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '12px 16px',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            background: 'var(--panel)',
          },
        },
        createElement('h2', { style: { margin: '0 0 8px', fontSize: '15px' } }, 'AI notes'),
        createElement(
          'ul',
          { style: { display: 'grid', gap: '8px', margin: 0, paddingLeft: '18px' } },
          ...notes.map((note) =>
            createElement(
              'li',
              { key: note.key, 'data-note': note.key },
              `${note.text} `,
              createElement(Chip, { attrs: note.attrs }),
            ),
          ),
        ),
      );

    type Pane = 'notes' | 'transcript';
    const PANES: readonly Pane[] = ['notes', 'transcript'];
    const LABEL: Record<Pane, string> = { notes: 'Notes', transcript: 'Transcript' };

    // The meeting page's frame and panes (MeetingPage.tsx, regions.tsx), with its showTranscript.
    const MeetingFrame = ({ state }: { state: HarnessState }) => {
      const [pane, setPane] = useState<Pane>('notes');
      // The navigator scrolls as soon as this returns, so the transcript must be shown by then.
      const showTranscript = useCallback(() => {
        flushSync(() => {
          setPane('transcript');
        });
      }, []);
      const region = (name: Pane, child: ReactNamespace.ReactNode) =>
        createElement(
          'div',
          {
            id: `meeting-pane-${name}`,
            className: `meeting-region meeting-region-${name}`,
            'data-active': name === pane ? 'true' : undefined,
          },
          child,
        );
      return createElement(
        'div',
        { className: 'meeting-page' },
        createElement(
          'header',
          { className: 'page-header' },
          createElement('h1', { className: 'page-title' }, state.title),
        ),
        createElement(
          CitationNavigatorProvider,
          { showTranscript },
          createElement(
            'div',
            { className: 'meeting-body', 'data-layout': 'split' },
            createElement(
              'div',
              { className: 'meeting-pane-buttons', role: 'group', 'aria-label': 'Show' },
              ...PANES.map((name) =>
                createElement(
                  'button',
                  {
                    key: name,
                    type: 'button',
                    className: 'meeting-pane-button',
                    'aria-pressed': name === pane,
                    'aria-controls': `meeting-pane-${name}`,
                    onClick: () => {
                      setPane(name);
                    },
                  },
                  LABEL[name],
                ),
              ),
            ),
            region('notes', createElement(Notes, { notes: state.notes })),
            region(
              'transcript',
              createElement(panelModule.LiveTranscript, {
                meetingId: state.meetingId,
                storedLines: state.storedLines,
                showHidden: state.showHidden,
                live: state.live,
              }),
            ),
          ),
        ),
      );
    };

    const app = document.getElementById('root');
    if (app !== null) app.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'm4-t21b-harness';
    // The shell page's box: as tall as the window, with its gutters. No colour: the page's own.
    host.style.cssText = 'height: 100vh; padding: 24px 16px; box-sizing: border-box;';
    document.body.append(host);
    // Every data-cited change, timed, so a check can tell how long a mark stayed.
    new MutationObserver((records) => {
      const at = performance.now();
      for (const { target } of records) {
        if (!(target instanceof Element)) continue;
        const id = target.getAttribute('data-segment-id');
        if (id !== null) loaded.marks.push({ id, cited: target.hasAttribute('data-cited'), at });
      }
    }).observe(host, { subtree: true, attributes: true, attributeFilter: ['data-cited'] });

    const root = clientModule.default.createRoot(host);
    let current: HarnessState | null = null;
    const draw = (state: HarnessState): void => {
      current = state;
      root.render(createElement(MeetingFrame, { state }));
    };
    loaded.harness = {
      render: draw,
      update: (changes) => {
        if (current === null) throw new Error('Nothing drawn yet to update');
        draw({ ...current, ...changes });
      },
    };
  });
}

async function renderHarness(page: Page, state: HarnessState): Promise<void> {
  await page.evaluate((next) => {
    const harness = window.__m4t21b?.harness;
    if (harness === undefined) throw new Error('The harness is not mounted');
    harness.render(next);
  }, state);
  // The panel subscribes in an effect; the preview's hub drops events nobody listens to yet.
  await qa.settle(page);
}

async function updateHarness(page: Page, changes: Partial<HarnessState>): Promise<void> {
  await page.evaluate((next) => {
    const harness = window.__m4t21b?.harness;
    if (harness === undefined) throw new Error('The harness is not mounted');
    harness.update(next);
  }, changes);
  await qa.settle(page);
}

/** The meeting's lines as main's store holds them (the preview's meetings fake records them). */
async function storedLines(page: Page, meetingId: string): Promise<TranscriptSegment[]> {
  const lines = await page.evaluate(
    async (id) => (await window.roger.getMeeting({ meetingId: id }))?.segments ?? null,
    meetingId,
  );
  if (lines === null) throw new Error(`The preview stores no meeting ${meetingId}`);
  return lines;
}

/** The chip's time as M4's citation attrs carry it: "03:12", or "1:02:05" past an hour. */
function chipLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const clock = [Math.floor((total % 3600) / 60), total % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return hours > 0 ? `${hours}:${clock}` : clock;
}

/** A note line citing `ids`, timed at the earliest of them in `lines` (as the API sets it). */
function note(
  key: string,
  text: string,
  ids: readonly string[],
  lines: readonly TranscriptSegment[],
  startMs?: number,
): NoteLine {
  const first = lines.find((line) => ids.includes(line.id));
  const at = startMs ?? first?.startMs;
  if (at === undefined) throw new Error(`No line of ${ids.join(', ')} to time the chip by`);
  return {
    key,
    text,
    attrs: { segmentIds: [...ids], startMs: at, label: chipLabel(at), support: 'ok' },
  };
}

/** The live call's AI notes. Ids are listed out of order where a chip cites two lines. */
function liveCallNotes(lines: readonly TranscriptSegment[]): NoteLine[] {
  return [
    note(
      'line-40',
      'Rahul sends the security wording for the addendum by Thursday, and the revised quote by Monday.',
      [liveLine(40)],
      lines,
    ),
    note(
      'two-lines',
      'Revised quote: team tier at the viewer-adjusted count, twelve percent off for two years, fifteen for three.',
      [liveLine(75), liveLine(74)],
      lines,
    ),
    note(
      'echo-line',
      'Transcripts live in Postgres, scoped to the workspace; every query filters by it.',
      [liveLine(ECHO_LINE)],
      lines,
    ),
    note(
      'removed',
      'Transcripts are kept for thirty days unless the workspace asks for less.',
      [REMOVED_LINE],
      lines,
      1_234_000,
    ),
  ];
}

/** Opens the scenario's meeting in the harness, with its stored lines and `notes`. */
async function openMeeting(
  page: Page,
  meetingId: string,
  title: string,
  live: boolean,
  notes: (lines: readonly TranscriptSegment[]) => NoteLine[],
): Promise<TranscriptSegment[]> {
  await mountHarness(page);
  const lines = await storedLines(page, meetingId);
  await renderHarness(page, {
    title,
    meetingId,
    storedLines: lines,
    showHidden: false,
    live,
    notes: notes(lines),
  });
  // Lines main sent between that read and the panel's subscription: read again and merge, as the
  // meeting page does.
  await updateHarness(page, { storedLines: await storedLines(page, meetingId) });
  return lines;
}

const rowsIn = (page: Page): Promise<number> =>
  page.evaluate((log) => document.querySelectorAll(`${log} [data-segment-id]`).length, LOG);

const following = (page: Page): Promise<boolean> =>
  page.evaluate(
    (harness) =>
      document.querySelector(`${harness} .live-transcript`)?.getAttribute('data-following') ===
      'true',
    HARNESS,
  );

const scrollTopOf = (page: Page): Promise<number> =>
  page.evaluate((log) => document.querySelector(log)?.scrollTop ?? -1, LOG);

/** The ids of the lines marked `data-cited`, in transcript order. */
const citedIds = (page: Page): Promise<string[]> =>
  page.evaluate(
    (harness) =>
      Array.from(document.querySelectorAll(`${harness} [data-cited]`), (line) =>
        String(line.getAttribute('data-segment-id')),
      ),
    HARNESS,
  );

/** The pane a narrow page shows, or null when both show (the pane buttons are hidden). */
const shownPane = (page: Page): Promise<string | null> =>
  page.evaluate((harness) => {
    const buttons = document.querySelector(`${harness} .meeting-pane-buttons`);
    if (buttons === null || getComputedStyle(buttons).display === 'none') return null;
    return (
      document
        .querySelector(`${harness} .meeting-region[data-active]`)
        ?.id.replace('meeting-pane-', '') ?? 'none'
    );
  }, HARNESS);

/** Clicks a chip, bringing the notes forward first when a narrow page shows the transcript. */
async function clickChip(page: Page, key: string): Promise<void> {
  if ((await shownPane(page)) === 'transcript') {
    await page.click(`${HARNESS} .meeting-pane-button[aria-controls="meeting-pane-notes"]`);
  }
  await page.click(chipSelector(key));
}

/** Pixels between the log's view and its last line: 0 when it shows the newest line. */
const distanceFromBottom = (page: Page): Promise<number> =>
  page.evaluate((log) => {
    const element = document.querySelector(log);
    if (element === null) throw new Error('No transcript log on the page');
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  }, LOG);

/**
 * Fails unless the line's middle sits at the middle of the log's view, or as near as the log's
 * scroll goes (a line near either end cannot be centred).
 */
async function expectCentred(page: Page, id: string): Promise<void> {
  const { off, top, max } = await page.evaluate(
    ({ log, segmentId }) => {
      const element = document.querySelector(log);
      const line = element?.querySelector(`[data-segment-id="${segmentId}"]`);
      if (!element || !line) throw new Error(`No line ${segmentId} in the transcript`);
      const view = element.getBoundingClientRect();
      const box = line.getBoundingClientRect();
      return {
        off: box.top + box.height / 2 - (view.top + element.clientTop + element.clientHeight / 2),
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      };
    },
    { log: LOG, segmentId: id },
  );
  const reachable = Math.min(max, Math.max(0, top + off));
  if (Math.abs(top - reachable) > 2) {
    throw new Error(
      `Line ${id} is ${off.toFixed(1)} px off the view's middle (scrollTop ${top}, could be ${reachable.toFixed(1)})`,
    );
  }
}

/** How long line `id` carried its latest complete `data-cited` mark, in ms; null if none ended. */
const lastMarkMs = (page: Page, id: string): Promise<number | null> =>
  page.evaluate((segmentId) => {
    const changes = (window.__m4t21b?.marks ?? []).filter((change) => change.id === segmentId);
    const off = changes.findLastIndex((change) => !change.cited);
    const on = changes.slice(0, off).findLastIndex((change) => change.cited);
    const end = changes[off];
    const start = changes[on];
    return end === undefined || start === undefined ? null : end.at - start.at;
  }, id);

/** Fails unless `selector`'s computed `property` is the theme token `token` as the page resolves it. */
async function expectToken(
  page: Page,
  selector: string,
  property: 'color' | 'background-color',
  token: string,
): Promise<void> {
  const [actual, expected] = await page.evaluate(
    ({ target, name, cssProperty }) => {
      const element = document.querySelector(target);
      const parent = element?.parentElement ?? null;
      if (element === null || parent === null) throw new Error(`No ${target} to read`);
      // A probe beside it, so the token resolves in the same theme scope as the element.
      const probe = document.createElement('span');
      probe.style.setProperty(cssProperty, `var(${name})`);
      parent.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(cssProperty);
      probe.remove();
      return [getComputedStyle(element).getPropertyValue(cssProperty), resolved];
    },
    { target: selector, name: token, cssProperty: property },
  );
  if (actual !== expected) throw new Error(`${selector} ${property} is ${actual}, not ${token}`);
}

async function chipText(page: Page, key: string): Promise<string> {
  return (await page.textContent(chipSelector(key))) ?? '';
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-T21b citation navigator', 'm4-t21b');
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

/**
 * Fails unless the line still carries its mark: checked after a shot, it proves the shot shows the
 * tint (a mark only ever comes off, until the next reveal).
 */
async function expectStillCited(page: Page, id: string, shot: string): Promise<void> {
  if (!(await citedIds(page)).includes(id)) {
    throw new Error(`The tint on ${id} was gone before ${shot} was taken`);
  }
}

beforeAll(async () => {
  run = await qa.startQa();
  await warmUpChipBundle();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m4-t21b',
      Harness:
        'LiveTranscript and CitationChipButton mounted alone on the preview page, in the meeting page frame and panes, until M3-T9 and M4-T20 mount them',
      Data: `The live-call scenario (500 lines, then one every 200 ms) and the past-meeting standup`,
    },
    'A chip reveals its lines: follow paused, the first line centred, tinted for 2 s; removed and hidden lines; a phone brings the transcript forward',
  );
  process.stdout.write(
    `\nM4-T21b QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

describe.each(qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width }))))(
  'the citation navigator in $theme at $width px',
  ({ theme, width }) => {
    const tag = `${theme}-${String(width)}`;

    it('reveals cited lines in a live call without following away from them', async () => {
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      try {
        await openMeeting(page, LIVE_CALL.meetingId, LIVE_CALL.title, true, liveCallNotes);
        await page.waitForFunction(
          (log) => document.querySelectorAll(`${log} [data-segment-id]`).length >= 500,
          LOG,
        );
        const narrow = (await shownPane(page)) !== null;
        await shootChecked(
          preview,
          'Live call',
          `before-${tag}`,
          narrow
            ? 'Mid-call on a phone: the notes pane is up, the transcript follows live behind it'
            : 'Mid-call: AI notes with chips beside a 500-line transcript that follows live',
          async () => {
            expect(await following(page)).toBe(true);
            expect(await shownPane(page)).toBe(narrow ? 'notes' : null);
            await qa.expectVisible(page, chipSelector('line-40'));
          },
        );

        // A chip for line 40, far above the live end.
        const target = liveLine(40);
        await clickChip(page, 'line-40');
        const rowsAtReveal = await rowsIn(page);
        const topAtReveal = await scrollTopOf(page);
        await shootChecked(
          preview,
          'Reveal',
          `reveal-${tag}`,
          `Chip for line 40 clicked mid-call: ${narrow ? 'the transcript pane comes forward, ' : ''}line 40 sits mid-view, tinted, following pauses and Jump to live shows`,
          async () => {
            expect(await citedIds(page)).toEqual([target]);
            expect(await following(page)).toBe(false);
            expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
            await expectCentred(page, target);
            await qa.expectVisible(page, lineSelector(target), { within: LOG });
            await qa.expectVisible(page, `${HARNESS} .jump-to-live`);
            await expectToken(page, lineSelector(target), 'background-color', '--cited-bg');
            expect(await chipText(page, 'line-40')).not.toContain('Line removed');
          },
        );
        await expectStillCited(page, target, `reveal-${tag}`);

        // Lines keep coming (one every 200 ms): five more, and the view stays on line 40.
        await page.waitForFunction(
          ({ log, rows }) => document.querySelectorAll(`${log} [data-segment-id]`).length >= rows,
          { log: LOG, rows: rowsAtReveal + 5 },
        );
        // The mark comes off 2 s after the reveal.
        await page.waitForFunction(
          (harness) => document.querySelector(`${harness} [data-cited]`) === null,
          HARNESS,
          { timeout: 4000 },
        );
        const arrived = (await rowsIn(page)) - rowsAtReveal;
        await shootChecked(
          preview,
          'Reveal',
          `after-${tag}`,
          `2 s on: the tint is gone, ${arrived} new lines arrived below and line 40 has not moved; Jump to live still shows`,
          async () => {
            const markMs = await lastMarkMs(page, target);
            if (markMs === null || markMs < 1990 || markMs > 2500) {
              throw new Error(`Line 40 was tinted for ${String(markMs)} ms, not 2 s`);
            }
            expect(arrived).toBeGreaterThanOrEqual(5);
            expect(await scrollTopOf(page)).toBe(topAtReveal);
            expect(await following(page)).toBe(false);
            await qa.expectVisible(page, lineSelector(target), { within: LOG });
            await qa.expectVisible(page, `${HARNESS} .jump-to-live`);
          },
        );

        // Two lines cited out of order; then line 40 again at once: the second reveal clears the
        // first one's tint before its 2 s are up.
        const [earlier, later] = [liveLine(74), liveLine(75)];
        await clickChip(page, 'two-lines');
        expect(await citedIds(page)).toEqual([earlier, later]);
        await expectCentred(page, earlier);
        await clickChip(page, 'line-40');
        expect(await citedIds(page)).toEqual([target]);
        await expectCentred(page, target);
        await clickChip(page, 'two-lines');
        await shootChecked(
          preview,
          'Reveal',
          `two-lines-${tag}`,
          'A chip citing lines 75 and 74 (in that order): line 74, the first in the transcript, sits mid-view and both are tinted; the reveal before it lost its tint at once',
          async () => {
            expect(await citedIds(page)).toEqual([earlier, later]);
            await expectCentred(page, earlier);
            await qa.expectVisible(page, lineSelector(earlier), { within: LOG });
            await qa.expectVisible(page, lineSelector(later), { within: LOG });
          },
        );
        await expectStillCited(page, earlier, `two-lines-${tag}`);

        // The newest line: the log cannot centre it, so the reveal leaves the view at the bottom,
        // and following must stay paused there as new lines arrive below it.
        const newest = await page.evaluate(
          (log) =>
            Array.from(document.querySelectorAll(`${log} [data-segment-id]`))
              .at(-1)
              ?.getAttribute('data-segment-id') ?? null,
          LOG,
        );
        if (newest === null) throw new Error('No newest line in the transcript');
        const lines = await storedLines(page, LIVE_CALL.meetingId);
        await updateHarness(page, {
          notes: [
            note(
              'newest',
              'Just now on the call (the newest line when the chip was clicked).',
              [newest],
              lines,
            ),
            ...liveCallNotes(lines),
          ],
        });
        await page.click(`${HARNESS} .jump-to-live`);
        await page.waitForFunction(
          (harness) =>
            document
              .querySelector(`${harness} .live-transcript`)
              ?.getAttribute('data-following') === 'true',
          HARNESS,
        );
        await clickChip(page, 'newest');
        const rowsAtNewest = await rowsIn(page);
        await page.waitForFunction(
          ({ log, rows }) => document.querySelectorAll(`${log} [data-segment-id]`).length >= rows,
          { log: LOG, rows: rowsAtNewest + 5 },
        );
        await shootChecked(
          preview,
          'Reveal',
          `newest-${tag}`,
          'A chip for the newest line, clicked while following: the view stays put as five more lines arrive below, so the cited line stays in view',
          async () => {
            expect(await following(page)).toBe(false);
            expect(await distanceFromBottom(page)).toBeGreaterThan(0);
            await qa.expectVisible(page, lineSelector(newest), { within: LOG });
            await qa.expectVisible(page, `${HARNESS} .jump-to-live`);
          },
        );

        // Jump to live ends the pause: the newest line again, and following.
        await page.click(`${HARNESS} .jump-to-live`);
        await page.waitForFunction(
          (harness) =>
            document
              .querySelector(`${harness} .live-transcript`)
              ?.getAttribute('data-following') === 'true',
          HARNESS,
        );
        expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1);
        qa.expectNoConsoleErrors(preview);
      } finally {
        await preview.close();
      }
    });

    it('leaves the transcript alone for lines that are gone, and finds a hidden one once shown', async () => {
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      try {
        const lines = await openMeeting(
          page,
          LIVE_CALL.meetingId,
          LIVE_CALL.title,
          true,
          liveCallNotes,
        );
        const echo = lines.find((line) => line.id === liveLine(ECHO_LINE));
        const repeated = lines.find((line) => line.id === liveLine(ECHO_LINE - 1));
        if (echo === undefined || repeated === undefined || echo.source !== 'mic') {
          throw new Error(`Line ${ECHO_LINE} of the live call is not a stored mic line`);
        }
        // M2's echo filter hides the mic line after it showed, as main sends it.
        const hidden: TranscriptSegmentChange = {
          meetingId: echo.meetingId,
          segmentId: echo.id,
          source: echo.source,
          change: 'hidden',
          reason: 'echo',
          echoOf: repeated.id,
          text: echo.text,
        };
        await qa.emitEvent(page, captureChannels.TranscriptSegmentChanged, hidden);
        await page.waitForSelector(lineSelector(echo.id), { state: 'detached' });
        const narrow = (await shownPane(page)) !== null;

        await clickChip(page, 'removed');
        await clickChip(page, 'echo-line');
        await shootChecked(
          preview,
          'Failure path',
          `removed-${tag}`,
          `Chips for a line no longer in the transcript and for a line hidden as echo say Line removed; nothing is tinted, following goes on${narrow ? ' and the notes stay up' : ''}`,
          async () => {
            expect(await chipText(page, 'removed')).toContain('Line removed');
            expect(await chipText(page, 'echo-line')).toContain('Line removed');
            expect(await citedIds(page)).toEqual([]);
            expect(await following(page)).toBe(true);
            expect(await shownPane(page)).toBe(narrow ? 'notes' : null);
            await qa.expectVisible(page, chipSelector('removed'));
            await expectToken(
              page,
              `${chipSelector('removed')} .citation-chip-time`,
              'color',
              '--muted',
            );
            // On a phone the hidden log has no box to follow in; wide, it still shows the end.
            if (!narrow) expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1);
          },
        );

        // The reader shows hidden lines: the echo line is back, and its chip finds it.
        await updateHarness(page, { showHidden: true });
        await page.waitForSelector(`${lineSelector(echo.id)}[data-echo]`, { state: 'attached' });
        await clickChip(page, 'echo-line');
        await shootChecked(
          preview,
          'Failure path',
          `hidden-shown-${tag}`,
          'Hidden lines shown: the echo line is back (marked echo), and its chip now reveals it, tinted mid-view',
          async () => {
            expect(await chipText(page, 'echo-line')).not.toContain('Line removed');
            expect(await citedIds(page)).toEqual([echo.id]);
            await expectCentred(page, echo.id);
            await qa.expectVisible(page, lineSelector(echo.id), { within: LOG });
            expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
          },
        );
        await expectStillCited(page, echo.id, `hidden-shown-${tag}`);
      } finally {
        await preview.close();
      }
    });

    it('reveals lines in a past meeting', async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        const [checklist, closing] = [pastLine(25), pastLine(26)];
        await openMeeting(page, PAST_MEETING.meetingId, PAST_MEETING.title, false, (lines) => [
          note(
            'retry',
            'Priyanka finished the uploader retry logic: about 1,500 lines from a 40-minute call, no duplicates.',
            [pastLine(6), pastLine(4)],
            lines,
          ),
          note(
            'release',
            'Release checklist: the AssemblyAI training opt-out is done; M1 could close by end of day if the 2 pm call works.',
            [closing, checklist],
            lines,
          ),
        ]);
        await clickChip(page, 'release');
        const narrow = (await shownPane(page)) !== null;
        await shootChecked(
          preview,
          'Past meeting',
          `past-${tag}`,
          'A standup that ended: the chip centres line 25 as far as the log scrolls and tints lines 25 and 26; no Jump to live in a past meeting',
          async () => {
            expect(await citedIds(page)).toEqual([checklist, closing]);
            await expectCentred(page, checklist);
            await qa.expectVisible(page, lineSelector(checklist), { within: LOG });
            expect(await page.locator(`${HARNESS} .jump-to-live`).count()).toBe(0);
            expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
          },
        );
        await expectStillCited(page, checklist, `past-${tag}`);
      } finally {
        await preview.close();
      }
    });
  },
);
