import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import type * as ReactNamespace from 'react';
import type * as ReactDomClient from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { RogerApi } from '../src/shared/ipc';
import { notesChannels, type NotesFlush } from '../src/shared/ipc/notes';
import {
  CITATION_NODE_TYPE,
  FROM_YOUR_NOTES_HEADING,
  type LocalNote,
  type MeetingNotes,
  NOT_SAID_ON_THE_CALL,
  type NoteDoc,
  type NoteKind,
  type NoteNode,
} from '../src/shared/notes';

/*
 * Browser QA for M4-T17's notes editor (qa/README.md): both themes, 1440 and 390 wide, long
 * realistic notes with citation chips, typing into empty notes, the Tab cap on deep lists, a
 * conflict, a doc the editor cannot hold (alone, and as a conflict's other version), and a save
 * that fails; then, once, the quit flush, the pagehide save and read-only AI notes.
 *
 * Nothing mounts NoteEditor in the app until M4-T20, so this script mounts "My notes" and "AI
 * notes" alone on the preview's `empty-mac` page, inside the navigator provider the meeting page
 * gives them, with the app's own React, styles and theme, and drives them through the preview's
 * fake `window.roger`: the notes it loads are the ones main sends. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m4-t17.qa.e2e.ts
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
/** Vite serves files outside the preview root under /@fs/ plus their absolute path. */
const servedAt = (path: string): string => `/@fs${SOURCE_ROOT}${path}`;
const RENDERER_ENTRY_URL = servedAt('renderer/src/main.tsx');
const EDITOR_URL = servedAt('renderer/src/notes/NoteEditor.tsx');
const NAVIGATOR_URL = servedAt('renderer/src/transcript/transcriptNavigator.ts');

/**
 * NoteEditor's props (src/renderer/src/notes/NoteEditor.tsx), restated: that file is JSX and reads
 * the renderer's `window.roger` type, neither of which this program (tsconfig.e2e) has. Change
 * both together.
 */
interface EditorProps {
  meetingId: string;
  kind: NoteKind;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
}

interface NotesHarness {
  render(title: string, panes: EditorProps[]): void;
}

declare global {
  interface Window {
    /** The preview's fake (preview/main.tsx), as src/renderer/src/roger.d.ts types it. */
    roger: RogerApi;
    __m4t17?: { modules: unknown[]; harness?: NotesHarness; acks: NotesFlush[] };
  }
}

/** A CommonJS package as Vite's dependency cache serves it: its exports on `default`. */
interface CommonJsModule<T> {
  default: T;
}

const MEETING = PAST_MEETING.meetingId;
/** The page title over the panes: the notes below are a client call's, whatever the fixture says. */
const TITLE = 'Acme renewal, quarterly check-in';
const MY_NOTES = 'My notes';
const AI_NOTES = 'AI notes';
const PLACEHOLDER = 'Type your notes. Roger turns them into clean notes after the call.';

/**
 * TipTap is not in the app's module graph until M4-T20 mounts the editor, so Vite has not
 * pre-bundled it: the first import makes Vite bundle it and reload the page (the reload drops the
 * page's state, and a page.evaluate in flight throws "Execution context was destroyed"). One
 * throwaway page takes that reload; every page after loads the new bundle from the start. Its
 * failures are dropped on purpose: the reload is expected, no reload (a warm cache) is fine, and a
 * real import error fails mountHarness on the next page, with its message.
 */
async function warmUpEditorBundle(): Promise<void> {
  const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
  try {
    const reloaded = preview.page
      .waitForEvent('load', { timeout: 10_000 })
      .then(() => qa.settle(preview.page))
      .catch(() => undefined);
    // A string, not a function: Vitest rewrites every import() in this file for Node.
    await preview.page
      .evaluate(`import(${JSON.stringify(EDITOR_URL)}).then(() => undefined)`)
      .catch(() => undefined);
    await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 3000))]);
  } finally {
    await preview.close();
  }
}

/**
 * Mounts the harness on the preview page, over the hidden app. React and ReactDOM must be the very
 * modules the app loaded (the URLs with Vite's version hash), or the editor's hooks run against a
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
  // (`__vite_ssr_dynamic_import__`), and page.evaluate sends a function as its compiled text.
  const urls = JSON.stringify([...reactUrls, EDITOR_URL, NAVIGATOR_URL]);
  await page.evaluate(
    `Promise.all(${urls}.map((url) => import(url))).then((modules) => { window.__m4t17 = { modules, acks: [] }; })`,
  );
  await page.evaluate(() => {
    const loaded = window.__m4t17;
    if (loaded === undefined) throw new Error('The editor modules did not load');
    const [reactModule, domModule, editorModule, navigatorModule] = loaded.modules as [
      CommonJsModule<typeof ReactNamespace>,
      CommonJsModule<typeof ReactDomClient>,
      { NoteEditor: ReactNamespace.ComponentType<EditorProps> },
      { CitationNavigatorProvider: ReactNamespace.ComponentType<{ children?: unknown }> },
    ];
    const { createElement, StrictMode } = reactModule.default;
    // main's quit hook waits for this ack; recorded here so a check can see it arrive.
    const ack = window.roger.ackNotesFlush.bind(window.roger);
    window.roger.ackNotesFlush = (flush) => {
      loaded.acks.push(flush);
      ack(flush);
    };
    const app = document.getElementById('root');
    if (app !== null) app.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'm4-t17-harness';
    // The shell page's box and gutters; no colour: the page's own. Two panes side by side when
    // they fit, stacked on a phone.
    host.style.cssText =
      'max-width: 1180px; margin: 0 auto; padding: 24px 16px; box-sizing: border-box;';
    document.body.append(host);
    const root = domModule.default.createRoot(host);
    loaded.harness = {
      render: (title, panes) => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(
              navigatorModule.CitationNavigatorProvider,
              null,
              createElement('h1', { className: 'page-title' }, title),
              createElement(
                'div',
                {
                  style: {
                    display: 'grid',
                    gap: '24px',
                    marginTop: '16px',
                    alignItems: 'start',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
                  },
                },
                ...panes.map((pane) =>
                  createElement(
                    'div',
                    { key: pane.kind, style: { minWidth: 0 } },
                    createElement(
                      'h2',
                      { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 650 } },
                      pane.label,
                    ),
                    createElement(editorModule.NoteEditor, pane),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    };
  });
}

/** Seeds the notes main holds for the meeting, then mounts the editors over them. */
async function openNotes(
  page: Page,
  notes: readonly LocalNote[],
  panes: EditorProps[] = [pane('user'), pane('ai')],
): Promise<void> {
  await mountHarness(page);
  // The fake answers getNotes from the changes it has seen, as notes.sqlite holds what main saved.
  for (const note of notes) await qa.emitEvent(page, notesChannels.NotesChanged, note);
  await page.evaluate(
    ({ title, editors }) => {
      const harness = window.__m4t17?.harness;
      if (harness === undefined) throw new Error('The notes harness is not mounted');
      harness.render(title, editors);
    },
    { title: TITLE, editors: panes },
  );
  // Each editor loads in an effect, then draws: wait for both to leave "Opening notes".
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('#m4-t17-harness .note-editor').length === count &&
      document.querySelectorAll('#m4-t17-harness .note-editor[aria-busy]').length === 0,
    panes.length,
  );
  await qa.settle(page);
}

function pane(kind: NoteKind, extra: Partial<EditorProps> = {}): EditorProps {
  return kind === 'user'
    ? { meetingId: MEETING, kind, label: MY_NOTES, placeholder: PLACEHOLDER, ...extra }
    : { meetingId: MEETING, kind, label: AI_NOTES, ...extra };
}

const editorOf = (label: string): string => `section[aria-label="${label}"]`;
const contentOf = (label: string): string => `${editorOf(label)} .note-editor-content`;

async function statusOf(page: Page, label: string): Promise<string | null> {
  return page.evaluate(
    (selector) => document.querySelector(selector)?.textContent ?? null,
    `${editorOf(label)} .note-status`,
  );
}

async function waitForStatus(page: Page, label: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, wanted }) => document.querySelector(selector)?.textContent === wanted,
    { selector: `${editorOf(label)} .note-status`, wanted: text },
  );
}

/** What main's notes.sqlite holds for the meeting now (the fake's answer to getNotes). */
async function storedNotes(page: Page): Promise<MeetingNotes> {
  return page.evaluate((meetingId) => window.roger.getNotes(meetingId), MEETING);
}

/** All the text of a stored doc, for checks on what was saved. */
function docText(doc: NoteDoc | undefined): string {
  const textOf = (node: NoteNode): string =>
    node.text ?? (node.content ?? []).map(textOf).join(' ');
  return (doc?.content ?? []).map(textOf).join(' ');
}

/**
 * Scrolls the first `selector` to the middle of the window, as a person scrolls to it: at 390 px
 * the AI notes sit below My notes. The shot after it starts from the top again.
 */
async function scrollToMiddle(page: Page, selector: string): Promise<void> {
  await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) throw new Error(`No ${target} to scroll to`);
    element.scrollIntoView({ block: 'center' });
  }, selector);
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

/** The deepest list item in an editor, counted in nested `li` elements. */
async function deepestListItem(page: Page, label: string): Promise<number> {
  return page.evaluate((selector) => {
    const depthOf = (item: Element): number => {
      let depth = 0;
      for (
        let at: Element | null = item;
        at !== null;
        at = at.parentElement?.closest('li') ?? null
      ) {
        depth += 1;
      }
      return depth;
    };
    const items = [...document.querySelectorAll(`${selector} li`)];
    return items.reduce((deepest, item) => Math.max(deepest, depthOf(item)), 0);
  }, contentOf(label));
}

// Notes ------------------------------------------------------------------------------------------

const text = (value: string, marks?: NoteNode['marks']): NoteNode =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: NoteNode[]): NoteNode => ({ type: 'paragraph', content });
const heading = (level: number, value: string): NoteNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const item = (...content: NoteNode[]): NoteNode => ({ type: 'listItem', content });
const bullets = (...items: NoteNode[]): NoteNode => ({ type: 'bulletList', content: items });
const numbered = (...items: NoteNode[]): NoteNode => ({
  type: 'orderedList',
  attrs: { start: 1, type: null },
  content: items,
});
const bold = [{ type: 'bold' }];
const italic = [{ type: 'italic' }];

/** A chip citing line `line` of the past meeting, at `seconds` into the call. */
function chip(line: number, seconds: number, support: 'ok' | 'weak' = 'ok'): NoteNode {
  const minutes = Math.floor(seconds / 60);
  const label =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return {
    type: CITATION_NODE_TYPE,
    attrs: {
      segmentIds: [segmentIdForLine(MEETING, line)],
      startMs: seconds * 1000,
      label,
      support,
    },
  };
}

const LONG_LINK =
  'https://northwind.example.com/legal/contracts/2026/renewal/data-processing-addendum-v7-final-countersigned-by-procurement.pdf';
const LONG_NAME = 'Maximilian Featherstonehaugh-Worthington';

/** Rough notes as typed during an hour-long client call: headings, lists three deep, a long link. */
const LONG_MY_NOTES: NoteDoc = {
  type: 'doc',
  content: [
    heading(2, 'Acme renewal, quarterly check-in'),
    paragraph(
      text('Attendees: Priya (Acme ops), '),
      text(LONG_NAME, bold),
      text(
        ' (procurement), Sam, me. Priya joined late from the airport, audio rough for the first ten minutes.',
      ),
    ),
    heading(3, 'Agenda'),
    numbered(
      item(paragraph(text('Pilot results and the usage numbers since July'))),
      item(paragraph(text('Renewal terms: seats, price, the security questionnaire'))),
      item(paragraph(text('Rollout plan for the two remaining regions'))),
    ),
    heading(3, 'Discussion'),
    bullets(
      item(
        paragraph(text('Pilot went well overall, '), text('42 of 50 seats active weekly', bold)),
        bullets(
          item(
            paragraph(text('Support team uses it most; finance barely logged in')),
            bullets(item(paragraph(text('Finance wants exports to their BI tool first', italic)))),
          ),
          item(paragraph(text('Two complaints about search being slow on long calls'))),
        ),
      ),
      item(
        paragraph(text('Price: they push for $45k, we said $50k holds for year one')),
        bullets(item(paragraph(text('Possible: multi-year at $47k if they sign before the 30th')))),
      ),
      item(
        paragraph(
          text('Security questionnaire due Wednesday, '),
          text(LONG_NAME),
          text(' owns it on their side'),
        ),
      ),
      item(
        paragraph(text('Countersigned DPA: '), {
          type: 'text',
          text: LONG_LINK,
          marks: [
            {
              type: 'link',
              attrs: {
                href: LONG_LINK,
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: null,
                title: null,
              },
            },
          ],
        }),
      ),
    ),
    {
      type: 'blockquote',
      content: [
        paragraph(
          text('"If the exports land by October we can roll out to finance in November." - Priya'),
        ),
      ],
    },
    { type: 'horizontalRule' },
    heading(3, 'Follow-ups'),
    bullets(
      item(paragraph(text('Me: book the follow-up for the 14th'))),
      item(
        paragraph(text('Sam: send the deck and the '), text('usage export', [{ type: 'code' }])),
      ),
      item(paragraph(text('Ask about the Q3 renewal date, nobody had it'))),
    ),
  ],
};

/** AI notes in the API's shape (apps/api/tests/fixtures/ai_notes_doc.json), much longer. */
const LONG_AI_NOTES: NoteDoc = {
  type: 'doc',
  content: [
    heading(2, 'Summary'),
    bullets(
      item(
        paragraph(
          text(
            'Quarterly check-in on the Acme pilot and its renewal; procurement joined for pricing ',
          ),
          chip(3, 75),
        ),
      ),
      item(
        paragraph(
          text('Pilot usage is strong in support and weak in finance, who need BI exports first '),
          chip(41, 612),
          chip(44, 655),
        ),
      ),
      item(paragraph(text('Search on long calls was raised as slow twice '), chip(58, 905))),
    ),
    heading(2, 'Decisions'),
    bullets(
      item(
        paragraph(
          text('Year-one price stays at $50k; multi-year at $47k if signed before the 30th '),
          chip(102, 1730),
          chip(108, 1815),
        ),
      ),
      item(
        paragraph(
          text('Finance rollout waits on the exports, targeted for November '),
          chip(131, 2290, 'weak'),
        ),
      ),
      item(
        paragraph(
          text('The two remaining regions roll out in the order support asked for '),
          chip(150, 2602),
        ),
      ),
    ),
    heading(2, 'Action items'),
    bullets(
      item(
        paragraph(
          text(`Them (${LONG_NAME}): send the security questionnaire by Wednesday `),
          chip(201, 3725),
        ),
      ),
      item(paragraph(text('Me: book the follow-up for the 14th '), chip(214, 3901, 'weak'))),
      item(paragraph(text('Sam: send the deck and the usage export '), chip(220, 4012))),
      item(paragraph(text('Them: confirm which BI tool finance uses '), chip(47, 701))),
    ),
    heading(2, FROM_YOUR_NOTES_HEADING),
    paragraph(text(NOT_SAID_ON_THE_CALL, italic)),
    bullets(
      item(paragraph(text('Ask about the Q3 renewal date'))),
      item(paragraph(text('Check the travel budget for the November visit'))),
    ),
  ],
};

/** The server's version after a conflict, and the local one main kept as its copy. */
const THEIR_NOTES: NoteDoc = {
  type: 'doc',
  content: [
    heading(3, 'Follow-ups'),
    bullets(item(paragraph(text('Sam: send the deck (edited on the web)')))),
  ],
};
const MY_COPY: NoteDoc = {
  type: 'doc',
  content: [
    heading(3, 'Follow-ups'),
    bullets(
      item(paragraph(text('Me: book the follow-up for the 14th'))),
      item(paragraph(text('Ask about the Q3 renewal date'))),
    ),
  ],
};

/** A doc main holds but the editor cannot: a list item that does not start with a paragraph. */
const UNSHOWABLE: NoteDoc = {
  type: 'doc',
  content: [bullets(item(bullets(item(paragraph(text('nested without a paragraph'))))))],
};

function stored(kind: NoteKind, doc: NoteDoc, extra: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: MEETING,
    kind,
    doc,
    revisionId: null,
    dirty: false,
    baseVersion: 4,
    templateId: kind === 'ai' ? 'client_call' : null,
    lastRunId: kind === 'ai' ? '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11' : null,
    generatedVersion: kind === 'ai' ? 4 : null,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T11:12:00.000Z',
    ...extra,
  };
}

// The run --------------------------------------------------------------------------------------

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-T17 notes editor', 'm4-t17');
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
  await warmUpEditorBundle();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m4-t17',
      Harness: 'NoteEditor mounted alone on the preview page until M4-T20 mounts it',
      Data: 'An hour-long client call: rough notes three lists deep with a long link, AI notes with 12 chips',
    },
    'Long notes, chips, typing and saving, the Tab cap, a conflict, an unshowable doc (alone and in a conflict) and a failed save',
  );
  process.stdout.write(
    `\nM4-T17 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

describe.each(qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width }))))(
  'the notes editor in $theme at $width px',
  ({ theme, width }) => {
    const tag = `${theme}-${String(width)}`;

    it('shows long notes with their chips, and a chip whose line is gone', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openNotes(page, [stored('user', LONG_MY_NOTES), stored('ai', LONG_AI_NOTES)]);
        await shootChecked(
          preview,
          'Long notes',
          `long-${tag}`,
          'An hour-long client call: rough notes (headings, lists three deep, a long link) beside AI notes with chips, two marked "check this", and the From your notes list',
          async () => {
            await qa.expectVisible(page, contentOf(MY_NOTES));
            await scrollToMiddle(page, `${editorOf(AI_NOTES)} .citation-chip`);
            await qa.expectVisible(page, `${editorOf(AI_NOTES)} .citation-chip`);
            expect(await page.locator(`${editorOf(AI_NOTES)} .citation-chip`).count()).toBe(12);
            expect(await page.locator(`${editorOf(AI_NOTES)} .citation-chip-weak`).count()).toBe(2);
            expect(await statusOf(page, MY_NOTES)).toBe('Synced');
            expect(await statusOf(page, AI_NOTES)).toBe('Synced');
            expect(await deepestListItem(page, MY_NOTES)).toBe(3);
            await expectTokenColour(page, `${editorOf(AI_NOTES)} .citation-chip`, '--ink');
            await expectTokenColour(page, `${editorOf(MY_NOTES)} .note-status`, '--muted');
            await expectTokenColour(page, `${contentOf(MY_NOTES)} a`, '--accent-ink');
            await expectTokenColour(page, contentOf(MY_NOTES), '--ink');
          },
        );

        // The first click into freshly opened notes, on an atom: it once threw (NoteEditor.tsx,
        // the trailing paragraph), and the shot below fails on any page error.
        await page.click(`${contentOf(MY_NOTES)} hr`);
        // The harness registers no transcript, so the navigator finds none of the lines.
        await page.click(`${editorOf(AI_NOTES)} .citation-chip >> nth=0`);
        await shootChecked(
          preview,
          'Long notes',
          `chip-removed-${tag}`,
          'The rule in My notes, then the first chip clicked with no transcript holding its line: it says "Line removed", its time struck through, and nothing threw',
          async () => {
            const first = `${editorOf(AI_NOTES)} .citation-chip`;
            await page.waitForSelector(`${first}.citation-chip-removed`);
            expect(await page.textContent(first)).toBe('01:15Line removed');
            await qa.expectVisible(page, `${first}.citation-chip-removed`);
            await expectTokenColour(page, `${first}.citation-chip-removed`, '--muted');
            // The other chips are unchanged.
            expect(await page.locator(`${editorOf(AI_NOTES)} .citation-chip-removed`).count()).toBe(
              1,
            );
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('types into empty notes, saves them, and caps Tab at 13 list levels', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openNotes(page, [], [pane('user')]);
        await shootChecked(
          preview,
          'Typing and saving',
          `empty-${tag}`,
          'A meeting with no notes yet: the placeholder, and no save state',
          async () => {
            await qa.expectVisible(page, contentOf(MY_NOTES));
            expect(await statusOf(page, MY_NOTES)).toBeNull();
            const placeholder = await page.getAttribute(
              `${contentOf(MY_NOTES)} p.is-editor-empty`,
              'data-placeholder',
            );
            expect(placeholder).toBe(PLACEHOLDER);
          },
        );

        await page.click(contentOf(MY_NOTES));
        await page.keyboard.type('Priya: exports first, then finance rollout in November.');
        await page.keyboard.press('Enter');
        await page.keyboard.type('- Price holds at $50k for year one');
        await waitForStatus(page, MY_NOTES, 'Saved on this Mac');
        await shootChecked(
          preview,
          'Typing and saving',
          `typed-${tag}`,
          'Typed into the empty notes: "- " started a list, and 400 ms after the last key the note is saved on this Mac',
          async () => {
            const notes = await storedNotes(page);
            expect(docText(notes.user?.doc)).toContain('Price holds at $50k for year one');
            expect(notes.user?.sync).toBe('saved_locally');
            await expectTokenColour(page, `${editorOf(MY_NOTES)} .note-status`, '--muted');
          },
        );

        // Fifteen levels asked for: Tab sinks each new item under the one before, up to 13.
        for (let level = 2; level <= 15; level += 1) {
          await page.keyboard.press('Enter');
          await page.keyboard.press('Tab');
          await page.keyboard.type(`level ${String(level)}`);
        }
        await waitForStatus(page, MY_NOTES, 'Saved on this Mac');
        await shootChecked(
          preview,
          'Typing and saving',
          `tab-cap-${tag}`,
          'Tab pressed for 15 levels of list: it stops at 13, where an item can still hold a link or a chip, and the note still saves',
          async () => {
            expect(await deepestListItem(page, MY_NOTES)).toBe(13);
            // Tab at the cap is swallowed: the cursor stays in the editor.
            expect(
              await page.evaluate(
                (selector) => document.querySelector(selector)?.contains(document.activeElement),
                contentOf(MY_NOTES),
              ),
            ).toBe(true);
            expect(docText((await storedNotes(page)).user?.doc)).toContain('level 15');
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('shows a save that fails, keeps the text, and saves it on the next edit', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openNotes(page, [stored('user', MY_COPY)], [pane('user')]);
        await qa.failNextRequest(page, 'SQLITE_FULL: database or disk is full');
        await page.click(`${contentOf(MY_NOTES)} li:last-child p`);
        await page.keyboard.press('End');
        await page.keyboard.type(', and the date for the Q4 review');
        await waitForStatus(page, MY_NOTES, 'Not saved');
        await shootChecked(
          preview,
          'A failed save',
          `save-failed-${tag}`,
          'main refused the save (disk full): "Not saved" in red with the reason above the notes, and the typed text still in the editor',
          async () => {
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-editor-error`);
            expect(await page.textContent(`${editorOf(MY_NOTES)} .note-editor-error`)).toBe(
              'Roger could not save your latest changes on this Mac: SQLITE_FULL: database or disk is full. Your text is still here, and Roger tries again as you type.',
            );
            await expectTokenColour(page, `${editorOf(MY_NOTES)} .note-status`, '--danger-ink');
            await expectTokenColour(
              page,
              `${editorOf(MY_NOTES)} .note-editor-error`,
              '--danger-ink',
            );
            expect(await page.textContent(contentOf(MY_NOTES))).toContain('date for the Q4 review');
            expect(docText((await storedNotes(page)).user?.doc)).not.toContain('Q4 review');
          },
        );

        await page.keyboard.type('.');
        await waitForStatus(page, MY_NOTES, 'Saved on this Mac');
        expect(docText((await storedNotes(page)).user?.doc)).toContain(
          'and the date for the Q4 review.',
        );
        expect(await page.locator(`${editorOf(MY_NOTES)} .note-editor-error`).count()).toBe(0);
      } finally {
        await preview.close();
      }
    });

    it('offers both versions on a conflict, and Use mine puts the copy back', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openNotes(
          page,
          [
            stored('user', THEIR_NOTES, {
              sync: 'conflict',
              conflictCopy: MY_COPY,
              baseVersion: 5,
            }),
          ],
          [pane('user')],
        );
        await shootChecked(
          preview,
          'Conflict',
          `conflict-${tag}`,
          'The server had a newer version: the editor shows it, the banner says yours is kept as a copy, with Use mine and Keep this version',
          async () => {
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-conflict`);
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-button-primary`);
            expect(await statusOf(page, MY_NOTES)).toBe('Two versions');
            expect(await page.textContent(contentOf(MY_NOTES))).toContain('edited on the web');
            await expectTokenColour(page, `${editorOf(MY_NOTES)} .note-conflict-text`, '--ink');
          },
        );
        await page.click(`${editorOf(MY_NOTES)} .note-button-primary`);
        await page.waitForSelector(`${editorOf(MY_NOTES)} .note-conflict`, { state: 'detached' });
        expect(await page.textContent(contentOf(MY_NOTES))).toContain(
          'Ask about the Q3 renewal date',
        );
        expect(await page.textContent(contentOf(MY_NOTES))).not.toContain('edited on the web');
        expect(await statusOf(page, MY_NOTES)).toBe('Saved on this Mac');
        qa.expectNoConsoleErrors(preview);
      } finally {
        await preview.close();
      }
    });

    it('opens no editor for a doc it cannot hold', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await openNotes(page, [stored('user', UNSHOWABLE), stored('ai', LONG_AI_NOTES)]);
        await shootChecked(
          preview,
          'A doc the editor cannot hold',
          `unshowable-${tag}`,
          'My notes holds a list item that does not start with a paragraph: no editor (it would drop it and save the rest), the reason instead; the AI notes beside it are unaffected',
          async () => {
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-editor-error`);
            expect(await page.textContent(`${editorOf(MY_NOTES)} .note-editor-error`)).toMatch(
              /^Roger cannot show these notes, so it leaves them as they are: .*listItem/,
            );
            expect(await page.locator(contentOf(MY_NOTES)).count()).toBe(0);
            await scrollToMiddle(page, contentOf(AI_NOTES));
            await qa.expectVisible(page, contentOf(AI_NOTES));
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('keeps Use mine when the other version is a doc it cannot hold', async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        // A 409 brought a doc this build cannot hold (a newer Roger wrote it), and main kept the
        // user's own notes as the copy.
        await openNotes(
          page,
          [stored('user', UNSHOWABLE, { sync: 'conflict', conflictCopy: MY_COPY, baseVersion: 5 })],
          [pane('user')],
        );
        await shootChecked(
          preview,
          'A doc the editor cannot hold',
          `unshowable-conflict-${tag}`,
          'A conflict whose other version the editor cannot hold: no editor, but "Two versions", a banner that says Roger cannot show that version, Use mine and Keep the other version',
          async () => {
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-conflict`);
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-button-primary`);
            expect(await statusOf(page, MY_NOTES)).toBe('Two versions');
            expect(await page.textContent(`${editorOf(MY_NOTES)} .note-conflict-text`)).toContain(
              'Roger cannot show that version',
            );
            expect(
              await page.textContent(
                `${editorOf(MY_NOTES)} .note-conflict .note-button:not(.note-button-primary)`,
              ),
            ).toBe('Keep the other version');
            await qa.expectVisible(page, `${editorOf(MY_NOTES)} .note-editor-error`);
            expect(await page.locator(contentOf(MY_NOTES)).count()).toBe(0);
            await expectTokenColour(page, `${editorOf(MY_NOTES)} .note-conflict-text`, '--ink');
          },
        );

        await page.click(`${editorOf(MY_NOTES)} .note-button-primary`);
        await page.waitForSelector(contentOf(MY_NOTES));
        await qa.settle(page);
        await shootChecked(
          preview,
          'A doc the editor cannot hold',
          `unshowable-use-mine-${tag}`,
          "After Use mine: the editor opens on the user's own notes, with no banner and no problem, saved on this Mac",
          async () => {
            await qa.expectVisible(page, contentOf(MY_NOTES));
            expect(await page.textContent(contentOf(MY_NOTES))).toContain(
              'Ask about the Q3 renewal date',
            );
            expect(await page.locator(`${editorOf(MY_NOTES)} .note-conflict`).count()).toBe(0);
            expect(await page.locator(`${editorOf(MY_NOTES)} .note-editor-error`).count()).toBe(0);
            expect(await statusOf(page, MY_NOTES)).toBe('Saved on this Mac');
          },
        );
      } finally {
        await preview.close();
      }
    });
  },
);

describe('saving when the page goes or main quits', () => {
  it("answers main's quit flush once, after the save landed", async () => {
    const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
    const { page } = preview;
    try {
      await openNotes(page, [], [pane('user'), pane('ai')]);
      await page.click(contentOf(MY_NOTES));
      // Cmd-Q right after the last key: the 400 ms pause has not come yet.
      await page.keyboard.type('Typed just before quitting');
      await qa.emitEvent(page, notesChannels.NotesFlushRequest, { requestId: 'quit-1' });
      await page.waitForFunction(() => (window.__m4t17?.acks.length ?? 0) > 0);
      expect(await page.evaluate(() => window.__m4t17?.acks)).toEqual([{ requestId: 'quit-1' }]);
      expect(docText((await storedNotes(page)).user?.doc)).toBe('Typed just before quitting');
      qa.expectNoConsoleErrors(preview);
    } finally {
      await preview.close();
    }
  });

  it('saves on pagehide before the 400 ms pause ends', async () => {
    const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
    const { page } = preview;
    try {
      await openNotes(page, [], [pane('user')]);
      await page.click(contentOf(MY_NOTES));
      await page.keyboard.type('Typed just before a reload');
      const saved = await page.evaluate(async (meetingId) => {
        window.dispatchEvent(new Event('pagehide'));
        // Sooner than the debounce could have saved it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return window.roger.getNotes(meetingId);
      }, MEETING);
      expect(docText(saved.user?.doc)).toBe('Typed just before a reload');
      qa.expectNoConsoleErrors(preview);
    } finally {
      await preview.close();
    }
  });

  it('keeps read-only AI notes as they are, while their chips still work', async () => {
    const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
    const { page } = preview;
    try {
      await openNotes(page, [stored('ai', LONG_AI_NOTES)], [pane('ai', { readOnly: true })]);
      expect(await page.getAttribute(contentOf(AI_NOTES), 'contenteditable')).toBe('false');
      await page.click(`${contentOf(AI_NOTES)} p`);
      await page.keyboard.type('should not appear');
      expect(await page.textContent(contentOf(AI_NOTES))).not.toContain('should not appear');
      await page.click(`${editorOf(AI_NOTES)} .citation-chip >> nth=1`);
      await page.waitForSelector(`${editorOf(AI_NOTES)} .citation-chip-removed`);
      expect(await statusOf(page, AI_NOTES)).toBe('Synced');
      qa.expectNoConsoleErrors(preview);
    } finally {
      await preview.close();
    }
  });
});
