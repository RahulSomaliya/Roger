import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import { chatChannels, type ChatStreamMessage } from '../src/shared/ipc/chat';
import { notesChannels } from '../src/shared/ipc/notes';
import {
  CITATION_NODE_TYPE,
  type ChatMessage,
  type ChatStreamEvent,
  type CitationSupport,
  FROM_YOUR_NOTES_HEADING,
  type LocalNote,
  NOT_SAID_ON_THE_CALL,
  type NoteDoc,
  type NoteKind,
  type NoteNode,
  type PendingGenerateStatus,
  type RefCitation,
} from '../src/shared/notes';
import type { TranscriptSegment } from '../src/shared/transcript';

/*
 * Browser QA for M4-T20, the notes and chat mounted on the meeting page, in the real shell
 * (qa/README.md): both themes, 1440 and 390 wide, through the preview. Nothing is mounted by hand:
 * the page, its panes and its regions are the app's own, filled by app/slots/m4-notes.ts.
 *
 *  - A 500-line live call with notes beside it: a chip for line 40 brings the transcript forward
 *    on a phone, centres nothing it need not, tints the line and keeps it in view (the box, and
 *    `document.elementFromPoint`) while five more lines arrive and "Jump to live" shows; a chip for
 *    a removed line says "Line removed" and leaves the transcript alone.
 *  - A standup with saved notes, a conflict banner and a chat thread; a question asked and answered
 *    with chips, and a chip in the chat revealing its line.
 *  - A new meeting from "New note": empty, then "Which kind of call was this?", the waiting state,
 *    a failed run, and a notes-only meeting (typed notes, no lines).
 *  - Settings with the notes preferences; the offline API (the picker and the run read fail through
 *    the two `fromApi` marks in preview/fakes/notes.ts); and the page answering main's flush
 *    request on Home with no editor open (notesFlushResponder, started by the slot file).
 *
 * Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/m4-t20.qa.e2e.ts
 */

declare global {
  interface Window {
    /** The request ids this page acked to main's notes flush, recorded by ackSpy. */
    __m4t20Acks?: string[];
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-T20 notes and chat on the meeting page', 'm4-t20');
const results: { shot: string; check: qa.ShotCheck; note?: string }[] = [];
const FLOW_TIMEOUT_MS = 300_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m4-t20',
      Harness: "The app's own shell and meeting page through the preview; nothing mounted by hand",
      Data: 'A 500-line live call, the standup, a New note meeting, the offline API',
    },
    'My notes, AI notes and chat on the meeting page: a long call and its reveal, the conflict banner, a failed run, the kind-of-call card, waiting, a chat answer with citations, an empty and a notes-only meeting, Settings and the offline API',
  );
  process.stdout.write(
    `\nM4-T20 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

const PAST = PAST_MEETING.meetingId;
const LIVE = LIVE_CALL.meetingId;
const TITLE = '.meeting-page h1';
const PAGE_PANEL = '.meeting-page .live-transcript';
const LINES = `${PAGE_PANEL} .live-transcript-lines`;
const JUMP = `${PAGE_PANEL} .jump-to-live`;
const MINE = '#meeting-notes-panel-mine';
const AI = '#meeting-notes-panel-ai';
const AI_EDITOR = `${AI} .ai-notes-editor .note-editor-content`;
const MY_EDITOR = `${MINE} .note-editor-content`;
const CHAT = '#meeting-pane-chat';
const CHAT_INPUT = `${CHAT} .meeting-chat-input`;
const LONG_NAME = 'Maximilian Featherstonehaugh-Worthington';
/** In no transcript: a line a re-run replaced, or that echo removal deleted. */
const REMOVED_LINE = '7c1e9a42-3b5d-4f68-9e0a-2d4c6b8f1a37';
/** The run that wrote the AI notes of the offline meeting: the API is away, so no read answers. */
const OFFLINE_RUN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

const lineId = (meetingId: string, n: number): string => segmentIdForLine(meetingId, n);

// The page -------------------------------------------------------------------------------------

async function waitForTitle(page: Page, title: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, wanted }) => document.querySelector(selector)?.textContent === wanted,
    { selector: TITLE, wanted: title },
  );
  await qa.settle(page);
}

/** Opens a meeting from the sidebar, as a person would. */
async function openFromSidebar(page: Page, title: string): Promise<void> {
  const selector = `.recent-meetings-list button[title="${title}"]`;
  await qa.expectVisible(page, selector, { within: '.recent-meetings-list' });
  await page.locator(selector).click();
  await waitForTitle(page, title);
}

/** The pane a narrow page shows, or null when every pane shows (the pane buttons are hidden). */
const shownPane = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const buttons = document.querySelector('.meeting-pane-buttons');
    if (buttons === null || getComputedStyle(buttons).display === 'none') return null;
    return (
      document.querySelector('.meeting-region[data-active]')?.id.replace('meeting-pane-', '') ??
      'none'
    );
  });

/** Brings a pane forward on a narrow page; a wide page already shows it. */
async function showPane(page: Page, pane: 'notes' | 'transcript' | 'chat'): Promise<void> {
  if ((await shownPane(page)) !== null) {
    await page.click(`.meeting-pane-button[aria-controls="meeting-pane-${pane}"]`);
    await qa.settle(page);
  }
}

async function openNotesTab(page: Page, tab: 'mine' | 'ai'): Promise<void> {
  await showPane(page, 'notes');
  await page.click(`#meeting-notes-tab-${tab}`);
  await qa.settle(page);
}

async function textOf(page: Page, selector: string): Promise<string> {
  return ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
}

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

const rowsIn = (page: Page): Promise<number> =>
  page.evaluate((lines) => document.querySelectorAll(`${lines} [data-segment-id]`).length, LINES);

/** The ids of the transcript lines marked `data-cited`, in transcript order. */
const citedIds = (page: Page): Promise<string[]> =>
  page.evaluate(
    (lines) =>
      Array.from(document.querySelectorAll(`${lines} [data-cited]`), (line) =>
        String(line.getAttribute('data-segment-id')),
      ),
    LINES,
  );

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

/**
 * Fails if the window itself scrolls down. The app is one window tall and scrolls inside its page
 * column (fitShellPage grows the window to the column, so this runs with the column unscrolled):
 * a taller document means a box escaped every scroller (M4-T19's absolute screen-reader labels
 * did). qa.expectNoPageOverflow checks only the sideways scroll.
 */
async function expectNoPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  if (overflow > 0) throw new Error(`The window scrolls down by ${overflow} px`);
}

/**
 * Fails if the notes panel is drawn over the chat under it on a wide page. A long AI panel once
 * outgrew its grid row and covered the chat (meeting.css, .meeting-notes-panel scrolls now), which
 * expectVisible alone shows only for the control that happened to be covered.
 */
async function expectNotesAboveChat(page: Page): Promise<void> {
  const gap = await page.evaluate(
    ({ panel, chat }) => {
      const notes = document.querySelector(`${panel}:not([hidden])`);
      const below = document.querySelector(chat);
      if (notes === null || below === null) throw new Error('No open notes panel or no chat');
      return below.getBoundingClientRect().top - notes.getBoundingClientRect().bottom;
    },
    { panel: '.meeting-notes-panel', chat: CHAT },
  );
  if (gap < 0) throw new Error(`The notes panel runs ${(-gap).toFixed(1)} px into the chat`);
}

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
    await qa.fitShellPage(preview.page);
    await checks();
    await qa.expectNoPageOverflow(preview.page);
    await expectNoPageScroll(preview.page);
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

// Notes and chat data -------------------------------------------------------------------------

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

function timeLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mmss = `${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return hours > 0 ? `${String(hours)}:${mmss}` : mmss;
}

/** A chip for these lines, labelled with the time the first of them starts. */
function chip(
  lines: readonly TranscriptSegment[],
  ids: readonly string[],
  support: CitationSupport = 'ok',
): NoteNode {
  const first = lines.find((line) => line.id === ids[0]);
  const startMs = first?.startMs ?? 0;
  return {
    type: CITATION_NODE_TYPE,
    attrs: {
      segmentIds: [...ids],
      startMs,
      label: timeLabel(Math.floor(startMs / 1000)),
      support,
    },
  };
}

function localNote(
  meetingId: string,
  kind: NoteKind,
  doc: NoteDoc,
  extra: Partial<LocalNote> = {},
): LocalNote {
  return {
    meetingId,
    kind,
    doc,
    revisionId: null,
    dirty: false,
    baseVersion: 3,
    templateId: kind === 'ai' ? 'client_call' : null,
    // No run id by default: a run id makes the panel read the run from the API, which the preview
    // knows only for a run it saw stream (the offline test sets one on purpose).
    lastRunId: null,
    generatedVersion: kind === 'ai' ? 3 : null,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-07T09:30:00.000Z',
    ...extra,
  };
}

/** What main's store holds for a meeting: every line the preview played, in order. */
async function storedLines(page: Page, meetingId: string): Promise<TranscriptSegment[]> {
  const meeting = await page.evaluate(
    (id) => window.roger.getMeeting({ meetingId: id }),
    meetingId,
  );
  if (meeting === null) throw new Error(`The preview stores no meeting ${meetingId}`);
  return meeting.segments;
}

const pushNote = (page: Page, note: LocalNote): Promise<void> =>
  qa.emitEvent(page, notesChannels.NotesChanged, note);

/** My notes as a person jots them during a call. */
const MY_NOTES: NoteDoc = {
  type: 'doc',
  content: [
    paragraph(text('Ask about the Q3 renewal date')),
    bullets([
      paragraph(text(`${LONG_NAME} owns the security questionnaire`)),
      paragraph(text('Price: hold at $50k for year one')),
    ]),
  ],
};

/** A long call's AI notes: chips for line 40, two lines out of order, and a line that is gone. */
function longCallNotes(lines: readonly TranscriptSegment[]): NoteDoc {
  return {
    type: 'doc',
    content: [
      heading('Their goals'),
      bullets([
        paragraph(
          text('Finance wants Roger live by November, once exports to their BI tool work '),
          chip(lines, [lineId(LIVE, 40)]),
        ),
        paragraph(
          text('Support uses it daily: 42 of 50 seats are active each week '),
          chip(lines, [lineId(LIVE, 75), lineId(LIVE, 74)], 'weak'),
        ),
      ]),
      heading('Decisions'),
      bullets([
        paragraph(
          text('Year-one price stays at $50k, said before the renewal was discussed '),
          chip(lines, [REMOVED_LINE]),
        ),
      ]),
      heading(FROM_YOUR_NOTES_HEADING),
      paragraph(text(NOT_SAID_ON_THE_CALL, [{ type: 'italic' }])),
      bullets([paragraph(text('Ask about the Q3 renewal date'))]),
    ],
  };
}

/** The standup's AI notes: chips on lines that exist, one that does not. */
function standupNotes(lines: readonly TranscriptSegment[]): NoteDoc {
  return {
    type: 'doc',
    content: [
      heading('Done'),
      bullets([
        paragraph(
          text('Uploader backs off from two seconds to thirty and keeps every line '),
          chip(lines, [lineId(PAST, 4)]),
        ),
        paragraph(
          text(`${LONG_NAME} finished the retry tests `),
          chip(lines, [lineId(PAST, 6), lineId(PAST, 7)], 'weak'),
        ),
      ]),
      heading('Blockers'),
      bullets([
        paragraph(
          text('Release checklist waits on the signing cert '),
          chip(lines, [REMOVED_LINE]),
        ),
      ]),
    ],
  };
}

const THREAD_SENT = '2026-10-07T09:40:00.000Z';

function chatMessage(
  id: string,
  role: 'user' | 'assistant',
  body: string,
  citations: RefCitation[],
  replyTo: string | null,
): ChatMessage {
  return {
    id,
    role,
    text: body,
    citations,
    replyTo,
    runId: role === 'assistant' ? `run-${id}` : null,
    status: 'complete',
    createdAt: THREAD_SENT,
  };
}

const Q_RETRY = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2d1e01';
const A_RETRY = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2daaaa';

function cite(lines: readonly TranscriptSegment[], meetingId: string, n: number): RefCitation {
  const id = lineId(meetingId, n);
  const line = lines.find((each) => each.id === id);
  return { ref: `L${String(n)}`, segmentId: id, startMs: line?.startMs ?? 0 };
}

/** One exchange the API stored: an answer with a chip for a line that exists and one that is gone. */
function standupThread(lines: readonly TranscriptSegment[]): ChatMessage[] {
  return [
    chatMessage(
      Q_RETRY,
      'user',
      'How many lines did the uploader retry logic handle, and were there duplicates?',
      [],
      null,
    ),
    chatMessage(
      A_RETRY,
      'assistant',
      'About fifteen hundred lines from a forty minute call, with zero duplicates, because the segment ids are made on the Mac [L6]. Every line reached Postgres within a minute of the network coming back [L4].',
      [cite(lines, PAST, 6), cite(lines, PAST, 4)],
      Q_RETRY,
    ),
  ];
}

/** Plays main's events for the answer to `messageId`, in order. */
async function answer(page: Page, messageId: string, ...events: ChatStreamEvent[]): Promise<void> {
  for (const event of events) {
    const message: ChatStreamMessage = { meetingId: PAST, messageId, event };
    await qa.emitEvent(page, chatChannels.ChatEvent, message);
  }
  await qa.settle(page);
}

// Tests ----------------------------------------------------------------------------------------

describe.each(combos())('the meeting page in $theme at $width px', ({ theme, width }) => {
  const tag = `${theme}-${String(width)}`;
  const narrow = width < 600;

  it(
    'shows notes beside a 500-line live call and reveals a cited line without losing it',
    async () => {
      const preview = await run.open({ scenario: 'live-call', theme, width });
      const { page } = preview;
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('.recent-meetings-list button').length > 0,
        );
        const lines = await storedLines(page, LIVE);
        await pushNote(page, localNote(LIVE, 'ai', longCallNotes(lines)));
        await pushNote(page, localNote(LIVE, 'user', MY_NOTES));
        await openFromSidebar(page, LIVE_CALL.title);
        await page.waitForFunction(
          (selector) => document.querySelectorAll(selector).length >= 500,
          `${LINES} [data-segment-id]`,
        );
        await openNotesTab(page, 'mine');
        await page.waitForSelector(`${MY_EDITOR} li`);
        await shootChecked(
          preview,
          'A long call',
          `my-notes-${tag}`,
          narrow
            ? 'Mid-call on a phone: the notes pane is up with My notes, and the pane buttons pick Transcript or Chat'
            : 'Mid-call: My notes, the live transcript and chat side by side',
          async () => {
            // The three panes in order; wide shows all of them, narrow one at a time.
            const labels = await page
              .locator('.meeting-pane-button')
              .evaluateAll((all) => all.map((button) => button.textContent));
            expect(labels).toEqual(['Notes', 'Transcript', 'Chat']);
            expect(await shownPane(page)).toBe(narrow ? 'notes' : null);
            await qa.expectVisible(page, `${MINE} .note-editor-content`);
            await qa.expectVisible(page, '.note-editor-bar .note-status');
            if (!narrow) {
              await qa.expectVisible(page, LINES);
              await qa.expectVisible(page, `${CHAT} .meeting-chat-input`);
            }
            expect(await textOf(page, `${MINE} .note-editor-bar .note-status`)).toBe('Synced');
          },
        );

        await openNotesTab(page, 'ai');
        await page.waitForSelector(`${AI_EDITOR} .citation-chip`);
        const chips = `${AI_EDITOR} .citation-chip`;
        expect(await count(page, chips)).toBe(3);
        await shootChecked(
          preview,
          'A long call',
          `ai-notes-${tag}`,
          'AI notes with chips: one "check this" line, one chip whose line is gone, and From your notes',
          async () => {
            await qa.expectVisible(page, `${AI} .ai-notes-bar`);
            await qa.expectVisible(page, `${AI} .ai-notes-bar .note-button`);
          },
        );

        // A chip for line 40, far above the live end: on a phone the transcript pane is hidden,
        // so the page must bring it forward before the navigator scrolls.
        const target = lineId(LIVE, 40);
        await page.locator(chips).nth(0).click();
        await qa.settle(page);
        expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
        const rowsAtReveal = await rowsIn(page);
        await shootChecked(
          preview,
          'The reveal',
          `reveal-${tag}`,
          narrow
            ? 'The chip for line 40 on a phone: the transcript comes forward, line 40 is in view and tinted, and Jump to live shows'
            : 'The chip for line 40: the line is in view in the transcript and tinted, following is paused and Jump to live shows',
          async () => {
            expect(await citedIds(page)).toEqual([target]);
            const sel = `${LINES} [data-segment-id="${target}"]`;
            // Inside the transcript's own box, and the line (or a child) is what is on top there.
            await qa.expectVisible(page, sel, { within: LINES });
            await qa.expectVisible(page, JUMP);
            await expectToken(page, sel, 'background-color', '--cited-bg');
          },
        );
        // Lines keep coming (one every 200 ms): five more, and line 40 stays put.
        await page.waitForFunction(
          ({ selector, rows }) => document.querySelectorAll(selector).length >= rows,
          { selector: `${LINES} [data-segment-id]`, rows: rowsAtReveal + 5 },
        );
        await qa.expectVisible(page, `${LINES} [data-segment-id="${target}"]`, { within: LINES });
        await qa.expectVisible(page, JUMP);
        expect(await rowsIn(page)).toBeGreaterThanOrEqual(rowsAtReveal + 5);

        // A chip for a line that is gone: it says so, and the transcript is left alone.
        await page.waitForFunction(
          (lines) => document.querySelector(`${lines} [data-cited]`) === null,
          LINES,
          { timeout: 4000 },
        );
        await openNotesTab(page, 'ai');
        const topBefore = await page.locator(LINES).evaluate((box) => box.scrollTop);
        await page.locator(chips).nth(2).click();
        await qa.settle(page);
        expect(await citedIds(page)).toEqual([]);
        expect(await shownPane(page)).toBe(narrow ? 'notes' : null);
        expect(await page.locator(LINES).evaluate((box) => box.scrollTop)).toBe(topBefore);
        await shootChecked(
          preview,
          'The reveal',
          `removed-${tag}`,
          'The chip for a line that is gone says "Line removed"; nothing in the transcript moved or was tinted',
          async () => {
            const flags = await page
              .locator(`${AI_EDITOR} .citation-chip-flag`)
              .evaluateAll((all) => all.map((flag) => flag.textContent));
            expect(flags).toContain('Line removed');
            await qa.expectVisible(page, `${AI_EDITOR} .citation-chip-removed`);
          },
        );
      } finally {
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'shows saved notes, the conflict banner and a chat thread, and answers a question with chips',
    async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        const lines = await storedLines(page, PAST);
        await pushNote(page, localNote(PAST, 'ai', standupNotes(lines)));
        await pushNote(page, localNote(PAST, 'user', MY_NOTES));
        await qa.emitEvent(page, chatChannels.ChatThreadChanged, {
          meetingId: PAST,
          messages: standupThread(lines),
        });
        await openFromSidebar(page, PAST_MEETING.title);
        await openNotesTab(page, 'ai');
        await page.waitForSelector(`${AI_EDITOR} .citation-chip`);
        await shootChecked(
          preview,
          'The standup',
          `standup-notes-${tag}`,
          narrow
            ? 'A finished standup on a phone: the AI notes pane, with the pane buttons above'
            : 'A finished standup: AI notes, the transcript and the chat thread side by side',
          async () => {
            expect(await shownPane(page)).toBe(narrow ? 'notes' : null);
            expect(await count(page, `${AI_EDITOR} .citation-chip`)).toBe(3);
            // A past meeting never offers Jump to live.
            expect(await count(page, JUMP)).toBe(0);
            await qa.expectVisible(page, `${AI} .ai-notes-bar`);
            if (!narrow) {
              await expectNotesAboveChat(page);
              await qa.expectVisible(page, `${CHAT} .meeting-chat-exchange`);
              await qa.expectVisible(page, LINES);
            }
          },
        );

        // The conflict banner on My notes: main kept a second version.
        await pushNote(
          page,
          localNote(PAST, 'user', MY_NOTES, {
            dirty: true,
            sync: 'conflict',
            conflictCopy: {
              type: 'doc',
              content: [paragraph(text('Ask about the Q3 renewal date, and the travel budget'))],
            },
          }),
        );
        await openNotesTab(page, 'mine');
        await page.waitForSelector(`${MINE} .note-conflict`);
        await shootChecked(
          preview,
          'Notes states',
          `conflict-${tag}`,
          'My notes changed somewhere else: the banner offers Use mine and Keep this version, and the status says Two versions',
          async () => {
            await qa.expectVisible(page, `${MINE} .note-conflict`);
            expect(await textOf(page, `${MINE} .note-status`)).toBe('Two versions');
            const buttons = await page
              .locator(`${MINE} .note-conflict .note-button`)
              .evaluateAll((all) => all.map((button) => button.textContent));
            expect(buttons).toEqual(['Use mine', 'Keep this version']);
          },
        );
        await page.locator(`${MINE} .note-conflict .note-button-primary`).click();
        await page.waitForSelector(`${MINE} .note-conflict`, { state: 'detached' });

        // A chip in the chat reveals its line in the transcript.
        await showPane(page, 'chat');
        await page.waitForSelector(`${CHAT} .citation-chip`);
        const chatChips = `${CHAT} .citation-chip`;
        await page.locator(chatChips).nth(0).click();
        await qa.settle(page);
        expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
        await shootChecked(
          preview,
          'Chat',
          `chat-reveal-${tag}`,
          'A chip in a chat answer: the transcript shows the line it cites, tinted',
          async () => {
            expect(await citedIds(page)).toEqual([lineId(PAST, 6)]);
            await qa.expectVisible(page, `${LINES} [data-segment-id="${lineId(PAST, 6)}"]`, {
              within: LINES,
            });
          },
        );

        // Ask a question: it streams in with a chip for each ref main has mapped.
        await showPane(page, 'chat');
        await page.click(CHAT_INPUT);
        await page.keyboard.type('Who is picking up the signing cert?');
        await page.keyboard.press('Enter');
        await qa.settle(page);
        const thread = await page.evaluate((id) => window.roger.getChatThread(id), PAST);
        const asked = thread.messages.filter(({ role, id }) => role === 'user' && id !== Q_RETRY);
        expect(asked).toHaveLength(1);
        const questionId = asked[0]?.id ?? '';
        const mapped = cite(lines, PAST, 12);
        const reply = chatMessage(
          '3e8f1a52-6b7c-4d90-8e21-5a4b3c2dbbbb',
          'assistant',
          `${LONG_NAME} is chasing the signing cert with IT [L12], and the checklist waits on it.`,
          [mapped],
          questionId,
        );
        await answer(
          page,
          questionId,
          { type: 'run', runId: reply.runId ?? 'run', model: 'fake' },
          { type: 'delta', text: `${LONG_NAME} is chasing the signing cert with IT [L12], ` },
          { type: 'citation', ...mapped },
          { type: 'delta', text: 'and the checklist waits on it.' },
        );
        await shootChecked(
          preview,
          'Chat',
          `chat-streaming-${tag}`,
          'An answer streaming in: the text so far, a chip for the line main mapped, and Stop',
          async () => {
            await qa.expectVisible(page, `${CHAT} .meeting-chat-answer[aria-busy] .citation-chip`);
          },
        );
        await answer(page, questionId, { type: 'done', message: reply });
        await shootChecked(
          preview,
          'Chat',
          `chat-answer-${tag}`,
          'The answer done: both exchanges in the thread, each answer with its chips',
          async () => {
            expect(await count(page, `${CHAT} .meeting-chat-exchange`)).toBe(2);
            expect(await count(page, `${CHAT} .meeting-chat-answer[aria-busy]`)).toBe(0);
            await qa.expectVisible(
              page,
              `${CHAT} .meeting-chat-exchange:last-child .citation-chip`,
            );
            await qa.expectVisible(page, CHAT_INPUT);
          },
        );
      } finally {
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'starts empty from New note, asks which kind of call, waits, fails and keeps typed notes',
    async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await page.locator('.sidebar-action', { hasText: 'New note' }).click();
        await page.waitForSelector('.meeting-page .meeting-body');
        await qa.settle(page);
        const status = await page.evaluate(() => window.roger.getCaptureStatus());
        const meetingId = status.meetingId;
        if (meetingId === null) throw new Error('New note named no meeting');
        const pend = async (state: PendingGenerateStatus | null): Promise<void> => {
          await qa.emitEvent(page, notesChannels.NotesPendingGenerateChanged, {
            meetingId,
            pending:
              state === null
                ? null
                : {
                    meetingId,
                    runId: '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
                    templateId: state.phase === 'needs_template' ? null : 'client_call',
                    reason: 'after_stop',
                    createdAt: '2026-10-07T11:10:00.000Z',
                    status: state,
                  },
          });
          await qa.settle(page);
        };

        await openNotesTab(page, 'mine');
        await page.waitForSelector(MY_EDITOR);
        await shootChecked(
          preview,
          'A new meeting',
          `empty-${tag}`,
          'A meeting just started: nothing said and nothing typed, so My notes shows its placeholder, and the transcript and chat are empty',
          async () => {
            const placeholder = await page.getAttribute(
              `${MY_EDITOR} p.is-editor-empty`,
              'data-placeholder',
            );
            expect(placeholder).toBe(
              'Type your notes. Roger turns them into clean notes after the call.',
            );
            await qa.expectVisible(page, MY_EDITOR);
            expect(await count(page, `${LINES} [data-segment-id]`)).toBe(0);
          },
        );

        await openNotesTab(page, 'ai');
        await shootChecked(
          preview,
          'A new meeting',
          `ai-empty-${tag}`,
          'The AI notes tab of an empty meeting offers Generate notes',
          async () => {
            await qa.expectVisible(page, `${AI} .ai-notes-empty .note-button-primary`);
          },
        );

        await pend({ phase: 'needs_template' });
        await shootChecked(
          preview,
          'Notes states',
          `which-kind-${tag}`,
          '"Which kind of call was this?": Stop found no rule that fits, so the card asks, with the four templates',
          async () => {
            expect(await textOf(page, AI)).toContain('Which kind of call was this?');
            const names = await page
              .locator(`${AI} .template-option-name`)
              .evaluateAll((spans) => spans.map((span) => span.textContent));
            expect(names).toEqual(['General', 'Standup', 'Client call', '1:1']);
          },
        );

        await pend({ phase: 'waiting_for_notes', cause: 'offline' });
        await shootChecked(
          preview,
          'Notes states',
          `waiting-${tag}`,
          'Waiting: the notes cannot reach the API, so Roger says it will write them when they can, with Cancel',
          async () => {
            await qa.expectVisible(page, `${AI} .ai-notes-progress`);
            expect(await count(page, `${AI} .ai-notes-progress-running`)).toBe(0);
            expect(await textOf(page, `${AI} .ai-notes-progress`)).toContain('offline');
            expect(await textOf(page, `${AI} .ai-notes-bar`)).toContain('Cancel');
          },
        );

        await pend({
          phase: 'failed',
          code: 'llm_provider_error',
          message: 'The AI provider did not answer. Retry in a moment.',
        });
        await shootChecked(
          preview,
          'Notes states',
          `failed-${tag}`,
          'A failed run: the reason in an alert, with Retry and Dismiss; nothing was written',
          async () => {
            await qa.expectVisible(page, `${AI} .ai-notes-failure[role="alert"]`);
            expect(await textOf(page, `${AI} .ai-notes-failure`)).toContain('did not answer');
            await qa.expectVisible(page, `${AI} .ai-notes-failure .note-button-primary`);
          },
        );
        await pend(null);

        // Typed notes with no line said: a notes-only meeting.
        await openNotesTab(page, 'mine');
        await page.click(MY_EDITOR);
        await page.keyboard.type(`Renewal with ${LONG_NAME}`);
        await page.keyboard.press('Enter');
        await page.keyboard.type('Ask for the security questionnaire by Wednesday');
        await page.waitForFunction(
          (selector) => document.querySelector(selector)?.textContent === 'Saved on this Mac',
          `${MINE} .note-status`,
        );
        await shootChecked(
          preview,
          'A new meeting',
          `notes-only-${tag}`,
          'Notes typed with nothing said: saved on this Mac, ready for Stop to keep the meeting',
          async () => {
            const saved = await page.evaluate((id) => window.roger.getNotes(id), meetingId);
            expect(saved.user?.dirty).toBe(true);
            expect(JSON.stringify(saved.user?.doc)).toContain('Ask for the security questionnaire');
            expect(await count(page, `${LINES} [data-segment-id]`)).toBe(0);
            await qa.expectVisible(page, `${MINE} .note-status`);
          },
        );
      } finally {
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'shows the notes preferences in Settings',
    async () => {
      const preview = await run.open({ scenario: 'empty-mac', theme, width });
      const { page } = preview;
      try {
        await page.locator('.sidebar-link', { hasText: 'Settings' }).click();
        await page.waitForSelector('.notes-settings input[type="checkbox"]');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Settings',
          `settings-${tag}`,
          'Settings: the notes section after the jargon list, with the auto-generate switch and the "cannot tell" choice',
          async () => {
            await qa.expectVisible(page, '.notes-settings');
            expect(await textOf(page, '.notes-settings h2')).toBe('Notes');
            expect(await count(page, '.notes-settings input[type="checkbox"]')).toBe(1);
            expect(await count(page, '.notes-settings input[type="radio"]')).toBe(2);
            const titles = await page
              .locator('.settings-sections h2')
              .evaluateAll((all) => all.map((heading) => heading.textContent));
            expect(titles.indexOf('Notes')).toBeGreaterThan(0);
          },
        );
      } finally {
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'tells the offline API apart from empty notes: the picker and the run read fail',
    async () => {
      const preview = await run.open({ scenario: 'api-offline', theme, width });
      const { page } = preview;
      try {
        await pushNote(
          page,
          localNote(PAST, 'ai', standupNotes(await storedLines(page, PAST)), {
            lastRunId: OFFLINE_RUN,
          }),
        );
        await openFromSidebar(page, PAST_MEETING.title);
        await openNotesTab(page, 'ai');
        await page.waitForSelector(`${AI} .ai-notes-run-problem`);
        await page.locator(`${AI} .ai-notes-bar .note-button`, { hasText: 'Regenerate' }).click();
        await page.waitForSelector(`${AI} .template-picker-error`);
        // The run line closes the panel, under the notes: the panel scrolls inside itself, so a
        // person scrolls to it, and the shot shows it.
        await page.locator(`${AI} .ai-notes-run-problem`).scrollIntoViewIfNeeded();
        await qa.settle(page);
        await shootChecked(
          preview,
          'Offline',
          `offline-${tag}`,
          'The API is away: the AI notes still open from this Mac, but the run that wrote them cannot be read and the picker cannot list templates, each with Try again',
          async () => {
            expect(await textOf(page, `${AI} .ai-notes-run-problem`)).toContain(
              'could not read the run',
            );
            expect(await textOf(page, AI)).toContain('could not load the templates');
            expect(await count(page, `${AI} .template-option-name`)).toBe(0);
            await qa.expectVisible(page, `${AI} .ai-notes-run-problem .note-button`);
            if (!narrow) await expectNotesAboveChat(page);
          },
        );
      } finally {
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );
});

it(
  "answers main's notes flush on Home, where no editor is open",
  async () => {
    const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
    const { page } = preview;
    try {
      // Record every ack the page sends: the responder reads `ackNotesFlush` off window.roger when
      // it answers, so a wrapper installed now sees it.
      await page.evaluate(() => {
        const roger = window.roger;
        const send = roger.ackNotesFlush.bind(roger);
        window.__m4t20Acks = [];
        roger.ackNotesFlush = (ack) => {
          window.__m4t20Acks?.push(ack.requestId);
          send(ack);
        };
      });
      expect(await count(page, '.meeting-page')).toBe(0);
      const requestId = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
      const sentAt = Date.now();
      await qa.emitEvent(page, notesChannels.NotesFlushRequest, { requestId });
      await page.waitForFunction((id) => window.__m4t20Acks?.includes(id) === true, requestId, {
        timeout: 500,
      });
      // Main waits 1 s per window for this ack: Home must answer well inside that.
      expect(Date.now() - sentAt).toBeLessThan(500);
      qa.expectNoConsoleErrors(preview);
    } finally {
      await preview.close();
    }
  },
  FLOW_TIMEOUT_MS,
);
