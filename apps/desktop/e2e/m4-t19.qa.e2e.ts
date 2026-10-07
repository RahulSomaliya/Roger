import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import type * as ReactNamespace from 'react';
import type * as ReactDom from 'react-dom';
import type * as ReactDomClient from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import { chatChannels, type ChatStreamMessage } from '../src/shared/ipc/chat';
import {
  type ChatMessage,
  type ChatStreamEvent,
  MAX_CHAT_TEXT_CHARS,
  type RefCitation,
} from '../src/shared/notes';
import type { TranscriptSegment } from '../src/shared/transcript';

/*
 * Browser QA for M4-T19, the meeting chat panel (qa/README.md): both themes, 1440 and 390 wide,
 * on the preview's past standup. A thread of four exchanges (a list answer with a long link, a
 * two-line question, a chip whose line is gone); a chip opens its transcript line, and on a phone
 * brings the transcript pane forward; a thread of thirty scrolls inside its log while the window
 * stays still (every shot checks the window does not scroll down); a question asked with Enter (Shift+Enter breaks its line)
 * streams in with chips for the refs main has mapped and the rest as text, then `done` replaces
 * it; failure paths: an answer that fails mid-stream keeps its text and asks again with the same
 * id, a stopped answer, a thread the offline API cannot read, a question over 4,000 characters.
 *
 * Nothing mounts the chat panel in the app until M4-T20, so this script mounts MeetingChat alone
 * on the preview page, in the meeting page's frame and panes (meeting.css: side by side when wide,
 * one at a time when narrow), beside LiveTranscript, inside CitationNavigatorProvider with a
 * `showTranscript` like MeetingPage's. The chat talks to the preview's fake `window.roger`
 * (preview/fakes/chat.ts); the script plays main's answer events on `chat:event`. Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts e2e/m4-t19.qa.e2e.ts
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
/** Vite serves files outside the preview root under /@fs/ plus their absolute path. */
const servedAt = (path: string): string => `/@fs${SOURCE_ROOT}${path}`;
const RENDERER_ENTRY_URL = servedAt('renderer/src/main.tsx');
/** Imports `react-dom` itself (flushSync), which the renderer's entry does not name. */
const MEETING_PAGE_URL = servedAt('renderer/src/meeting/MeetingPage.tsx');
const CHAT_URL = servedAt('renderer/src/chat/MeetingChat.tsx');
const PANEL_URL = servedAt('renderer/src/transcript/LiveTranscript.tsx');
const NAVIGATOR_URL = servedAt('renderer/src/transcript/transcriptNavigator.ts');

/**
 * The props of MeetingChat, LiveTranscript and CitationNavigatorProvider, restated: those files
 * are JSX or read the renderer's `window.roger` type, which this program (tsconfig.e2e) does not
 * have. Change them together.
 */
interface ChatProps {
  meetingId: string;
}

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

interface HarnessState {
  title: string;
  meetingId: string;
  storedLines: readonly TranscriptSegment[];
}

declare global {
  interface Window {
    __m4t19?: { modules: unknown[]; render?: (state: HarnessState) => void };
  }
}

/** A CommonJS package as Vite's dependency cache serves it: its exports on `default`. */
interface CommonJsModule<T> {
  default: T;
}

const MEETING = PAST_MEETING.meetingId;
const HARNESS = '#m4-t19-harness';
const CHAT = `${HARNESS} .meeting-chat`;
const CHAT_LOG = `${CHAT} .meeting-chat-log`;
const INPUT = `${CHAT} .meeting-chat-input`;
const ASK = `${CHAT} .meeting-chat-ask`;
const TRANSCRIPT_LOG = `${HARNESS} .live-transcript-lines`;
const exchangeAt = (n: number): string => `${CHAT_LOG} > .meeting-chat-exchange:nth-child(${n})`;
const lastExchange = `${CHAT_LOG} > .meeting-chat-exchange:last-child`;
const lineSelector = (id: string): string => `${TRANSCRIPT_LOG} [data-segment-id="${id}"]`;

/** Line `n` of the past standup, by the id the preview gives it. */
const pastLine = (n: number): string => segmentIdForLine(MEETING, n);
/** In no transcript: a line echo removal deleted after the answer cited it. */
const REMOVED_LINE = '7c1e9a42-3b5d-4f68-9e0a-2d4c6b8f1a37';

/** The citation the API sends for `L<n>` of the past standup. */
function cite(n: number, segmentId = pastLine(n)): RefCitation {
  const line = PAST_MEETING.lines[n - 1];
  if (line === undefined) throw new Error(`The past standup has no line ${n}`);
  return { ref: `L${n}`, segmentId, startMs: line.startMs };
}

/**
 * TipTap is not in the app's module graph until M4-T20 mounts the editor, and the chat's chips
 * import it (notes/CitationChip.tsx), so the first import makes Vite bundle it and reload the
 * page. One throwaway page takes that reload, as e2e/m4-t21b.qa.e2e.ts does; its failures are
 * dropped on purpose (a warm cache does not reload, and a real import error fails mountHarness on
 * the next page, with its message).
 */
async function warmUpChatBundle(): Promise<void> {
  const preview = await run.open({ scenario: 'empty-mac', theme: 'light', width: 1440 });
  try {
    const reloaded = preview.page
      .waitForEvent('load', { timeout: 10_000 })
      .then(() => qa.settle(preview.page))
      .catch(() => undefined);
    // A string, not a function: Vitest rewrites every import() in this file for Node.
    await preview.page
      .evaluate(`import(${JSON.stringify(CHAT_URL)}).then(() => undefined)`)
      .catch(() => undefined);
    await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 3000))]);
  } finally {
    await preview.close();
  }
}

/**
 * Mounts the harness on the preview page, over the hidden app. React and ReactDOM must be the very
 * modules the app loaded (the URLs with Vite's version hash), or the panels' hooks run against a
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
  const urls = JSON.stringify([...reactUrls, CHAT_URL, PANEL_URL, NAVIGATOR_URL]);
  await page.evaluate(
    `Promise.all(${urls}.map((url) => import(url))).then((modules) => { window.__m4t19 = { modules }; })`,
  );
  await page.evaluate(() => {
    const loaded = window.__m4t19;
    if (loaded === undefined) throw new Error('The harness modules did not load');
    const [reactModule, domModule, clientModule, chatModule, panelModule, navigatorModule] =
      loaded.modules as [
        CommonJsModule<typeof ReactNamespace>,
        CommonJsModule<typeof ReactDom>,
        CommonJsModule<typeof ReactDomClient>,
        { MeetingChat: ReactNamespace.ComponentType<ChatProps> },
        { LiveTranscript: ReactNamespace.ComponentType<PanelProps> },
        { CitationNavigatorProvider: ReactNamespace.ComponentType<ProviderProps> },
      ];
    const { createElement, StrictMode, useCallback, useState } = reactModule.default;
    const { flushSync } = domModule.default;

    type Pane = 'chat' | 'transcript';
    const PANES: readonly Pane[] = ['chat', 'transcript'];
    const LABEL: Record<Pane, string> = { chat: 'Chat', transcript: 'Transcript' };

    // The meeting page's frame and panes (MeetingPage.tsx, regions.tsx), with its showTranscript.
    const MeetingFrame = ({ state }: { state: HarnessState }) => {
      const [pane, setPane] = useState<Pane>('chat');
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
          navigatorModule.CitationNavigatorProvider,
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
            region('chat', createElement(chatModule.MeetingChat, { meetingId: state.meetingId })),
            region(
              'transcript',
              createElement(panelModule.LiveTranscript, {
                meetingId: state.meetingId,
                storedLines: state.storedLines,
                showHidden: false,
                live: false,
              }),
            ),
          ),
        ),
      );
    };

    const app = document.getElementById('root');
    if (app !== null) app.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'm4-t19-harness';
    // The shell page's box (app.css .shell-page): as tall as the window, with its gutters, and
    // scrolling inside itself, so only a box that escapes it can make the window scroll
    // (expectNoPageScroll). No colour: the page's own.
    host.style.cssText =
      'height: 100vh; padding: 24px 16px; box-sizing: border-box; overflow-y: auto;';
    document.body.append(host);
    const root = clientModule.default.createRoot(host);
    loaded.render = (state) => {
      // StrictMode, as the app runs: the chat's effects (its subscriptions and its read) run twice.
      root.render(createElement(StrictMode, null, createElement(MeetingFrame, { state })));
    };
  });
}

/** The meeting's lines as main's store holds them (the preview's meetings fake records them). */
async function storedLines(page: Page): Promise<TranscriptSegment[]> {
  const lines = await page.evaluate(
    async (id) => (await window.roger.getMeeting({ meetingId: id }))?.segments ?? null,
    MEETING,
  );
  if (lines === null) throw new Error(`The preview stores no meeting ${MEETING}`);
  return lines;
}

/**
 * Opens the standup's chat over `thread`, as main's store would hold it: the fake answers
 * getChatThread with the last thread main sent, so the thread goes in before the panel mounts.
 * Waits until the chat has read it (or failed to).
 */
async function openChat(page: Page, thread: readonly ChatMessage[]): Promise<void> {
  if (thread.length > 0) {
    await qa.emitEvent(page, chatChannels.ChatThreadChanged, {
      meetingId: MEETING,
      messages: thread,
    });
  }
  await mountHarness(page);
  const lines = await storedLines(page);
  await page.evaluate(
    (state) => {
      const render = window.__m4t19?.render;
      if (render === undefined) throw new Error('The harness is not mounted');
      render(state);
    },
    { title: PAST_MEETING.title, meetingId: MEETING, storedLines: lines },
  );
  await page.waitForSelector(CHAT_LOG);
  await page.waitForFunction(
    (log) => document.querySelector(`${log} > .meeting-chat-message[aria-busy]`) === null,
    CHAT_LOG,
  );
  await qa.settle(page);
}

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

/** Brings the chat forward when a narrow page shows the transcript. */
async function showChat(page: Page): Promise<void> {
  if ((await shownPane(page)) === 'transcript') {
    await page.click(`${HARNESS} .meeting-pane-button[aria-controls="meeting-pane-chat"]`);
  }
}

/**
 * Types a question as a person does: each line typed, Shift+Enter between lines, Enter to ask.
 * Returns the id the panel gave it, read from the fake's thread, where main stored it.
 */
async function ask(page: Page, ...lines: string[]): Promise<string> {
  await showChat(page);
  await page.click(INPUT);
  for (const [index, text] of lines.entries()) {
    if (index > 0) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(text);
  }
  const before = await questionIds(page);
  await page.keyboard.press('Enter');
  await qa.settle(page);
  const added = (await questionIds(page)).filter((id) => !before.includes(id));
  if (added.length !== 1) {
    throw new Error(`Asking stored ${added.length} questions, not one: ${added.join(', ')}`);
  }
  return added[0] ?? '';
}

/** The ids of the questions main holds for the meeting, oldest first. */
async function questionIds(page: Page): Promise<string[]> {
  const thread = await page.evaluate((id) => window.roger.getChatThread(id), MEETING);
  return thread.messages.filter(({ role }) => role === 'user').map(({ id }) => id);
}

/** Plays main's events for the answer to `messageId`, in order. */
async function answer(page: Page, messageId: string, ...events: ChatStreamEvent[]): Promise<void> {
  for (const event of events) {
    const message: ChatStreamMessage = { meetingId: MEETING, messageId, event };
    await qa.emitEvent(page, chatChannels.ChatEvent, message);
  }
  await qa.settle(page);
}

const runEvent = (runId: string): ChatStreamEvent => ({
  type: 'run',
  runId,
  model: 'xiaomi/mimo-v2.6-pro',
});
const delta = (text: string): ChatStreamEvent => ({ type: 'delta', text });
const citation = (ref: RefCitation): ChatStreamEvent => ({ type: 'citation', ...ref });

/** The stored answer `done` carries, as the API writes it: only mapped refs, written out. */
function storedAnswer(
  questionId: string,
  id: string,
  runId: string,
  text: string,
  citations: RefCitation[],
): ChatMessage {
  return {
    id,
    role: 'assistant',
    text,
    citations,
    replyTo: questionId,
    runId,
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
}

async function textOf(page: Page, selector: string): Promise<string> {
  return ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Fails unless the box would ask a typed question now: no answer is coming. Ask is off for an
 * empty box anyway, so this types one, reads the button, and empties the box again.
 */
async function expectCanAsk(page: Page): Promise<void> {
  await page.fill(INPUT, 'And Maximilian?');
  const disabled = await page.isDisabled(ASK);
  await page.fill(INPUT, '');
  if (disabled) throw new Error('Ask is off with a question typed and no answer coming');
}

/** The ids of the transcript lines marked `data-cited`, in transcript order. */
const citedIds = (page: Page): Promise<string[]> =>
  page.evaluate(
    (log) =>
      Array.from(document.querySelectorAll(`${log} [data-cited]`), (line) =>
        String(line.getAttribute('data-segment-id')),
      ),
    TRANSCRIPT_LOG,
  );

/** Pixels between the chat log's view and its end: 0 when it shows the newest exchange. */
const chatDistanceFromEnd = (page: Page): Promise<number> =>
  page.evaluate((log) => {
    const element = document.querySelector(log);
    if (element === null) throw new Error('No chat log on the page');
    return element.scrollHeight - element.clientHeight - element.scrollTop;
  }, CHAT_LOG);

/**
 * Fails if the window itself scrolls down. The app is one window tall and scrolls inside its page
 * column, so a taller document means a box escaped every scroller: an absolutely placed one with
 * no positioned ancestor is placed against the window, however deep in a scrolled log it sits.
 * qa.expectNoPageOverflow checks only the sideways scroll.
 */
async function expectNoPageScroll(page: Page): Promise<void> {
  const { overflow, width, escaped } = await page.evaluate(() => {
    const root = document.documentElement;
    // Placed against the window: absolute, with no positioned ancestor (offsetParent is <body>).
    const loose = [...document.body.querySelectorAll('*')].filter(
      (element) =>
        element instanceof HTMLElement &&
        getComputedStyle(element).position === 'absolute' &&
        element.offsetParent === document.body,
    );
    const lowest = loose.at(-1);
    return {
      overflow: root.scrollHeight - root.clientHeight,
      width: window.innerWidth,
      escaped:
        lowest === undefined
          ? 'no absolute box is placed against the window'
          : `${loose.length} absolute box(es) are placed against the window, the last <${lowest.tagName.toLowerCase()}.${[...lowest.classList].join('.')}> at ${Math.round(lowest.getBoundingClientRect().bottom)} px`,
    };
  });
  if (overflow > 0) {
    throw new Error(`The window scrolls down by ${overflow} px at ${width} px: ${escaped}`);
  }
}

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

// The standup's thread ---------------------------------------------------------------------------

const Q_RETRY = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2d1e01';
const Q_TODAY = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2d1e02';
const Q_CLOSE = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2d1e03';
const Q_PRICE = '3e8f1a52-6b7c-4d90-8e21-5a4b3c2d1e04';

function question(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    text,
    citations: [],
    replyTo: null,
    runId: null,
    status: 'complete',
    createdAt: '2026-10-05T09:40:00.000Z',
  };
}

function storedReply(questionId: string, text: string, citations: RefCitation[]): ChatMessage {
  return {
    ...storedAnswer(questionId, `${questionId.slice(0, -4)}aaaa`, `run-${questionId}`, text, []),
    citations,
    createdAt: '2026-10-05T09:40:05.000Z',
  };
}

/** Four exchanges about the standup, as the API stores them. */
const STANDUP_THREAD: readonly ChatMessage[] = [
  question(
    Q_RETRY,
    'How many lines did the uploader retry logic handle, and were there duplicates?',
  ),
  storedReply(
    Q_RETRY,
    'About fifteen hundred lines from a forty minute call, with zero duplicates, because the segment ids are made on the Mac [L6]. The uploader now backs off from two seconds up to thirty, and every line reached Postgres within a minute of the network coming back [L4].',
    [cite(6), cite(4)],
  ),
  question(
    Q_TODAY,
    'What is everyone picking up today?\nOne line each, with the ticket if there is one.',
  ),
  storedReply(
    Q_TODAY,
    [
      'Three things:',
      '- Priyanka: IA-214, the permission screen, https://linear.app/linkt/issue/IA-214/permission-screen-names-the-system-settings-pane-and-the-switch-to-flip [L8]',
      '- Maximilian: one real thirty minute Meet call on the installed app, the Northwind demo at two [L13, L15]',
      '- You: the long-call path, windows of whole lines with twenty lines of overlap, then one reduce pass [L18]',
    ].join('\n'),
    [cite(8), cite(13), cite(15), cite(18)],
  ),
  question(Q_CLOSE, 'Can M1 close today?'),
  storedReply(
    Q_CLOSE,
    "Possibly. Maximilian's two o'clock call covers item three of the release checklist, so M1 could close by end of day if it goes well [L26, L25]. If it does not, the plan is to read the tccd log before touching any code [L28].",
    [cite(26), cite(25), cite(28)],
  ),
  question(Q_PRICE, 'Did anyone mention what a call costs?'),
  storedReply(
    Q_PRICE,
    'Only once: a full hour-long call costs well under a cent with the current model [L17].',
    // Echo removal deleted the line after the answer was written: it is in no transcript now.
    [cite(17, REMOVED_LINE)],
  ),
];

const LONG_THREAD_EXCHANGES = 30;

/**
 * The standup walked through line by line: thirty exchanges, a thread many windows tall. Ids vary
 * before their last four characters, which storedReply swaps for the answer's id.
 */
const LONG_THREAD: readonly ChatMessage[] = PAST_MEETING.lines
  .slice(0, LONG_THREAD_EXCHANGES)
  .flatMap((line, index) => {
    const n = index + 1;
    const id = `9a4c2e61-3d5b-4f70-8c19-${String(n).padStart(4, '0')}6e2f0b01`;
    const who = line.source === 'mic' ? 'You said' : 'Someone on the call said';
    return [
      question(id, n === 1 ? 'Walk me through the call: how did it open?' : 'And after that?'),
      storedReply(id, `${who}: "${line.text}" [L${n}]`, [cite(n)]),
    ];
  });

// The run ----------------------------------------------------------------------------------------

let run: qa.QaRun;
const gallery = new qa.Gallery('M4-T19 meeting chat', 'm4-t19');
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

beforeAll(async () => {
  run = await qa.startQa();
  await warmUpChatBundle();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m4-t19',
      Harness:
        'MeetingChat mounted alone on the preview page beside LiveTranscript, in the meeting page frame and panes, until M4-T20 mounts it',
      Data: 'The past-meeting standup (31 lines); a four-exchange thread; answers played as main forwards them on chat:event',
    },
    'Questions answered with chips into the transcript: a thread, a streamed answer, a failed and a stopped one, an offline read, a question over the limit',
  );
  process.stdout.write(
    `\nM4-T19 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

describe.each(qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width }))))(
  'the meeting chat in $theme at $width px',
  ({ theme, width }) => {
    const tag = `${theme}-${String(width)}`;

    it('shows a thread whose chips open the transcript', async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        await openChat(page, STANDUP_THREAD);
        const narrow = (await shownPane(page)) !== null;
        await shootChecked(
          preview,
          'Thread',
          `thread-${tag}`,
          narrow
            ? 'A phone: the chat pane is up with four exchanges, the newest in view; a list answer with a long link wraps inside the pane'
            : 'Four exchanges beside the transcript, the newest in view: a list answer with a long link, a two-line question, a chip whose line is gone',
          async () => {
            expect(await page.locator(`${CHAT_LOG} > .meeting-chat-exchange`).count()).toBe(4);
            expect(await page.locator(`${CHAT_LOG} .citation-chip`).count()).toBe(8);
            expect(await page.locator(`${exchangeAt(2)} .meeting-chat-text li`).count()).toBe(3);
            expect(await textOf(page, `${exchangeAt(2)} .meeting-chat-question`)).toBe(
              'You asked: What is everyone picking up today? One line each, with the ticket if there is one.',
            );
            // The log opens at its end: the newest exchange is in view.
            expect(await chatDistanceFromEnd(page)).toBeLessThanOrEqual(1);
            await qa.expectVisible(page, `${lastExchange} .citation-chip`, { within: CHAT_LOG });
            await qa.expectVisible(page, ASK);
            await expectToken(
              page,
              `${exchangeAt(1)} .meeting-chat-question`,
              'background-color',
              '--chip-bg',
            );
            await expectToken(page, `${exchangeAt(1)} .meeting-chat-answer`, 'color', '--ink');
          },
        );

        // The first answer's first chip: line 6, at 00:34.
        const chip = `${exchangeAt(1)} .citation-chip`;
        await page.locator(chip).first().scrollIntoViewIfNeeded();
        await page.locator(chip).first().click();
        await qa.settle(page);
        await shootChecked(
          preview,
          'Thread',
          `reveal-${tag}`,
          narrow
            ? 'The chip at 00:34 pressed on a phone: the transcript pane comes forward with line 6 tinted mid-view'
            : 'The chip at 00:34 pressed: line 6 is tinted mid-view in the transcript beside the chat',
          async () => {
            expect(await citedIds(page)).toEqual([pastLine(6)]);
            expect(await shownPane(page)).toBe(narrow ? 'transcript' : null);
            await qa.expectVisible(page, lineSelector(pastLine(6)), { within: TRANSCRIPT_LOG });
            await expectToken(page, lineSelector(pastLine(6)), 'background-color', '--cited-bg');
          },
        );

        // A chip whose line echo removal deleted: it says so, and leaves the panes alone.
        await showChat(page);
        const removed = `${lastExchange} .citation-chip`;
        await page.click(removed);
        await qa.settle(page);
        expect(await textOf(page, removed)).toBe('01:47Line removed');
        expect(await shownPane(page)).toBe(narrow ? 'chat' : null);
      } finally {
        await preview.close();
      }
    });

    it('keeps a long thread inside its log, and the window still', async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        await openChat(page, LONG_THREAD);
        await shootChecked(
          preview,
          'Thread',
          `long-thread-${tag}`,
          'Thirty exchanges: the log scrolls inside the chat pane with the newest in view, and the window itself does not scroll (each exchange carries two screen-reader labels)',
          async () => {
            expect(await page.locator(`${CHAT_LOG} > .meeting-chat-exchange`).count()).toBe(
              LONG_THREAD_EXCHANGES,
            );
            const log = await page.evaluate((selector) => {
              const element = document.querySelector(selector);
              if (element === null) throw new Error('No chat log on the page');
              return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
            }, CHAT_LOG);
            // Taller than its pane by more than a window: escaping labels would show.
            expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 900);
            expect(await chatDistanceFromEnd(page)).toBeLessThanOrEqual(1);
            await qa.expectVisible(page, `${lastExchange} .citation-chip`, { within: CHAT_LOG });
            await qa.expectVisible(page, ASK);
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('streams an answer, chips first for the refs main has mapped', async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        await openChat(page, STANDUP_THREAD);
        const asked = await ask(page, 'Who offered to review the eval report?', 'And when?');
        await shootChecked(
          preview,
          'Streaming',
          `waiting-${tag}`,
          'Asked with Enter (Shift+Enter kept the line break): the question shows at once, the log moves to it, and Stop is offered while Roger reads the meeting',
          async () => {
            expect(await textOf(page, `${lastExchange} .meeting-chat-question`)).toBe(
              'You asked: Who offered to review the eval report? And when?',
            );
            expect(await page.inputValue(INPUT)).toBe('');
            expect(await textOf(page, `${lastExchange} .meeting-chat-state`)).toBe(
              'Reading the meeting...',
            );
            await qa.expectVisible(page, `${lastExchange} .meeting-chat-button`, {
              within: CHAT_LOG,
            });
            expect(await page.isDisabled(ASK)).toBe(true);
          },
        );

        await answer(
          page,
          asked,
          runEvent('a51c2e7d-4f3b-4c86-9d10-6e2f8a4b1c01'),
          delta('Priyanka offered to review it on Thursday morning [L2'),
          delta('3], after you asked for a second pair of eyes on the eval report [L22, N1]'),
          citation(cite(23)),
          citation(cite(22)),
          delta('. She has no blockers of her own'),
        );
        await shootChecked(
          preview,
          'Streaming',
          `streaming-${tag}`,
          'Mid-answer: [L23] and [L22] are chips as their citations came; the note ref [N1] stays text until the stored answer drops it; Writing... and Stop show',
          async () => {
            expect(await textOf(page, `${lastExchange} .meeting-chat-text`)).toBe(
              'Priyanka offered to review it on Thursday morning 02:31, after you asked for a second pair of eyes on the eval report 02:29 [N1]. She has no blockers of her own',
            );
            expect(await textOf(page, `${lastExchange} .meeting-chat-state`)).toBe('Writing...');
            expect(await page.isDisabled(ASK)).toBe(true);
            expect(
              await page.getAttribute(`${lastExchange} .meeting-chat-answer`, 'aria-busy'),
            ).toBe('true');
            expect(await chatDistanceFromEnd(page)).toBeLessThanOrEqual(1);
          },
        );

        await answer(page, asked, {
          type: 'done',
          message: storedAnswer(
            asked,
            'b62d3f8e-5a4c-4d97-8e21-7f3a9b5c2d02',
            'a51c2e7d-4f3b-4c86-9d10-6e2f8a4b1c01',
            'Priyanka offered to review it on Thursday morning [L23], after you asked for a second pair of eyes on the eval report [L22]. She has no blockers of her own.',
            [cite(23), cite(22)],
          ),
        });
        await shootChecked(
          preview,
          'Streaming',
          `done-${tag}`,
          'Done: the stored answer replaces the streamed text, [N1] gone; the box is ready for the next question',
          async () => {
            expect(await textOf(page, `${lastExchange} .meeting-chat-text`)).toBe(
              'Priyanka offered to review it on Thursday morning 02:31, after you asked for a second pair of eyes on the eval report 02:29. She has no blockers of her own.',
            );
            expect(await page.locator(`${lastExchange} .meeting-chat-state`).count()).toBe(0);
            expect(await page.locator(`${lastExchange} .meeting-chat-button`).count()).toBe(0);
            await expectCanAsk(page);
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('keeps a failed answer and asks it again with the same id; a stopped answer says so', async () => {
      const preview = await run.open({ scenario: 'past-meeting', theme, width });
      const { page } = preview;
      try {
        await openChat(page, STANDUP_THREAD);
        const asked = await ask(page, 'What did Maximilian find about the call audio helper?');
        await answer(
          page,
          asked,
          runEvent('c73e4a9f-6b5d-4ea8-9f32-8a4b0c6d3e03'),
          delta('macOS pins the privacy grant to the code signature [L11], so every ad-hoc build'),
          citation(cite(11)),
          { type: 'error', code: 'llm_provider_error', message: 'The model provider failed.' },
        );
        await shootChecked(
          preview,
          'Failures',
          `failed-${tag}`,
          'The model failed mid-answer: what came stays, with its chip, the reason in plain words and Try again',
          async () => {
            expect(await textOf(page, `${lastExchange} .meeting-chat-text`)).toBe(
              'macOS pins the privacy grant to the code signature 01:07, so every ad-hoc build',
            );
            expect(await textOf(page, `${lastExchange} .meeting-chat-error`)).toBe(
              'The AI service did not answer. Try again in a moment.',
            );
            await expectToken(page, `${lastExchange} .meeting-chat-error`, 'color', '--danger-ink');
            await qa.expectVisible(page, `${lastExchange} .meeting-chat-button`, {
              within: CHAT_LOG,
            });
            expect(await textOf(page, `${lastExchange} .meeting-chat-button`)).toBe('Try again');
            await expectCanAsk(page);
          },
        );

        // Try again sends the same id: main's thread holds the question once.
        await page.click(`${lastExchange} .meeting-chat-button`);
        await qa.settle(page);
        expect((await questionIds(page)).filter((id) => id === asked)).toHaveLength(1);
        expect(await textOf(page, `${lastExchange} .meeting-chat-state`)).toBe(
          'Reading the meeting...',
        );
        await answer(
          page,
          asked,
          runEvent('d84f5b0a-7c6e-4fb9-8a43-9b5c1d7e4f04'),
          delta('macOS pins the privacy grant to the code signature [L11].'),
          citation(cite(11)),
          {
            type: 'done',
            message: storedAnswer(
              asked,
              'e95a6c1b-8d7f-4a0c-9b54-0c6d2e8f5a05',
              'd84f5b0a-7c6e-4fb9-8a43-9b5c1d7e4f04',
              'macOS pins the privacy grant to the code signature, so every ad-hoc build silently loses call audio; with a stable signing identity it survives a relaunch [L11].',
              [cite(11)],
            ),
          },
        );
        expect(await textOf(page, `${lastExchange} .meeting-chat-text`)).toBe(
          'macOS pins the privacy grant to the code signature, so every ad-hoc build silently loses call audio; with a stable signing identity it survives a relaunch 01:07.',
        );

        // Stop: the fake ends the answer `cancelled` at once, as main does.
        const stopped = await ask(page, 'Summarise the release checklist');
        await answer(
          page,
          stopped,
          runEvent('f06b7d2c-9e8a-4b1d-8c65-1d7e3f9a6b06'),
          delta('One: the AssemblyAI training opt-out is done [L25]'),
          citation(cite(25)),
        );
        await page.click(`${lastExchange} .meeting-chat-button`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Failures',
          `stopped-${tag}`,
          'Stopped mid-answer: the text so far stays, You stopped this answer, and Ask again; the answer before it was asked again and finished',
          async () => {
            expect(await textOf(page, `${lastExchange} .meeting-chat-text`)).toBe(
              'One: the AssemblyAI training opt-out is done 02:36',
            );
            expect(await textOf(page, `${lastExchange} .meeting-chat-state`)).toBe(
              'You stopped this answer.',
            );
            expect(await page.locator(`${lastExchange} .meeting-chat-error`).count()).toBe(0);
            expect(await textOf(page, `${lastExchange} .meeting-chat-button`)).toBe('Ask again');
            await expectCanAsk(page);
          },
        );
      } finally {
        await preview.close();
      }
    });

    it('says why an offline API cannot open the chat, and opens it once back', async () => {
      const preview = await run.open({ scenario: 'api-offline', theme, width });
      const { page } = preview;
      try {
        await openChat(page, []);
        await shootChecked(
          preview,
          'Failures',
          `offline-${tag}`,
          'The API is offline: the chat says it could not open, with Try again; the box cannot ask meanwhile',
          async () => {
            expect(await textOf(page, `${CHAT_LOG} .problem`)).toMatch(
              /^Could not open this chat\. Roger could not reach its server\. Try again$/,
            );
            await qa.expectVisible(page, `${CHAT_LOG} .problem button`);
            await page.fill(INPUT, 'How many lines?');
            expect(await page.isDisabled(ASK)).toBe(true);
            await page.fill(INPUT, '');
          },
        );
        await qa.setApiOffline(page, false);
        await page.click(`${CHAT_LOG} .problem button`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Empty and limits',
          `empty-${tag}`,
          'Back online, Try again opens the chat: nothing asked yet, so it says what it can answer',
          async () => {
            expect(await textOf(page, `${CHAT_LOG} .meeting-chat-message`)).toBe(
              'Ask anything about this call: what was decided, a number someone gave, who said they would do what. Each answer links to the transcript lines behind it.',
            );
          },
        );

        // Over the API's limit, counted in characters as the API counts them.
        await page.fill(INPUT, `${'Please go through every line again. '.repeat(112)}Thanks.`);
        await shootChecked(
          preview,
          'Empty and limits',
          `too-long-${tag}`,
          'A question over 4,000 characters: the count says so in the danger ink, Ask stays off, and the box scrolls instead of growing past six lines',
          async () => {
            const length = (await page.inputValue(INPUT)).trim().length;
            expect(length).toBeGreaterThan(MAX_CHAT_TEXT_CHARS);
            expect(await textOf(page, `${CHAT} .meeting-chat-count`)).toBe(
              `Too long: ${length} / ${MAX_CHAT_TEXT_CHARS} characters`,
            );
            await expectToken(page, `${CHAT} .meeting-chat-count`, 'color', '--danger-ink');
            expect(await page.isDisabled(ASK)).toBe(true);
            const box = await page.locator(INPUT).boundingBox();
            expect(box?.height ?? 0).toBeLessThanOrEqual(141);
            await qa.expectVisible(page, ASK);
          },
        );
      } finally {
        await preview.close();
      }
    });
  },
);
