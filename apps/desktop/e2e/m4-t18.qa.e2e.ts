import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import type * as ReactNamespace from 'react';
import type * as ReactDomClient from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import { notesChannels } from '../src/shared/ipc/notes';
import { prefsChannels } from '../src/shared/ipc/prefs';
import {
  CITATION_NODE_TYPE,
  type CitationSupport,
  FROM_YOUR_NOTES_HEADING,
  type LocalNote,
  NOT_SAID_ON_THE_CALL,
  type Note,
  type NoteDoc,
  type NoteNode,
  type NotesStreamEvent,
  type PendingGenerateState,
  type PendingGenerateStatus,
  type RefCitation,
} from '../src/shared/notes';

/*
 * Browser QA for M4-T18's AI notes panel and the notes section of Settings (qa/README.md): both
 * themes, 1440 and 390 wide. One meeting from no AI notes to Generate, the picker with the title's
 * suggestion, a run streaming its lines (chips, a "check this" line, From your notes, removed
 * lines), the saved notes, a regeneration streaming over the hidden, read-only editor, Restore
 * previous notes, and the question before regenerating edited notes. Then the waiting state and
 * "Which kind of call was this?", and the failure path: a run that fails mid-stream keeps its
 * partial lines under the error banner, and Retry starts again; a generate main refuses shows why;
 * main's own failure says it retries, with Cancel. Then Settings. Two traps are shot too: a lost
 * stream left waiting offline gives the notes back, and a picker opened before a generate started
 * stays closed after it ends.
 *
 * Nothing mounts the panel in the app until M4-T20, so this script mounts it alone on the
 * preview's `empty-mac` page, inside the CitationNavigatorProvider and meeting view the meeting
 * page gives it, with the app's own React, styles and theme, and drives it through the preview's
 * fake `window.roger` (preview/fakes/notes.ts): pending generates, run events and saved notes go
 * through the same channels main uses. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m4-t18.qa.e2e.ts
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
/** Vite serves files outside the preview root under /@fs/ plus their absolute path. */
const servedAt = (path: string): string => `/@fs${SOURCE_ROOT}${path}`;
const RENDERER_ENTRY_URL = servedAt('renderer/src/main.tsx');
const PANEL_URL = servedAt('renderer/src/notes/AiNotesPanel.tsx');
const SETTINGS_URL = servedAt('renderer/src/notes/NotesSettings.tsx');
const NAVIGATOR_URL = servedAt('renderer/src/transcript/transcriptNavigator.ts');
const MEETING_VIEW_URL = servedAt('renderer/src/meeting/useMeeting.ts');

interface NotesHarness {
  /** The AI notes panel of the meeting, under a meeting page titled `title`. */
  panel(title: string): void;
  settings(): void;
}

declare global {
  interface Window {
    __m4t18?: { modules: unknown[]; harness?: NotesHarness };
  }
}

/** A CommonJS package as Vite's dependency cache serves it: its exports on `default`. */
interface CommonJsModule<T> {
  default: T;
}

const MEETING = PAST_MEETING.meetingId;
/** The title suggests the client call template (shared/suggestTemplate.ts: "client"). */
const TITLE = 'Acme client call: renewal and rollout check-in';
const LONG_NAME = 'Maximilian Featherstonehaugh-Worthington';

/**
 * TipTap is not in the app's module graph until M4-T20 mounts the editor, so Vite has not
 * pre-bundled it: the first import makes Vite bundle it and reload the page. One throwaway page
 * takes that reload (as e2e/m4-t17.qa.e2e.ts does); its failures are dropped on purpose, and a
 * real import error fails mountHarness on the next page, with its message.
 */
async function warmUpBundle(): Promise<void> {
  const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
  try {
    const reloaded = preview.page
      .waitForEvent('load', { timeout: 10_000 })
      .then(() => qa.settle(preview.page))
      .catch(() => undefined);
    // A string, not a function: Vitest rewrites every import() in this file for Node.
    await preview.page
      .evaluate(`import(${JSON.stringify(PANEL_URL)}).then(() => undefined)`)
      .catch(() => undefined);
    await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 3000))]);
  } finally {
    await preview.close();
  }
}

/**
 * Mounts the harness on the preview page, over the hidden app. React and ReactDOM must be the very
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
  const urls = JSON.stringify([
    ...reactUrls,
    PANEL_URL,
    SETTINGS_URL,
    NAVIGATOR_URL,
    MEETING_VIEW_URL,
  ]);
  await page.evaluate(
    `Promise.all(${urls}.map((url) => import(url))).then((modules) => { window.__m4t18 = { modules }; })`,
  );
  await page.evaluate((meetingId) => {
    const loaded = window.__m4t18;
    if (loaded === undefined) throw new Error('The panel modules did not load');
    // The modules' exports, restated: AiNotesPanel.tsx, NotesSettings.tsx,
    // transcriptNavigator.ts and meeting/useMeeting.ts are JSX or read the renderer's
    // `window.roger` type, which this program (tsconfig.e2e) does not have. Change them together.
    const [reactModule, domModule, panelModule, settingsModule, navigatorModule, viewModule] =
      loaded.modules as [
        CommonJsModule<typeof ReactNamespace>,
        CommonJsModule<typeof ReactDomClient>,
        { AiNotesPanel: ReactNamespace.ComponentType<{ meetingId: string }> },
        { NotesSettings: ReactNamespace.ComponentType },
        { CitationNavigatorProvider: ReactNamespace.ComponentType<{ children?: unknown }> },
        { MeetingViewContext: ReactNamespace.Context<unknown> },
      ];
    const { createElement, StrictMode } = reactModule.default;
    const app = document.getElementById('root');
    if (app !== null) app.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'm4-t18-harness';
    // The meeting page's notes column: its width on a laptop, the shell's 16 px gutter on a phone.
    // No colour: the page's own.
    host.style.cssText =
      'max-width: 720px; margin: 0 auto; padding: 24px 16px; box-sizing: border-box;';
    document.body.append(host);
    const root = domModule.default.createRoot(host);
    const heading = (text: string): ReactNamespace.ReactElement =>
      createElement('h1', { className: 'page-title', style: { marginBottom: '16px' } }, text);
    loaded.harness = {
      panel: (title) => {
        // What the meeting page hands its regions (MeetingView); the panel reads the title only.
        const view = {
          meetingId,
          meeting: { id: meetingId, title, startedAt: '', endedAt: '', segments: [] },
          storedLines: [],
          showHidden: false,
          setShowHidden: () => undefined,
        };
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(
              viewModule.MeetingViewContext.Provider,
              { value: view },
              createElement(
                navigatorModule.CitationNavigatorProvider,
                null,
                heading(title),
                createElement(panelModule.AiNotesPanel, { meetingId }),
              ),
            ),
          ),
        );
      },
      settings: () => {
        root.render(
          createElement(
            StrictMode,
            null,
            heading('Settings'),
            createElement(settingsModule.NotesSettings),
          ),
        );
      },
    };
  }, MEETING);
}

async function openPanel(page: Page): Promise<void> {
  await mountHarness(page);
  await page.evaluate((title) => {
    const harness = window.__m4t18?.harness;
    if (harness === undefined) throw new Error('The notes harness is not mounted');
    harness.panel(title);
  }, TITLE);
  // The panel reads main's state in an effect, then draws.
  await page.waitForSelector('#m4-t18-harness .ai-notes:not([aria-busy])');
  await qa.settle(page);
}

async function openSettings(page: Page): Promise<void> {
  await mountHarness(page);
  await page.evaluate(() => {
    const harness = window.__m4t18?.harness;
    if (harness === undefined) throw new Error('The notes harness is not mounted');
    harness.settings();
  });
  await page.waitForSelector('#m4-t18-harness .notes-settings input[type="checkbox"]');
  await qa.settle(page);
}

/** Grows the viewport to the document, so every check sees the whole panel, as the shot does. */
async function fitDocument(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The page has no fixed viewport to grow');
  const height = await page.evaluate(() => {
    window.scrollTo(0, 0);
    return Math.ceil(document.documentElement.scrollHeight);
  });
  if (height > viewport.height) await page.setViewportSize({ width: viewport.width, height });
}

const send = (page: Page, runId: string, event: NotesStreamEvent): Promise<void> =>
  qa.emitEvent(page, notesChannels.NotesEvent, { meetingId: MEETING, runId, event });

/** The run id of a generate main wrote at Stop, in the waiting and failure steps. */
const STOP_RUN = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';

/** Sends main's change of the meeting's pending generate: Stop's, unless `of` names another run. */
async function setPending(
  page: Page,
  status: PendingGenerateStatus | null,
  of: { runId: string; templateId: string } = { runId: STOP_RUN, templateId: 'client_call' },
): Promise<void> {
  const pending: PendingGenerateState | null =
    status === null
      ? null
      : {
          meetingId: MEETING,
          runId: of.runId,
          templateId: status.phase === 'needs_template' ? null : of.templateId,
          reason: 'after_stop',
          createdAt: '2026-10-06T11:10:00.000Z',
          status,
        };
  await qa.emitEvent(page, notesChannels.NotesPendingGenerateChanged, {
    meetingId: MEETING,
    pending,
  });
  await qa.settle(page);
}

/** The run id of the meeting's pending generate, as main (the fake) holds it. */
async function pendingRunId(page: Page): Promise<string> {
  const pending = await page.evaluate(
    (meetingId) => window.roger.getPendingGenerate(meetingId),
    MEETING,
  );
  if (pending === null) throw new Error('No pending generate after the pick');
  return pending.runId;
}

/** Clicks the button with exactly this text inside `scope`. */
async function press(page: Page, scope: string, text: string): Promise<void> {
  await page.locator(`${scope} button`, { hasText: text }).first().click();
  await qa.settle(page);
}

async function textOf(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((target) => document.querySelector(target)?.textContent ?? null, selector);
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
  if (actual !== expected) throw new Error(`${selector} is ${actual}, not ${token} (${expected})`);
}

// The runs ------------------------------------------------------------------------------------

/** One AI line as the API streams it: its text, cited lines (number, seconds in) and support. */
interface Line {
  text: string;
  cites: readonly (readonly [line: number, seconds: number])[];
  support: CitationSupport;
}

interface Section {
  heading: string;
  lines: readonly Line[];
}

interface RunScript {
  templateId: string;
  sections: readonly Section[];
  fromNotes: readonly string[];
  dropped: readonly { text: string; reason: 'no_refs' | 'unknown_refs' }[];
}

/** A client call's notes, with a long name, a "check this" line and lines the API removed. */
const CLIENT_CALL: RunScript = {
  templateId: 'client_call',
  sections: [
    {
      heading: 'Their goals',
      lines: [
        {
          text: 'Acme wants finance on Roger by November, once exports to their BI tool work',
          cites: [
            [41, 612],
            [42, 618],
          ],
          support: 'ok',
        },
        {
          text: 'Support uses it daily: 42 of 50 seats are active each week',
          cites: [[58, 905]],
          support: 'ok',
        },
      ],
    },
    {
      heading: 'Decisions',
      lines: [
        {
          text: 'Year-one price stays at $50k; multi-year at $47k if signed before the 30th',
          cites: [
            [102, 1730],
            [108, 1815],
          ],
          support: 'ok',
        },
        {
          text: 'Finance rollout waits on the exports, targeted for November',
          cites: [[131, 2290]],
          support: 'weak',
        },
      ],
    },
    {
      heading: 'Next steps',
      lines: [
        {
          text: `Them (${LONG_NAME}): send the security questionnaire by Wednesday`,
          cites: [[201, 3725]],
          support: 'ok',
        },
        { text: 'Me: book the follow-up for the 14th', cites: [[214, 3901]], support: 'ok' },
      ],
    },
  ],
  fromNotes: ['Ask about the Q3 renewal date', 'Check the travel budget for the November visit'],
  dropped: [
    { text: 'Everyone agreed the pilot went really well', reason: 'no_refs' },
    { text: 'Budget for next year is $2m', reason: 'unknown_refs' },
  ],
};

/** The same call written again with General, for Regenerate and Restore previous notes. */
const GENERAL: RunScript = {
  templateId: 'general',
  sections: [
    {
      heading: 'Summary',
      lines: [
        {
          text: 'Quarterly check-in on the Acme pilot, its renewal and the finance rollout',
          cites: [[3, 75]],
          support: 'ok',
        },
      ],
    },
    {
      heading: 'Decisions',
      lines: [
        {
          text: 'Price holds at $50k for year one',
          cites: [[102, 1730]],
          support: 'weak',
        },
        {
          text: 'Finance waits for the exports',
          cites: [
            [131, 2290],
            [132, 2301],
          ],
          support: 'weak',
        },
      ],
    },
    {
      heading: 'Action items',
      lines: [
        {
          text: `Them (${LONG_NAME}): security questionnaire by Wednesday`,
          cites: [[201, 3725]],
          support: 'ok',
        },
      ],
    },
  ],
  fromNotes: [],
  dropped: [],
};

function citations(line: Line): RefCitation[] {
  return line.cites.map(([number, seconds]) => ({
    ref: `L${String(number)}`,
    segmentId: segmentIdForLine(MEETING, number),
    startMs: seconds * 1000,
  }));
}

/** A run's events in the order the API sends them. */
function runEvents(runId: string, script: RunScript): NotesStreamEvent[] {
  const events: NotesStreamEvent[] = [
    {
      type: 'run',
      runId,
      model: 'xiaomi/mimo-v2.6-pro',
      templateId: script.templateId,
      lineCount: 412,
    },
  ];
  for (const [index, section] of script.sections.entries()) {
    events.push({ type: 'section', index, heading: section.heading });
    for (const line of section.lines) {
      events.push({
        type: 'item',
        section: index,
        text: line.text,
        citations: citations(line),
        support: line.support,
      });
    }
  }
  for (const line of script.fromNotes) events.push({ type: 'from_notes', text: line });
  for (const dropped of script.dropped) events.push({ type: 'dropped', ...dropped });
  return events;
}

/** The events up to and including the `lines`-th AI line, and the rest. */
function splitAfterLines(
  events: readonly NotesStreamEvent[],
  lines: number,
): [NotesStreamEvent[], NotesStreamEvent[]] {
  let seen = 0;
  const at = events.findIndex((event) => event.type === 'item' && ++seen === lines);
  return at < 0 ? [[...events], []] : [events.slice(0, at + 1), events.slice(at + 1)];
}

/** Sends events of one run as main forwards them, then lets the page draw. */
async function play(page: Page, runId: string, events: readonly NotesStreamEvent[]): Promise<void> {
  for (const event of events) await send(page, runId, event);
  await qa.settle(page);
}

const text = (value: string, marks?: NoteNode['marks']): NoteNode =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: NoteNode[]): NoteNode => ({ type: 'paragraph', content });
const bullets = (items: NoteNode[]): NoteNode => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: [content] })),
});
const heading = (value: string): NoteNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [text(value)],
});

function label(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mmss = `${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return hours > 0 ? `${String(hours)}:${mmss}` : mmss;
}

/** The doc the API saves for a run (notes_generation.py): neighbouring lines share a chip. */
function savedDoc(script: RunScript): NoteDoc {
  const chips = (line: Line): NoteNode[] => {
    const runs: (readonly [number, number])[][] = [];
    for (const cite of line.cites) {
      const last = runs.at(-1);
      const previous = last?.at(-1);
      if (last !== undefined && previous !== undefined && cite[0] === previous[0] + 1) {
        last.push(cite);
      } else {
        runs.push([cite]);
      }
    }
    return runs.map((group) => {
      const seconds = group[0]?.[1] ?? 0;
      return {
        type: CITATION_NODE_TYPE,
        attrs: {
          segmentIds: group.map(([number]) => segmentIdForLine(MEETING, number)),
          startMs: seconds * 1000,
          label: label(seconds),
          support: line.support,
        },
      };
    });
  };
  const content: NoteNode[] = script.sections.flatMap((section) => [
    heading(section.heading),
    bullets(section.lines.map((line) => paragraph(text(`${line.text} `), ...chips(line)))),
  ]);
  if (script.fromNotes.length > 0) {
    content.push(
      heading(FROM_YOUR_NOTES_HEADING),
      paragraph(text(NOT_SAID_ON_THE_CALL, [{ type: 'italic' }])),
      bullets(script.fromNotes.map((line) => paragraph(text(line)))),
    );
  }
  return { type: 'doc', content };
}

async function finish(
  page: Page,
  runId: string,
  script: RunScript,
  version: number,
): Promise<void> {
  const note: Note = {
    kind: 'ai',
    doc: savedDoc(script),
    version,
    templateId: script.templateId,
    lastRunId: runId,
    generatedVersion: version,
    updatedAt: '2026-10-06T11:12:00.000Z',
  };
  await send(page, runId, { type: 'done', runId, note });
  await page.waitForSelector('#m4-t18-harness .ai-notes-editor:not([hidden]) .note-editor-content');
  await qa.settle(page);
}

async function storedAi(page: Page): Promise<LocalNote | null> {
  const notes = await page.evaluate((meetingId) => window.roger.getNotes(meetingId), MEETING);
  return notes.ai;
}

// The run ------------------------------------------------------------------------------------

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-T18 AI notes panel', 'm4-t18');
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
    await fitDocument(preview.page);
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

const PANEL = '#m4-t18-harness .ai-notes';
/**
 * The editor's doc. The streamed lines carry its class too, to look alike, and come first: never
 * select by the class alone (the trap on StreamedNotes in AiNotesPanel.tsx).
 */
const EDITOR = `${PANEL} .ai-notes-editor .note-editor-content`;

beforeAll(async () => {
  run = await qa.startQa();
  await warmUpBundle();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m4-t18',
      Harness:
        'AiNotesPanel and NotesSettings mounted alone on the preview page until M4-T20 mounts them',
      Data: 'An hour-long client call: 6 AI lines with chips (one "check this"), 2 from your notes, 2 removed lines; a General regeneration',
    },
    'Generate, the picker, a streaming run, saved notes, a regeneration and a lost stream waiting offline, Restore previous notes, the edited-notes question, waiting and asking (the picker opened during the call stays closed), a failed run, a refused generate and a failure main retries, and Settings',
  );
  process.stdout.write(
    `\nM4-T18 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

describe.each(qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width }))))(
  'the AI notes panel in $theme at $width px',
  ({ theme, width }) => {
    const tag = `${theme}-${String(width)}`;

    it('generates, streams, saves, regenerates and restores the notes of one call', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openPanel(page);
        await shootChecked(
          preview,
          'Generate',
          `empty-${tag}`,
          'No AI notes yet and nothing pending: the empty state offers Generate notes',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-empty .note-button-primary`);
            expect(await textOf(page, `${PANEL} .ai-notes-empty .empty-state-title`)).toBe(
              'No AI notes yet',
            );
            expect(await page.locator(`${PANEL} .note-editor`).count()).toBe(0);
          },
        );

        await press(page, PANEL, 'Generate notes');
        await shootChecked(
          preview,
          'Generate',
          `picker-${tag}`,
          'Generate opens the templates, General first; the title says client call, so Client call is marked Suggested and has the focus',
          async () => {
            const names = await page
              .locator(`${PANEL} .template-option-name`)
              .evaluateAll((spans) => spans.map((span) => span.textContent));
            expect(names).toEqual(['General', 'Standup', 'Client call', '1:1']);
            await qa.expectVisible(page, `${PANEL} .template-option-suggested`);
            expect(await textOf(page, `${PANEL} .template-option-suggested`)).toContain(
              'Client callSuggested',
            );
            expect(
              await page.evaluate(() =>
                document.activeElement?.classList.contains('template-option-suggested'),
              ),
            ).toBe(true);
            await expectTokenColour(page, `${PANEL} .template-option-description`, '--muted');
          },
        );

        await press(page, PANEL, 'Client call');
        const first = await pendingRunId(page);
        await page.waitForSelector(`${PANEL} .ai-notes-progress-running`);
        await play(page, first, runEvents(first, CLIENT_CALL));
        await shootChecked(
          preview,
          'A run',
          `streaming-${tag}`,
          'The run streams: Writing your notes, three sections with their chips (one "check this"), From your notes, two removed lines, and Stop',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-stream-live`);
            expect(await textOf(page, `${PANEL} .ai-notes-progress`)).toBe('Writing your notes...');
            const headings = await page
              .locator(`${PANEL} .ai-notes-stream h2`)
              .evaluateAll((all) => all.map((h) => h.textContent));
            expect(headings).toEqual(['Their goals', 'Decisions', 'Next steps', 'From your notes']);
            expect(await page.locator(`${PANEL} .ai-notes-stream .citation-chip`).count()).toBe(7);
            expect(
              await page.locator(`${PANEL} .ai-notes-stream .citation-chip-weak`).count(),
            ).toBe(1);
            expect(await textOf(page, `${PANEL} .ai-notes-removed summary`)).toBe(
              'Removed lines (2)',
            );
            await qa.expectVisible(page, `${PANEL} .ai-notes-bar .note-button`);
            expect(await textOf(page, `${PANEL} .ai-notes-bar .note-button`)).toBe('Stop');
            await expectTokenColour(page, `${PANEL} .ai-notes-progress`, '--ink');
          },
        );

        // A chip in the streamed lines works as the editor's does: no transcript is registered
        // here, so the navigator finds none of its lines.
        await page.locator(`${PANEL} .ai-notes-stream .citation-chip`).first().click();
        await page.waitForSelector(`${PANEL} .ai-notes-stream .citation-chip-removed`);

        await finish(page, first, CLIENT_CALL, 1);
        await page.locator(`${PANEL} .ai-notes-removed summary`).click();
        await shootChecked(
          preview,
          'A run',
          `done-${tag}`,
          'Done: the saved notes in the editor (Client call, 1 line to check), Regenerate, and the removed lines opened with their reasons',
          async () => {
            await qa.expectVisible(page, EDITOR);
            expect(await page.locator(`${PANEL} .ai-notes-stream`).count()).toBe(0);
            expect(await page.locator(`${PANEL} .note-editor .citation-chip`).count()).toBe(7);
            expect(await textOf(page, `${PANEL} .ai-notes-meta`)).toBe(
              'Client call template, 1 line to check',
            );
            expect(
              await page.locator(`${PANEL} .ai-notes-bar .note-button`).allTextContents(),
            ).toEqual(['Regenerate']);
            expect(await textOf(page, `${PANEL} .ai-notes-removed-list`)).toContain(
              '(cited lines that are not in the transcript)',
            );
            expect(await page.getAttribute(EDITOR, 'contenteditable')).toBe('true');
            await expectTokenColour(page, `${PANEL} .ai-notes-meta`, '--muted');
          },
        );

        await press(page, `${PANEL} .ai-notes-bar`, 'Regenerate');
        await press(page, PANEL, 'General');
        const second = await pendingRunId(page);
        expect(second).not.toBe(first);
        const [early, rest] = splitAfterLines(runEvents(second, GENERAL), 2);
        await play(page, second, early);
        await shootChecked(
          preview,
          'Regenerate',
          `regenerating-${tag}`,
          'Regenerating as General: the bar names the new template, the new lines stream, and the saved notes stay mounted under them, hidden and read-only',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-stream-live`);
            expect(await textOf(page, `${PANEL} .ai-notes-meta`)).toBe('General template');
            expect(await page.locator(`${PANEL} .ai-notes-editor[hidden]`).count()).toBe(1);
            expect(await page.getAttribute(EDITOR, 'contenteditable')).toBe('false');
            expect(await page.isVisible(EDITOR)).toBe(false);
          },
        );

        // The stream drops with no event, and main's poll cannot reach the API: the same
        // generate now waits offline. Its half-written lines must not hold the notes hidden.
        await setPending(
          page,
          { phase: 'waiting_for_notes', cause: 'offline' },
          { runId: second, templateId: 'general' },
        );
        await shootChecked(
          preview,
          'Regenerate',
          `offline-${tag}`,
          'The stream was lost and main could not reach the API: the generate waits offline, with Cancel, and the saved Client call notes are back, shown and editable',
          async () => {
            expect(await page.locator(`${PANEL} .ai-notes-stream`).count()).toBe(0);
            await qa.expectVisible(page, EDITOR);
            expect(await page.getAttribute(EDITOR, 'contenteditable')).toBe('true');
            expect(await textOf(page, `${PANEL} .ai-notes-progress`)).toBe(
              'Roger is offline; notes will generate when it is back.',
            );
            expect(await textOf(page, `${PANEL} .ai-notes-bar .note-button`)).toBe('Cancel');
            expect(await textOf(page, `${PANEL} .ai-notes-meta`)).toBe(
              'Client call template, 1 line to check',
            );
          },
        );

        // Back online: the next attempt re-sends the run id, and its `run` event starts the
        // lines again. Only that event is sent again: the fake counts a line's "check this" each
        // time it hears the line, and the saved notes below would claim 3 lines to check, not 2.
        await setPending(page, { phase: 'running' }, { runId: second, templateId: 'general' });
        await play(page, second, early.slice(0, 1));
        await qa.expectVisible(page, `${PANEL} .ai-notes-stream-live`);
        expect(await page.locator(`${PANEL} .ai-notes-editor[hidden]`).count()).toBe(1);
        await play(page, second, rest);
        await finish(page, second, GENERAL, 2);
        await page.waitForSelector(
          `${PANEL} .ai-notes-bar button:has-text("Restore previous notes")`,
        );
        await shootChecked(
          preview,
          'Regenerate',
          `regenerated-${tag}`,
          'The General notes are saved, and the run kept the notes it replaced: Restore previous notes',
          async () => {
            expect(await textOf(page, `${PANEL} .ai-notes-meta`)).toBe(
              'General template, 2 lines to check',
            );
            expect(await textOf(page, EDITOR)).toContain('Price holds at $50k for year one');
            await qa.expectVisible(page, `${PANEL} .ai-notes-bar .note-button:nth-of-type(2)`);
          },
        );

        await press(page, `${PANEL} .ai-notes-bar`, 'Restore previous notes');
        await page.waitForFunction(
          (selector) => document.querySelector(selector)?.textContent.includes('Their goals'),
          EDITOR,
        );
        await qa.settle(page);
        await shootChecked(
          preview,
          'Regenerate',
          `restored-${tag}`,
          'Restore previous notes put the Client call notes back as a new local version: saved on this Mac, nothing left to restore, and the bar no longer claims the General run wrote them',
          async () => {
            expect(await textOf(page, EDITOR)).not.toContain('Price holds');
            expect(await page.locator(`${PANEL} .ai-notes-meta`).count()).toBe(0);
            const stored = await storedAi(page);
            expect(stored?.dirty).toBe(true);
            expect(stored?.sync).toBe('saved_locally');
            expect(await textOf(page, `${PANEL} .note-status`)).toBe('Saved on this Mac');
            expect(
              await page.locator(`${PANEL} .ai-notes-bar .note-button`).allTextContents(),
            ).toEqual(['Regenerate']);
          },
        );

        // The restored notes are edited since their run: Regenerate asks first.
        await press(page, `${PANEL} .ai-notes-bar`, 'Regenerate');
        await press(page, PANEL, 'Standup');
        await shootChecked(
          preview,
          'Regenerate',
          `confirm-${tag}`,
          'AI notes edited since their run: Regenerate asks first, with Regenerate as Standup and Keep my edits; nothing is sent yet',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-confirm`);
            expect(
              await page.locator(`${PANEL} .ai-notes-confirm button`).allTextContents(),
            ).toEqual(['Regenerate as Standup', 'Keep my edits']);
            expect(
              await page.evaluate((id) => window.roger.getPendingGenerate(id), MEETING),
            ).toBeNull();
            await expectTokenColour(page, `${PANEL} .ai-notes-confirm-text`, '--ink');
          },
        );
        await press(page, `${PANEL} .ai-notes-confirm`, 'Keep my edits');
        expect(await page.locator(`${PANEL} .ai-notes-confirm`).count()).toBe(0);
        expect(
          await page.evaluate((id) => window.roger.getPendingGenerate(id), MEETING),
        ).toBeNull();
      } finally {
        await preview.close();
      }
    });

    it('says what a pending generate waits for, and asks which kind of call it was', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openPanel(page);
        // During the call the user opens the picker, then Stop writes a generate (auto-generate).
        await press(page, PANEL, 'Generate notes');
        await qa.expectVisible(page, `${PANEL} .template-picker`);
        await setPending(page, { phase: 'waiting_for_lines', waitingLines: 12 });
        await shootChecked(
          preview,
          'Waiting and asking',
          `waiting-${tag}`,
          'Generate after Stop, waiting for the call to upload: 12 lines to go, with Cancel; the picker opened during the call is closed',
          async () => {
            expect(await page.locator(`${PANEL} .template-picker`).count()).toBe(0);
            await qa.expectVisible(page, `${PANEL} .ai-notes-progress`);
            expect(await textOf(page, `${PANEL} .ai-notes-progress`)).toBe(
              'Notes will generate when 12 lines finish uploading.',
            );
            expect(await textOf(page, `${PANEL} .ai-notes-bar .note-button`)).toBe('Cancel');
            expect(await page.locator(`${PANEL} .ai-notes-empty`).count()).toBe(0);
          },
        );

        await setPending(page, { phase: 'needs_template' });
        await shootChecked(
          preview,
          'Waiting and asking',
          `ask-${tag}`,
          'Roger could not tell at Stop: "Which kind of call was this?" with the four templates, none marked, and Not now',
          async () => {
            await qa.expectVisible(page, `${PANEL} .template-picker`);
            expect(await textOf(page, `${PANEL} .template-picker-question`)).toBe(
              'Which kind of call was this?',
            );
            expect(await page.locator(`${PANEL} .template-option`).count()).toBe(4);
            expect(await page.locator(`${PANEL} .template-option-badge`).count()).toBe(0);
            expect(await textOf(page, `${PANEL} .template-picker-actions button`)).toBe('Not now');
          },
        );

        // The answer keeps the generate's run id: an attempt may already have reached the API.
        await press(page, PANEL, 'Standup');
        await page.waitForSelector(`${PANEL} .ai-notes-progress-running`);
        const pending = await page.evaluate((id) => window.roger.getPendingGenerate(id), MEETING);
        expect(pending?.runId).toBe(STOP_RUN);
        expect(pending?.templateId).toBe('standup');

        // The generate ends: the picker opened before it started stays closed for good, or a
        // stray Enter on its focused template would start a second run.
        await press(page, `${PANEL} .ai-notes-bar`, 'Stop');
        await page.waitForSelector(`${PANEL} .ai-notes-empty`);
        await shootChecked(
          preview,
          'Waiting and asking',
          `stopped-${tag}`,
          'Stopped: the cancel notice and the empty state with Generate notes; the picker opened during the call does not come back',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-empty .note-button-primary`);
            expect(await page.locator(`${PANEL} .template-picker`).count()).toBe(0);
            expect(await textOf(page, `${PANEL} .ai-notes-failure-title`)).toBe(
              'Notes generation was cancelled.',
            );
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('keeps the partial lines of a failed run under its banner, and Retry starts again', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openPanel(page);
        await press(page, PANEL, 'Generate notes');
        await press(page, PANEL, 'Client call');
        const failed = await pendingRunId(page);
        await play(page, failed, splitAfterLines(runEvents(failed, CLIENT_CALL), 3)[0]);
        await send(page, failed, {
          type: 'error',
          code: 'llm_provider_error',
          message: 'No endpoint answered: the zero-retention providers for this model are down.',
        });
        await page.waitForSelector(`${PANEL} .ai-notes-failure`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Failure path',
          `failed-${tag}`,
          'The AI service failed mid-run: the error banner with the reason, Retry and Dismiss, and the three lines written before it stopped, marked not saved',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-failure .note-button-primary`);
            expect(await textOf(page, `${PANEL} .ai-notes-failure-title`)).toBe(
              'The AI service could not write the notes.',
            );
            expect(await textOf(page, `${PANEL} .ai-notes-failure-detail`)).toContain(
              'zero-retention providers',
            );
            expect(await page.getAttribute(`${PANEL} .ai-notes-failure`, 'role')).toBe('alert');
            await qa.expectVisible(page, `${PANEL} .ai-notes-stream-partial`);
            expect(await page.locator(`${PANEL} .ai-notes-stream li`).count()).toBe(3);
            expect(await textOf(page, `${PANEL} .ai-notes-stream-caption`)).toBe(
              'Written before the run stopped. Not saved.',
            );
            await expectTokenColour(page, `${PANEL} .ai-notes-failure-title`, '--danger-ink');
          },
        );

        await press(page, `${PANEL} .ai-notes-failure`, 'Retry');
        await page.waitForSelector(`${PANEL} .ai-notes-progress-running`);
        expect(await page.locator(`${PANEL} .ai-notes-failure`).count()).toBe(0);
        expect(await page.locator(`${PANEL} .ai-notes-stream`).count()).toBe(0);
        // Retry after a failed run takes a new run id: the API would replay the failure.
        expect(await pendingRunId(page)).not.toBe(failed);

        // Main refuses a generate while the API may hold a run in another template.
        await press(page, `${PANEL} .ai-notes-bar`, 'Stop');
        await page.waitForSelector(`${PANEL} .ai-notes-empty`);
        await press(page, PANEL, 'Generate notes');
        await qa.failNextRequest(
          page,
          `the notes of meeting ${MEETING} may already be generating as client_call: cancel them before picking another template`,
        );
        await press(page, PANEL, 'Standup');
        await shootChecked(
          preview,
          'Failure path',
          `refused-${tag}`,
          'main refused the generate: the panel says why (cancel the run that may already be generating first), with Dismiss',
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-error`);
            expect(await textOf(page, `${PANEL} .ai-notes-error span`)).toBe(
              `Roger could not start the notes: the notes of meeting ${MEETING} may already be generating as client_call: cancel them before picking another template`,
            );
            await expectTokenColour(page, `${PANEL} .ai-notes-error`, '--danger-ink');
          },
        );

        // A local error in main: not stored, and main tries the generate again every 30 s.
        await press(page, `${PANEL} .ai-notes-error`, 'Dismiss');
        await setPending(page, {
          phase: 'failed',
          code: 'internal_error',
          message: 'Roger could not generate the notes. It will try again.',
        });
        await shootChecked(
          preview,
          'Failure path',
          `retrying-${tag}`,
          "main's own failure, which it tries again by itself: the banner says so, with Retry and Cancel (not Dismiss, which would quietly drop the generate)",
          async () => {
            await qa.expectVisible(page, `${PANEL} .ai-notes-failure .note-button-primary`);
            expect(await textOf(page, `${PANEL} .ai-notes-failure-title`)).toBe(
              'Roger could not generate the notes.',
            );
            expect(await textOf(page, `${PANEL} .ai-notes-failure-detail`)).toBe(
              'It will try again.',
            );
            expect(
              await page.locator(`${PANEL} .ai-notes-failure button`).allTextContents(),
            ).toEqual(['Retry', 'Cancel']);
            expect(await page.locator(`${PANEL} .ai-notes-failure`).count()).toBe(1);
            await expectTokenColour(page, `${PANEL} .ai-notes-failure-detail`, '--ink');
          },
        );
        await press(page, `${PANEL} .ai-notes-failure`, 'Cancel');
        await page.waitForSelector(`${PANEL} .ai-notes-empty`);
        expect(await page.locator(`${PANEL} .ai-notes-failure`).count()).toBe(0);
        expect(
          await page.evaluate((id) => window.roger.getPendingGenerate(id), MEETING),
        ).toBeNull();
      } finally {
        await preview.close();
      }
    });

    it('shows the notes settings and saves a change', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openSettings(page);
        const settings = '#m4-t18-harness .notes-settings';
        await shootChecked(
          preview,
          'Settings',
          `settings-${tag}`,
          'Settings, Notes: write AI notes when a call stops (on), and what Roger does when it cannot tell the kind of call (ask)',
          async () => {
            await qa.expectVisible(page, `${settings} input[type="checkbox"]`);
            expect(await page.isChecked(`${settings} input[type="checkbox"]`)).toBe(true);
            expect(await page.isChecked(`${settings} input[value="ask"]`)).toBe(true);
            expect(await page.isDisabled(`${settings} input[value="general"]`)).toBe(false);
            await expectTokenColour(page, `${settings} .notes-settings-hint`, '--muted');
          },
        );

        await page.click(`${settings} input[value="general"]`);
        await page.waitForFunction(
          (selector) => document.querySelector<HTMLInputElement>(selector)?.checked === true,
          `${settings} input[value="general"]`,
        );
        await page.click(`${settings} input[type="checkbox"]`);
        await page.waitForSelector(`${settings} fieldset[disabled]`);
        const stored = await page.evaluate(() => window.roger.getPreferences());
        expect(stored['notes.autoGenerate']).toBe(false);
        expect(stored['notes.whenUnsure']).toBe('general');
        qa.expectNoConsoleErrors(preview);
      } finally {
        await preview.close();
      }
    });
  },
);

describe('the notes settings when main refuses a change', () => {
  it('keeps the stored value and says why', async () => {
    const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
    const { page } = preview;
    try {
      await openSettings(page);
      const settings = '#m4-t18-harness .notes-settings';
      await qa.failNextRequest(page, 'preferences.json could not be written: disk full');
      await page.click(`${settings} input[type="checkbox"]`);
      await page.waitForSelector(`${settings} .notes-settings-error`);
      expect(await textOf(page, `${settings} .notes-settings-error`)).toBe(
        'Roger could not save that setting: preferences.json could not be written: disk full',
      );
      expect(await page.isChecked(`${settings} input[type="checkbox"]`)).toBe(true);
      // A change main makes still shows.
      await qa.emitEvent(page, prefsChannels.PrefsChanged, {
        key: 'notes.whenUnsure',
        value: 'general',
      });
      await qa.settle(page);
      expect(await page.isChecked(`${settings} input[value="general"]`)).toBe(true);
      qa.expectNoConsoleErrors(preview);
    } finally {
      await preview.close();
    }
  });
});
