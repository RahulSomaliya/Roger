import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { previewCalendarDay } from '../preview/fakes/calendar';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import { START_FAILURE_SENTENCES, unsavedLinesWords } from '../src/main/capture/errorWords';
import { stopNotice } from '../src/main/capture/stopReasons';
import {
  detectWarnings,
  KEYTERMS_REJECTED_MESSAGE,
  type SignalFacts,
  type SourceSignal,
} from '../src/main/capture/warnings';
import { ApiError } from '../src/main/api/http';
import { describeServerFailure } from '../src/main/setup/connectionChecks';
import { SETTINGS_PANES } from '../src/main/settingsPanes';
import { GOOGLE_NOT_SET_UP } from '../src/renderer/src/calendar/calendarFormat';
import { wordsOutsideDetails } from '../src/shared/captureWords';
import { meetingDayLabel } from '../src/renderer/src/app/labels';
import * as qa from '../qa/driver';
import type { CalendarEvent } from '../src/shared/calendar';
import {
  CALL_AUDIO_SILENT_LOUD_MS,
  type CaptureReport,
  type CaptureStatus,
  type CaptureWarning,
  MIC_DEAD_WARNING_MS,
  type UploadStatus,
} from '../src/shared/capture';
import { appChannels } from '../src/shared/ipc/app';
import { calendarChannels } from '../src/shared/ipc/calendar';
import { captureChannels } from '../src/shared/ipc/capture';
import { chatChannels } from '../src/shared/ipc/chat';
import { notesChannels } from '../src/shared/ipc/notes';
import { type SetupCheck, setupChannels, type SetupStatus } from '../src/shared/ipc/setup';
import type {
  ChatMessage,
  LocalNote,
  Note,
  NoteDoc,
  NoteNode,
  RefCitation,
} from '../src/shared/notes';
import type { PromptScenarioId } from '../preview/promptScenarios';

/**
 * The redesign sweep's QA (docs/plans/redesign-sweep.md, T10): every view in its states, in both
 * themes, at the window's two real sizes (1080 x 730, the default, and 420 x 760, the narrow one;
 * qa/driver.ts QA_WIDTHS) on the browser preview (qa/README.md). The prompt panel is checked on its
 * own 1440 x 900 stage, at the place main puts it. Words come from main's own modules
 * (capture/errorWords.ts, capture/warnings.ts, shared/captureWords.ts), never invented copy: a
 * page checked against copy the QA made up proves nothing about what main writes.
 *
 * Every shot is first checked, because a screenshot of a wrong screen is still a screenshot:
 *  - at most ONE visible primary button, and it is the one docs/design.md names for that moment
 *    (the table "The one primary, per screen and moment"). Found by its variant AND by its
 *    computed background, so an accent-filled control that skipped `.btn` is still counted;
 *    `document.elementFromPoint` at its centre must be the button, so nothing covers it;
 *  - every problem line the state has is on screen: a person can see it, not just the DOM;
 *  - no word a person reads outside Details is a vendor, an HTTP code, a route, an address, an
 *    errno or an internal word (`wordsOutsideDetails`, the same list main's tests use);
 *  - the header: "Home" on every page but Home, clear of the traffic lights, the gear current on
 *    Settings only;
 *  - no sideways page scroll, no console error, and no running animation (nothing pulses).
 *
 * The behaviours the sweep promises are their own pieces (`nav`, `appearance`, `focus`): Back,
 * Escape, what main's Cmd+[ sends, focus on the page's h1, Appearance switching the window at once,
 * and no box around the transcript, the chat or My notes.
 *
 * Run it in pieces (a 10-minute stall limit kills one long call; each is well under 8 minutes):
 *   pnpm exec vitest run --config vitest.e2e.config.ts e2e/redesign.qa.e2e.ts -t "^home"
 * The pieces are `home`, `live`, `past`, `chat`, `settings`, `setup`, `prompt`, `offline`, `nav`,
 * `appearance`, `focus` and `words`. Each adds its shots to one gallery folder (ROGER_QA_OUT);
 * clear it before a full run.
 */

const PIECE_TIMEOUT_MS = 240_000;

let run: qa.QaRun;
const gallery = new qa.Gallery('Roger redesign sweep: every surface', 'sweep');
beforeAll(async () => {
  run = await qa.startQa();
});
afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'sw/t10', Date: '2026-10-08', Sizes: '1080 x 730 and 420 x 760' });
});

interface Combo {
  theme: ForcedTheme;
  width: number;
}
const COMBOS: Combo[] = qa.QA_THEMES.flatMap((theme) =>
  qa.QA_WIDTHS.map((width) => ({ theme, width })),
);

/** What a state must show. */
interface Spec {
  /** The gallery group: one per screen. */
  group: string;
  /** The shot's file name, before `-<theme>-<width>`. */
  slug: string;
  /** What the shot proves, in the gallery's words. */
  caption: string;
  /** The label of the one visible primary button, or null when the moment has none. */
  primary: string | null;
  /** Text of problem lines that must be visible: the state is a failure the person must see. */
  problems?: string[];
  /** Text that must be visible (a button, a line): by its words, found in the deepest element. */
  shows?: string[];
  /** Text that must NOT be visible (a tab that should not exist yet, a panel that was removed). */
  hides?: string[];
  /** The prompt panel's page: no shell to grow. */
  prompt?: boolean;
  /**
   * Set up Roger only: the visible controls that leave the page (D6), sorted. A failing check has
   * "Home" alone; once everything passes "Done" joins it, as the primary that finishes. Never
   * "Later", which the sweep removed.
   */
  exits?: string[];
}

/** Checks and shoots the state on screen now; the third argument of a walk's body. */
type Shoot = (spec: Spec) => Promise<void>;

/**
 * Opens a page in each theme and width and hands `body` a `shoot` for every state it passes
 * through, so one walk (write the notes, open the menu, ask to replace them) is a run of shots on
 * one page. A failure names the view it happened in.
 */
async function walkEveryView(
  open: (combo: Combo) => Promise<qa.PreviewPage>,
  body: (preview: qa.PreviewPage, combo: Combo, shoot: Shoot) => Promise<void>,
): Promise<void> {
  for (const combo of COMBOS) {
    const preview = await open(combo);
    let at = 'opening';
    try {
      await body(preview, combo, async (spec) => {
        at = spec.slug;
        await verifyAndShoot(preview, combo, spec);
        at = `after ${spec.slug}`;
      });
    } catch (error) {
      throw new Error(`${at} (${combo.theme}, ${combo.width}): ${reasonOf(error)}`, {
        cause: error,
      });
    } finally {
      await preview.close();
    }
  }
}

/** One state in each theme and width: `open` gets it on screen, `act` takes it from there. */
async function inEveryView(
  spec: Spec,
  open: (combo: Combo) => Promise<qa.PreviewPage>,
  act: (preview: qa.PreviewPage, combo: Combo) => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  await walkEveryView(open, async (preview, combo, shoot) => {
    await act(preview, combo);
    await shoot(spec);
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failure a screen has today, in a file another task owns (R10 fixes only its own): the shot is
 * kept, marked `fail` in the gallery with the owner and the reason, and the run stays green. The
 * entry is removed when its screen is fixed: a run where the screen no longer fails says so, so
 * the list never outlives its bugs.
 */
interface KnownFailure {
  slug: string;
  /** Only this width fails; all of them when absent. */
  width?: number;
  /** The file and what the screen shows. */
  reason: string;
}
const KNOWN_FAILURES: readonly KnownFailure[] = [];

async function verifyAndShoot(preview: qa.PreviewPage, combo: Combo, spec: Spec): Promise<void> {
  const failure = await checkView(preview, spec).then(
    () => null,
    (error: unknown) => reasonOf(error),
  );
  const known = KNOWN_FAILURES.find(
    (each) => each.slug === spec.slug && (each.width === undefined || each.width === combo.width),
  );
  if (failure !== null && known === undefined) throw new Error(failure);
  if (failure === null && known !== undefined) {
    throw new Error(
      `${spec.slug} no longer fails (${known.reason}): remove it from KNOWN_FAILURES`,
    );
  }
  const proof = [
    spec.primary === null ? 'No primary button.' : `One primary: ${spec.primary}.`,
    ...(spec.problems ?? []).map((text) => `Problem line on screen: "${text}".`),
    'No sideways scroll, no console errors, nothing animating.',
  ].join(' ');
  await gallery.shoot(
    preview.page,
    spec.group,
    `${spec.slug}-${combo.theme}-${combo.width}`,
    `${spec.caption} (${combo.theme}, ${combo.width})`,
    failure === null ? 'pass' : 'fail',
    failure === null
      ? proof
      : `Known failure, not this task's file: ${known?.reason ?? ''}. The check said: ${failure}`,
  );
}

async function checkView(preview: qa.PreviewPage, spec: Spec): Promise<void> {
  const { page } = preview;
  // The prompt panel's page has no shell to grow; settle() knows it has no fake to wait on.
  if (spec.prompt !== true) await qa.fitShellPage(page);
  await qa.settle(page);
  await expectNoRunningAnimation(page);
  await qa.expectNoPageOverflow(page);
  const primaries = await visiblePrimaries(page);
  if (primaries.length > 1) {
    throw new Error(`${primaries.length} primary buttons: ${primaries.map(label).join(', ')}`);
  }
  const [primary] = primaries;
  if (spec.primary === null) {
    if (primary !== undefined) throw new Error(`no primary was expected, but ${label(primary)} is`);
  } else if (primary === undefined) {
    throw new Error(`the primary ${spec.primary} is not on screen`);
  } else if (primary.text !== spec.primary) {
    throw new Error(`the primary should be ${spec.primary}, not ${label(primary)}`);
  } else if (primary.covered !== null) {
    throw new Error(`${label(primary)} is covered by ${primary.covered}`);
  }
  await expectMenuInWindow(page);
  if (spec.prompt !== true) await expectHeader(page);
  await expectNoInternals(page);
  if (spec.exits !== undefined) await expectExits(page, spec.exits);
  for (const text of spec.problems ?? []) await expectProblem(page, text);
  for (const text of spec.shows ?? []) await expectTextVisible(page, text);
  for (const text of spec.hides ?? []) await expectTextHidden(page, text);
  qa.expectNoConsoleErrors(preview);
}

// The checks, in the page ------------------------------------------------------------------------

interface PrimaryRead {
  text: string;
  busy: boolean;
  /** What sits on top of the button's centre, or null when the button itself does. */
  covered: string | null;
}

const label = (primary: PrimaryRead): string =>
  primary.busy ? `${primary.text} (busy)` : primary.text;

/**
 * The visible primary buttons: `.btn[data-variant="primary"]`, and any other button whose computed
 * background is the accent fill (a control that skipped the `.btn` classes still counts). With a
 * modal dialog open only its own controls count: the page behind it is inert.
 */
function visiblePrimaries(page: Page): Promise<PrimaryRead[]> {
  return page.evaluate(() => {
    const paint = (token: string): string => {
      const probe = document.createElement('i');
      probe.style.background = `var(${token})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    };
    const fills = [paint('--accent'), paint('--accent-hover')];
    const dialog = document.querySelector('dialog[open]');
    const scope: ParentNode = dialog ?? document;
    const describeEl = (element: Element | null): string =>
      element === null
        ? 'nothing'
        : `<${element.tagName.toLowerCase()}${
            element.classList.length > 0 ? `.${[...element.classList].join('.')}` : ''
          }>`;
    const found: PrimaryRead[] = [];
    for (const element of scope.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], input[type="submit"]',
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || !element.checkVisibility()) continue;
      const filled =
        element.dataset.variant === 'primary' ||
        fills.includes(getComputedStyle(element).backgroundColor);
      if (!filled) continue;
      const words = element.textContent.replace(/\s+/g, ' ').trim();
      const named = words === '' ? (element.ariaLabel ?? '') : words;
      // `disabled` too: Connect with no Google client on the server (D4) is a primary that is off.
      const busy = element.getAttribute('aria-disabled') === 'true' || element.matches(':disabled');
      // A busy button has `pointer-events: none` (styles.css), so elementFromPoint skips it.
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const hit = top !== null && (top === element || element.contains(top));
      found.push({
        text: named,
        busy,
        covered: busy || hit ? null : describeEl(top),
      });
    }
    return found;
  });
}

/** Nothing pulses and nothing is mid-fade (docs/design.md, Motion): no animation is left. */
async function expectNoRunningAnimation(page: Page): Promise<void> {
  const running = await page
    .waitForFunction(() => document.getAnimations().length === 0, undefined, { timeout: 4000 })
    .then(
      () => [],
      () =>
        page.evaluate(() =>
          document.getAnimations().map((animation) => {
            const target =
              animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
            return `${animation.constructor.name} on ${target?.tagName.toLowerCase() ?? '?'}.${
              target?.className ?? ''
            }`;
          }),
        ),
    );
  if (running.length > 0) throw new Error(`still animating: ${running.join('; ')}`);
}

/**
 * Neither check below scrolls: a scroll would move the page the shot is taken of (a transcript that
 * landed on its newest line would be shot at its top). The shell is grown to its content first.
 */

/**
 * What a person types or a model writes, which no rule of ours governs: the transcript's lines, My
 * notes and the AI notes, the questions and answers of the chat, and the jargon list's terms (the
 * preview's holds vendor names on purpose: they are jargon).
 */
const USER_CONTENT =
  '.live-transcript-lines, .note-editor-content, .meeting-chat-question, .meeting-chat-text, .vocabulary-terms';

/**
 * Every piece of text a person reads on the page, outside Details and outside what they wrote: the
 * visible text nodes, and the `aria-label` and `title` of visible elements (a screen reader and a
 * hover read them too). An open Details dialog is the one place that may name a vendor, a route or
 * an errno, so it is left out; any other dialog is read.
 */
function readPageWords(page: Page): Promise<{ text: string; where: string }[]> {
  return page.evaluate((contentSelector) => {
    const place = (element: Element | null): string => {
      const names: string[] = [];
      for (let at = element; at !== null && names.length < 5; at = at.parentElement) {
        names.push(
          at.tagName.toLowerCase() + (at.className ? `.${at.className.split(' ')[0]}` : ''),
        );
      }
      return names.join(' < ');
    };
    const skipped = (element: Element): boolean =>
      element.closest(contentSelector) !== null ||
      [...document.querySelectorAll('dialog[open]')].some(
        (dialog) =>
          // `startsWith`, not a word boundary: the title runs into the first row ("DetailsMicrophone").
          dialog.contains(element) && dialog.textContent.trimStart().startsWith('Details'),
      );
    const found: { text: string; where: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (parent === null || text === '' || skipped(parent) || !parent.checkVisibility()) continue;
      if (parent.closest('script, style') !== null) continue;
      found.push({ text, where: place(parent) });
    }
    for (const element of document.querySelectorAll('[aria-label], [title]')) {
      if (skipped(element) || !element.checkVisibility()) continue;
      for (const name of ['aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (value !== null && value.trim() !== '') {
          found.push({ text: value.trim(), where: `${name} of ${place(element)}` });
        }
      }
    }
    return found;
  }, USER_CONTENT);
}

/**
 * Nothing a person reads is a vendor's name, an HTTP code, a route, an address, an errno, a setting's
 * variable, "helper", "stream", "Postgres", "API" or any other word `wordsOutsideDetails` names
 * (docs/design.md, "Words from main"; docs/plans/redesign-sweep.md, Done when). It is the list
 * main's own tests run every sentence through, so the page and main cannot disagree.
 */
async function expectNoInternals(page: Page): Promise<void> {
  for (const { text, where } of await readPageWords(page)) {
    const pieces = wordsOutsideDetails(text);
    if (pieces.length > 0) {
      throw new Error(
        `text outside Details holds ${pieces.map((piece) => `"${piece}"`).join(', ')}: "${text.slice(0, 120)}" (${where})`,
      );
    }
  }
}

/**
 * The header (docs/plans/redesign-sweep.md, section 4): 52 px, the window's full width; on Home the
 * wordmark and no way back, on every other page "Home" as a button that is on top at its centre;
 * every control clear of the traffic lights' 80 px; the gear current on Settings (aria-current and
 * a drawn difference, V2) and nowhere else. Skipped while a modal dialog covers the page.
 */
async function expectHeader(page: Page): Promise<void> {
  const problem = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.shell');
    const header = document.querySelector<HTMLElement>('.app-header');
    if (shell === null || header === null) return 'the page has no shell or header';
    const route = shell.dataset.route ?? '';
    const box = header.getBoundingClientRect();
    if (Math.round(box.height) !== 52) return `the header is ${box.height} px tall, not 52`;
    if (Math.round(box.width) !== window.innerWidth) {
      return `the header is ${box.width} px wide in a ${window.innerWidth} px window`;
    }
    const modal = document.querySelector('dialog[open]') !== null;
    const back = header.querySelector<HTMLElement>('.app-back');
    if (route === 'home') {
      if (back !== null) return 'Home has a "Home" button';
      if (header.querySelector('.app-brand')?.textContent !== 'Roger')
        return 'Home has no wordmark';
    } else {
      if (back === null) return `${route} has no "Home" button`;
      if (back.textContent.trim() !== 'Home')
        return `${route}'s back button reads "${back.textContent}"`;
      const at = back.getBoundingClientRect();
      if (at.width === 0 || !back.checkVisibility()) return '"Home" is not visible';
      if (!modal) {
        const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
        if (top === null || !back.contains(top)) return '"Home" is covered';
      }
    }
    for (const control of header.querySelectorAll<HTMLElement>('button')) {
      const at = control.getBoundingClientRect();
      if (at.left < 80) {
        return `a header control starts at ${Math.round(at.left)} px, under the traffic lights`;
      }
    }
    const gear = header.querySelector<HTMLElement>('button[aria-label="Settings"]');
    if (gear === null) return 'the header has no Settings button';
    const current = gear.getAttribute('aria-current') === 'page';
    if (current !== (route === 'settings')) {
      return `the gear is ${current ? '' : 'not '}current on ${route}`;
    }
    if (current && getComputedStyle(gear).backgroundColor === 'rgba(0, 0, 0, 0)') {
      return 'the current gear is marked by aria-current alone, not drawn';
    }
    return null;
  });
  if (problem !== null) throw new Error(`header: ${problem}`);
}

/** The visible buttons that leave Set up Roger, by name: "Home" in the header, "Done", "Later". */
async function expectExits(page: Page, expected: string[]): Promise<void> {
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button')]
      .filter((button) => button.checkVisibility())
      .map((button) => button.textContent.replace(/\s+/g, ' ').trim())
      .filter((name) => name === 'Home' || name === 'Done' || name === 'Later')
      .sort(),
  );
  if (seen.join() !== [...expected].sort().join()) {
    throw new Error(`the exits are [${seen.join(', ')}], not [${expected.join(', ')}]`);
  }
}

/** An open menu lies wholly inside the window: a list cut off at an edge hides its items (R13). */
async function expectMenuInWindow(page: Page): Promise<void> {
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      .map((menu) => menu.getBoundingClientRect())
      .filter((box) => box.left < 0 || box.right > innerWidth || box.top < 0)
      .map((box) => `${Math.round(box.left)}..${Math.round(box.right)} of ${innerWidth}`),
  );
  if (outside.length > 0) throw new Error(`a menu runs outside the window: ${outside.join('; ')}`);
}

/** A problem line holding `text` that a person can see: it has a box and nothing covers its centre. */
async function expectProblem(page: Page, text: string): Promise<void> {
  const failure = await page.evaluate((wanted) => {
    const lines = [
      ...document.querySelectorAll<HTMLElement>('.problem, [role="alert"], [role="status"]'),
    ];
    const holders = lines.filter((line) => line.textContent.replace(/\s+/g, ' ').includes(wanted));
    if (holders.length === 0) {
      return `no problem line says "${wanted}" (lines: ${lines
        .map((line) => line.textContent.trim().slice(0, 50))
        .join(' | ')})`;
    }
    for (const line of holders) {
      const box = line.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || !line.checkVisibility()) continue;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (top !== null && (top === line || line.contains(top))) return null;
    }
    return `the problem line "${wanted}" is in the page but not visible`;
  }, text);
  if (failure !== null) throw new Error(failure);
}

/** Text a person can see: the deepest element holding it has a box and nothing over its centre. */
const textVisible = (page: Page, text: string): Promise<boolean | string> =>
  page.evaluate((wanted) => {
    const holds = (element: Element): boolean =>
      element.textContent.replace(/\s+/g, ' ').includes(wanted) ||
      (element.getAttribute('aria-label') ?? '').includes(wanted);
    const deepest = [...document.querySelectorAll<HTMLElement>('body *')].filter(
      (element) => holds(element) && ![...element.children].some(holds),
    );
    if (deepest.length === 0) return `no element says "${wanted}"`;
    for (const element of deepest) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || !element.checkVisibility()) continue;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (top !== null && (top === element || element.contains(top) || top.contains(element))) {
        return true;
      }
    }
    return `"${wanted}" is in the page but not visible`;
  }, text);

async function expectTextVisible(page: Page, text: string): Promise<void> {
  const seen = await textVisible(page, text);
  if (seen !== true) throw new Error(String(seen));
}

async function expectTextHidden(page: Page, text: string): Promise<void> {
  if ((await textVisible(page, text)) === true) throw new Error(`"${text}" is on screen`);
}

// Driving the preview ----------------------------------------------------------------------------

type ScenarioName = Parameters<qa.QaRun['open']>[0]['scenario'];

const openScenario =
  (scenario: ScenarioName) =>
  async ({ theme, width }: Combo): Promise<qa.PreviewPage> => {
    const preview = await run.open({ scenario, theme, width });
    // A fixed frame: the live call adds a line every 200 ms until it is told to stop.
    await qa.stopScenario(preview.page);
    return preview;
  };

/** Main's capture status with `patch` laid over it, sent as main sends a change. */
async function patchStatus(
  page: Page,
  patch: Partial<Pick<CaptureStatus, 'phase' | 'error' | 'errorDetail' | 'notice'>> & {
    warnings?: CaptureWarning[];
    upload?: Partial<UploadStatus>;
  },
): Promise<void> {
  await page.evaluate(
    async ({ channel, change }) => {
      const status = await window.roger.getCaptureStatus();
      const { upload, ...rest } = change;
      const next = { ...status, ...rest, upload: { ...status.upload, ...upload } };
      window.__rogerPreview?.emit(channel, next);
    },
    { channel: captureChannels.CaptureStatusChanged, change: patch },
  );
  await qa.settle(page);
}

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Warnings as main raises them: the facts SignalMonitor measures go through `detectWarnings`, so
 * the message on the page is main's own sentence (capture/warnings.ts MESSAGES), not one the QA
 * wrote. A rule that changes its words changes the shots; one that stops being loud fails here.
 */
function sourceSignal(changes: Partial<SourceSignal> = {}): SourceSignal {
  return { stopped: null, noChunkForMs: 0, silentForMs: 0, heard: true, ...changes };
}

function warningsFor(facts: {
  mic?: Partial<SourceSignal>;
  system?: Partial<SourceSignal>;
  offline?: boolean;
}): CaptureWarning[] {
  const signal: SignalFacts = {
    sources: { mic: sourceSignal(facts.mic), system: sourceSignal(facts.system) },
    micBluetooth: false,
    micSpokeSinceCallSilence: false,
    systemAudioVerified: true,
    offline: facts.offline ?? false,
  };
  return detectWarnings(signal).map(({ heldForMs, ...warning }) => ({
    ...warning,
    since: new Date(Date.now() - Math.max(heldForMs, 60_000)).toISOString(),
  }));
}

function onlyLoud(warnings: CaptureWarning[]): CaptureWarning {
  const [warning] = warnings;
  if (warning?.loud !== true || warnings.length !== 1) {
    throw new Error(`Main's rules raised ${JSON.stringify(warnings)}, not one loud warning`);
  }
  return warning;
}

/** Call audio silent for 3 minutes: main's "Roger can't hear the call". */
const NO_CALL_AUDIO: CaptureWarning = onlyLoud(
  warningsFor({ system: { silentForMs: CALL_AUDIO_SILENT_LOUD_MS } }),
);

async function goToSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('.settings-list');
  await qa.settle(page);
}

async function connectCalendar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await page.waitForSelector('.today');
  await qa.settle(page);
}

/** Opens a meeting from Home's Earlier list. */
async function openEarlier(page: Page, title: RegExp): Promise<void> {
  await page.getByRole('button', { name: title }).click();
  await page.waitForSelector('.meeting-header');
  await page.waitForSelector('.meeting-body');
  await qa.settle(page);
}

/** Opens the recording meeting from Home's hero title. */
async function openLive(page: Page): Promise<void> {
  await page.locator('.home-hero-link').click();
  await page.waitForSelector('.meeting-header');
  await page.waitForSelector('.meeting-body');
  await qa.settle(page);
}

async function pickTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await qa.settle(page);
}

/**
 * The preview's day (previewCalendarDay) with its timed meetings pulled into the next half hour:
 * what "today" holds depends on the clock, and a run late in the evening would show an empty list.
 * One title is long on purpose (a title must wrap, never push the page sideways); the all-day item
 * and the declined call stay in, to prove Home leaves them out.
 */
function dayInTheNextHalfHour(): CalendarEvent[] {
  const minutes: Record<string, number> = {
    'Weekly sync': 2,
    'Daily standup': 9,
    'Vendor demo': 14,
    'Focus time': 16,
    'Client call (Zoom link in the location)': 23,
  };
  const at = (offset: number): string => new Date(Date.now() + offset * 60_000).toISOString();
  return previewCalendarDay(new Date()).map((event) => {
    const offset = minutes[event.title];
    if (event.allDay || offset === undefined) return event;
    return {
      ...event,
      title: event.title === 'Focus time' ? LONG_TITLE : event.title,
      start: at(offset),
      end: at(offset + 30),
    };
  });
}

const LONG_TITLE =
  'Northwind Traders and Contoso quarterly business review with the platform team (moved to the big room)';

// Home -------------------------------------------------------------------------------------------

/**
 * Home's grid (D2, docs/plans/redesign-sweep.md section 4): from 960 px two columns in at most 880
 * px, the hero on the left (a bounded column, at most 340 px) and Today and Earlier on the right (the wide column, at least 440 px), 64 px apart, their tops
 * level; under 960 one column, the right one stacked under the left. R1: at 1080 the hero must not
 * float alone in a centred 360 px column.
 */
async function expectHomeColumns(page: Page, width: number): Promise<void> {
  const read = await page.evaluate(() => {
    const box = (selector: string): DOMRect | null =>
      document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const main = box('.home-main');
    const side = box('.home-side');
    const title = box('.home-hero-title');
    const today = box('.home-side .overline');
    return {
      main: main === null ? null : { left: main.left, right: main.right, bottom: main.bottom },
      side:
        side === null
          ? null
          : { left: side.left, right: side.right, top: side.top, width: side.width },
      // A title short enough to fit must not be cut: its text is wider than its box only if cut.
      cutShort: [...document.querySelectorAll<HTMLElement>('.today-title, .earlier-title')]
        .filter((el) => el.textContent.length <= 20 && el.scrollWidth > el.clientWidth)
        .map((el) => el.textContent),
      titleTop: title?.top ?? null,
      todayTop: today?.top ?? null,
    };
  });
  if (read.main === null || read.side === null) throw new Error('Home has no main or side column');
  if (width >= 960) {
    if (read.side.left < read.main.right) {
      throw new Error(
        `at ${width} px the columns overlap or stack: side starts at ${read.side.left}`,
      );
    }
    // The lists are the wide column (D2): at least 440 px, wider than the bounded hero column.
    if (read.side.width < 440) {
      throw new Error(`the lists column is ${read.side.width} px, under 440`);
    }
    if (read.side.width <= read.main.right - read.main.left) {
      throw new Error('the hero column is as wide as the lists');
    }
    if (read.main.right - read.main.left > 340 + 1) {
      throw new Error(`the hero column is ${read.main.right - read.main.left} px, over 340`);
    }
    if (read.cutShort.length > 0) {
      throw new Error(`titles cut though they fit: ${read.cutShort.join(', ')}`);
    }
    const gap = read.side.left - read.main.right;
    if (gap < 40 || gap > 400) throw new Error(`the columns are ${Math.round(gap)} px apart`);
    if (read.side.right - read.main.left > 880 + 1) {
      throw new Error(
        `the content is ${Math.round(read.side.right - read.main.left)} px wide, not at most 880`,
      );
    }
    if (
      read.titleTop !== null &&
      read.todayTop !== null &&
      Math.abs(read.titleTop - read.todayTop) > 48
    ) {
      throw new Error(`the columns' tops are ${Math.abs(read.titleTop - read.todayTop)} px apart`);
    }
  } else if (read.side.top < read.main.bottom - 1) {
    throw new Error(`at ${width} px the right column sits beside the left, not under it`);
  }
}

describe('home', () => {
  it(
    'an empty Mac: Start notes, and one line to connect the calendar',
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-empty-mac',
          caption: 'A Mac Roger has never recorded on',
          primary: 'Start notes',
          shows: ['Connect Google Calendar'],
        },
        openScenario('empty-mac'),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    "today's meetings: the next one is the hero's subject, one Start notes",
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-today',
          caption: "Calendar connected: the next meeting above Start notes, today's list, Earlier",
          primary: 'Start notes',
          shows: ['Weekly sync', 'Northwind Traders', 'Earlier'],
        },
        openScenario('past-meeting'),
        async ({ page }, { width }) => {
          await connectCalendar(page);
          await qa.emitEvent(page, calendarChannels.CalendarEventsChanged, dayInTheNextHalfHour());
          await qa.settle(page);
          await expectHomeColumns(page, width);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'starting: the button says so and keeps its colour',
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-starting',
          caption: 'Start was pressed: the one primary reads Starting, in full colour',
          primary: 'Starting…',
        },
        openScenario('empty-mac'),
        ({ page }) => patchStatus(page, { phase: 'starting' }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'recording: the live meeting with Stop above the calendar',
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-recording',
          caption: 'A call records: its title, Stop, and the recording chip in the header',
          primary: 'Stop',
          shows: [LIVE_CALL.title, 'Recording'],
        },
        openScenario('live-call'),
        ({ page }) => connectCalendar(page),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'recording, with the call audio gone: the warning is on Home too',
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-recording-warning',
          caption: 'Loud warning while recording, away from the meeting: a line at the top',
          primary: 'Stop',
          // The banner reads main's message; the status line on the meeting page its headline.
          problems: ['Call audio has been silent for 3 minutes'],
        },
        openScenario('live-call'),
        ({ page }) => patchStatus(page, { warnings: [NO_CALL_AUDIO] }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'the calendar needs reconnecting: one quiet line in Today, with Reconnect',
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-calendar-problem',
          caption:
            'Google refused the calendar: one line with Reconnect, Start notes still the primary',
          primary: 'Start notes',
          problems: ['Reconnect'],
        },
        openScenario('past-meeting'),
        async ({ page }) => {
          await connectCalendar(page);
          await qa.emitEvent(page, calendarChannels.CalendarSyncStateChanged, {
            lastSuccessAt: minutesAgo(180),
            lastError: 'invalid_grant',
            staleSince: minutesAgo(180),
            reconnectRequired: true,
          });
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );
});

describe('home, calendar not set up', () => {
  it(
    "Google Calendar is not set up on Roger's server: Connect is off and the reason sits beside it",
    async () => {
      await inEveryView(
        {
          group: 'Home',
          slug: 'home-calendar-not-set-up',
          caption:
            'The server has no Google client (D4): Connect cannot work, so it is off and says why; Start notes stays the one primary',
          primary: 'Start notes',
          shows: [GOOGLE_NOT_SET_UP],
        },
        openScenario('empty-mac'),
        async ({ page }) => {
          await qa.failNextRequest(page, GOOGLE_NOT_SET_UP);
          await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
          await page.getByText(GOOGLE_NOT_SET_UP).waitFor();
          await qa.settle(page);
          const off = await page
            .getByRole('button', { name: 'Connect Google Calendar' })
            .isDisabled();
          if (!off) throw new Error('Connect is still pressable with no Google client');
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );
});

// The live meeting -------------------------------------------------------------------------------

/** Opens the recording meeting from Home. */
const liveMeeting = async (combo: Combo): Promise<qa.PreviewPage> => {
  const preview = await openScenario('live-call')(combo);
  await openLive(preview.page);
  return preview;
};

/** The microphone sending only silence: main's "Roger can't hear you". */
const NO_MIC_AUDIO: CaptureWarning = onlyLoud(
  warningsFor({ mic: { silentForMs: MIC_DEAD_WARNING_MS } }),
);

/** Quiet: on screen only in Details, never in the status line (docs/plans/redesign.md). */
const KEYTERMS_REFUSED: CaptureWarning = {
  kind: 'keyterms-rejected',
  source: 'system',
  since: minutesAgo(30),
  message: KEYTERMS_REJECTED_MESSAGE,
  loud: false,
};

describe('live', () => {
  it(
    'recording: the status line says Recording, Stop is the one primary',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-recording',
          caption: 'Title, Stop, "Recording · 39m", the consent line; no panel, no meter, no pill',
          primary: 'Stop',
          shows: ['Recording ·', 'Copy notice', 'Details'],
        },
        liveMeeting,
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a loud capture warning takes the status line, and Stop stays',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-warning',
          caption:
            'The call audio is gone: the status line says so in words, the editor does not move',
          primary: 'Stop',
          problems: ["Roger can't hear the call"],
        },
        liveMeeting,
        ({ page }) => patchStatus(page, { warnings: [NO_CALL_AUDIO] }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'two streams in trouble: the first is named, the rest counted',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-two-warnings',
          caption: 'Microphone and call audio both silent: one line, "+1 more"',
          primary: 'Stop',
          problems: ["Roger can't hear you", '+1 more'],
        },
        liveMeeting,
        ({ page }) => patchStatus(page, { warnings: [NO_MIC_AUDIO, NO_CALL_AUDIO] }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'lines that could not be saved on this Mac stay on screen',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-not-saved',
          caption: 'House rule 1: a call that is not being saved, as a line at the top',
          primary: 'Stop',
          problems: ['12 lines could not be saved on this Mac'],
        },
        liveMeeting,
        ({ page }) => {
          // Main's sentence for the page, and the store's own text for Details only.
          const words = unsavedLinesWords(12, 'SQLITE_FULL: database or disk is full');
          return patchStatus(page, { error: words.sentence, errorDetail: words.detail });
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'Details: what the page used to show, one click away',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-details',
          caption:
            'The Details dialog: the warning in full, sources, saved and uploaded, cost, the quiet notes',
          // The dialog's own controls count: Stop is behind the scrim.
          primary: null,
          shows: ['Happening now', 'Saved on this Mac', 'jargon list'],
        },
        liveMeeting,
        async ({ page }) => {
          await patchStatus(page, { warnings: [NO_CALL_AUDIO, KEYTERMS_REFUSED] });
          await page.getByRole('button', { name: 'Details' }).click();
          await page.waitForSelector('dialog[open] .dialog-panel');
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'stopping: Stopping… in full colour, no click',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-stopping',
          caption:
            'Stop was pressed: the primary says Stopping…, keeps its colour and takes no clicks',
          primary: 'Stopping…',
        },
        liveMeeting,
        ({ page }) => patchStatus(page, { phase: 'stopping' }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'the transcript, opened from another tab, lands on the newest line',
    async () => {
      await inEveryView(
        {
          group: 'Live meeting',
          slug: 'live-transcript',
          caption: 'My notes, then Transcript: the newest line is in view, nothing to scroll for',
          primary: 'Stop',
          shows: ['Them', 'Me'],
        },
        liveMeeting,
        async ({ page }) => {
          await pickTab(page, 'Transcript');
          await page.waitForSelector('.live-transcript-lines [data-segment-id]');
          await expectNewestLineInView(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );
});

/**
 * The transcript tab, opened cold from another tab, shows its end: the log follows, and its newest
 * line is inside the log's box with nothing over it (a line scrolled to the top of 500 would pass
 * "a line is visible", so the end is checked by the log's own scroll position too).
 */
async function expectNewestLineInView(page: Page): Promise<void> {
  const problem = await page.evaluate(() => {
    const log = document.querySelector<HTMLElement>('.live-transcript-lines');
    const lines = log?.querySelectorAll<HTMLElement>('[data-segment-id]');
    const newest = lines?.[lines.length - 1];
    if (log === null || newest === undefined) return 'the transcript has no lines';
    if (document.querySelector('.live-transcript')?.getAttribute('data-following') !== 'true') {
      return 'the transcript is not following the call';
    }
    const box = newest.getBoundingClientRect();
    const area = log.getBoundingClientRect();
    if (box.bottom > area.bottom + 1 || box.top < area.top) {
      return `the newest line (${Math.round(box.top)}-${Math.round(box.bottom)}) is outside the log (${Math.round(area.top)}-${Math.round(area.bottom)})`;
    }
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top !== null && (top === newest || newest.contains(top))
      ? null
      : 'something covers the newest line';
  });
  if (problem !== null) throw new Error(problem);
}

// A past meeting ---------------------------------------------------------------------------------

const PAST_ID = PAST_MEETING.meetingId;

/** The AI notes pane once its tab is the one shown. */
const AI_PANE = '.meeting-pane[data-pane="ai"]:not([hidden])';

/** The chip's time as the notes carry it: "00:15", or "1:02:05" past an hour. */
function chipLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const clock = [Math.floor((total % 3600) / 60), total % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return hours > 0 ? `${hours}:${clock}` : clock;
}

const words = (text: string): NoteNode => ({ type: 'text', text });

/** A chip on `line` (counting from 1) of the standup: its id and time come from the fixture. */
function chip(line: number, support: 'ok' | 'weak' = 'ok'): NoteNode {
  const found = PAST_MEETING.lines[line - 1];
  if (found === undefined) throw new Error(`The standup has no line ${line}`);
  return {
    type: 'citation',
    attrs: {
      segmentIds: [segmentIdForLine(PAST_ID, line)],
      startMs: found.startMs,
      label: chipLabel(found.startMs),
      support,
    },
  };
}

const bullet = (...parts: NoteNode[]): NoteNode => ({
  type: 'listItem',
  content: [{ type: 'paragraph', content: parts }],
});

const section = (heading: string, ...items: NoteNode[]): NoteNode[] => [
  { type: 'heading', attrs: { level: 2 }, content: [words(heading)] },
  { type: 'bulletList', content: items },
];

/** The standup's AI notes, as the API's builder writes them: bullets with chips, one flagged. */
function standupNotes(): NoteDoc {
  return {
    type: 'doc',
    content: [
      ...section(
        'Done',
        bullet(
          words(
            'Priyanka finished the uploader’s retry logic: it backs off from two to thirty seconds, and a forty-minute call arrived with zero duplicates. ',
          ),
          chip(4),
          words(' '),
          chip(6, 'weak'),
        ),
        bullet(
          words(
            'Maximilian fixed Tuesday’s field report: macOS pins the privacy grant to the code signature, so ad-hoc builds lost it. ',
          ),
          chip(11),
        ),
        bullet(
          words(
            'Rahul cut the notes prompt to about fifteen thousand tokens for an hour-long call. ',
          ),
          chip(17),
        ),
      ),
      ...section(
        'Next',
        bullet(words('Priyanka picks up IA-214, the permission screen. '), chip(8)),
        bullet(
          words('Maximilian records the Northwind demo at two to test the installed app. '),
          chip(15),
        ),
      ),
      ...section(
        'Blockers',
        bullet(
          words('None. Rahul wants a second pair of eyes on the eval report on Thursday. '),
          chip(22),
        ),
      ),
    ],
  };
}

function aiNote(doc: NoteDoc, runId: string, overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: PAST_ID,
    kind: 'ai',
    doc,
    revisionId: null,
    dirty: false,
    baseVersion: 1,
    templateId: 'standup',
    lastRunId: runId,
    generatedVersion: 1,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The standup, opened from Home's Earlier list with its notes tab on screen. */
const pastMeeting = async (combo: Combo): Promise<qa.PreviewPage> => {
  const preview = await openScenario('past-meeting')(combo);
  await openEarlier(preview.page, /Daily standup/);
  return preview;
};

/** What a person types into My notes during a standup. */
const MY_NOTES_TEXT = [
  'Priyanka: uploader retries done, 1,500 lines and no duplicates',
  'Maximilian: macOS ties the privacy grant to the signature. Needs a real 30 min Meet call today',
  'Me: notes prompt at 15k tokens; long-call path next',
  'Ask Anneliese for the seat export (Rotterdam viewers)',
];

async function typeMyNotes(page: Page): Promise<void> {
  const editor = page.locator('section[aria-label="My notes"] .note-editor-content');
  await editor.click();
  for (const [index, line] of MY_NOTES_TEXT.entries()) {
    if (index > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  // The debounced save runs after a pause; the page says nothing when it succeeds.
  await page.waitForTimeout(1200);
  await qa.settle(page);
}

/** Streams the run's end as the API would: its start, then the finished notes. */
async function finishWritingNotes(page: Page): Promise<string> {
  const pending = await page.evaluate((id) => window.roger.getPendingGenerate(id), PAST_ID);
  if (pending === null) throw new Error('Write notes started no generate');
  const { runId } = pending;
  await qa.emitEvent(page, notesChannels.NotesEvent, {
    meetingId: PAST_ID,
    runId,
    event: {
      type: 'run',
      runId,
      model: 'preview',
      templateId: pending.templateId,
      lineCount: PAST_MEETING.lines.length,
    },
  });
  const note: Note = {
    kind: 'ai',
    doc: standupNotes(),
    version: 1,
    templateId: pending.templateId,
    lastRunId: runId,
    generatedVersion: 1,
    updatedAt: new Date().toISOString(),
  };
  await qa.emitEvent(page, notesChannels.NotesEvent, {
    meetingId: PAST_ID,
    runId,
    event: { type: 'done', runId, note },
  });
  await page.waitForSelector('.ai-notes-editor .citation-chip');
  await qa.settle(page);
  return runId;
}

describe('past', () => {
  it(
    'a past meeting: My notes, Write notes, the AI notes tab only once they exist',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await typeMyNotes(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-my-notes',
          caption:
            'My notes, typed during the call; Write notes is the one primary, no AI notes tab yet',
          primary: 'Write notes',
          // The time line is Home's date form, not the system locale's (R13): "Mon 5 Oct, 3:00 pm".
          shows: [
            'My notes',
            'Transcript',
            'Chat',
            'Details',
            `${meetingDayLabel(PAST_MEETING.startedAt, new Date())}, `,
          ],
          hides: ['No AI notes yet', 'Which kind of call'],
        });

        await page.getByRole('button', { name: 'Write notes' }).click();
        await page.waitForSelector(AI_PANE);
        await qa.settle(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-writing',
          caption:
            'Write notes was pressed: Writing notes…, with Cancel; the AI notes tab has appeared',
          primary: 'Writing notes…',
          shows: ['Cancel', 'AI notes'],
        });

        await finishWritingNotes(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-ai-notes',
          caption:
            'The AI notes: every line a chip to its transcript line, one flagged "check"; no primary',
          primary: null,
          shows: ['00:15', 'check', 'More actions'],
        });

        await page.getByRole('button', { name: 'More actions' }).click();
        await page.waitForSelector('[role="menu"]');
        await qa.settle(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-menu',
          caption:
            'The ⋯ menu: Copy notes, then Write again as each template; used rarely, so not on the page',
          primary: null,
          shows: ['Copy notes', 'Write again as General', 'Write again as Standup'],
        });

        // D5: Copy notes puts the AI notes on the clipboard as plain text, chip times left out,
        // and says "Notes copied" beside the buttons, not in the tab row (it must not move it).
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.getByRole('menuitem', { name: 'Copy notes' }).click();
        await page.getByText('Notes copied').waitFor();
        await qa.settle(page);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        if (!copied.includes('Priyanka finished the uploader')) {
          throw new Error(`Copy notes copied "${copied.slice(0, 80)}", not the AI notes`);
        }
        if (/\b0\d:\d\d\b/.test(copied)) throw new Error('the copied notes hold chip times');
        await shoot({
          group: 'Past meeting',
          slug: 'past-notes-copied',
          caption:
            'Copy notes was chosen: "Notes copied" beside the buttons, the clipboard holds the notes',
          primary: null,
          shows: ['Notes copied'],
        });

        await pickTab(page, 'Transcript');
        await page.waitForSelector('.live-transcript-lines [data-segment-id]');
        await shoot({
          group: 'Past meeting',
          slug: 'past-transcript',
          caption: 'The Transcript tab of a past meeting: every line, who said it, when',
          primary: null,
          shows: ['Priyanka', 'Transcript'],
        });

        await page.getByRole('button', { name: 'Details' }).click();
        await page.waitForSelector('dialog[open] .dialog-body');
        await qa.settle(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-details',
          caption: 'Details of a past meeting is never empty (D3): the stored facts of the call',
          primary: null,
          shows: ['Saved on this Mac'],
        });
        await page.keyboard.press('Escape');
        await qa.settle(page);
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'writing again over edited notes asks first, and a chip shows its line',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await page.getByRole('button', { name: 'Write notes' }).click();
        await page.waitForSelector(AI_PANE);
        const runId = await finishWritingNotes(page);

        // A chip reveals its transcript line: the tab switches, the line is centred and tinted.
        await page.locator('.ai-notes-editor .citation-chip').first().click();
        await page.waitForSelector('[data-cited]');
        await qa.settle(page);
        await qa.expectVisible(page, '[data-cited]');
        await shoot({
          group: 'Past meeting',
          slug: 'past-chip-reveal',
          caption: 'A chip was pressed: the Transcript tab, its line centred under the one tint',
          primary: null,
          shows: ['Priyanka', 'Transcript'],
        });

        // The person edits the AI notes, then asks to write them again.
        await pickTab(page, 'AI notes');
        const edited: NoteDoc = standupNotes();
        edited.content?.push({
          type: 'paragraph',
          content: [words('Added by me: ask Anneliese about the seat export.')],
        });
        await qa.emitEvent(
          page,
          notesChannels.NotesChanged,
          aiNote(edited, runId, {
            dirty: true,
            revisionId: randomUUID(),
            baseVersion: 2,
            sync: 'saved_locally',
          }),
        );
        await qa.settle(page);
        await page.getByRole('button', { name: 'More actions' }).click();
        // A real click: the menu must be inside the window at 390 too (checkView's bounds check).
        await page.getByRole('menuitem', { name: 'Write again as General' }).click();
        await page.waitForSelector('dialog[open]');
        await qa.settle(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-replace-confirm',
          caption:
            'Write again over notes the person edited: a question first, neither answer the primary',
          primary: null,
          shows: ['Replace your edited AI notes?', 'Keep my edits', 'Write again'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

/** A report that says two stretches of the standup were not transcribed, and the audio is kept. */
function reportWithGaps(): CaptureReport {
  const gap = (
    id: string,
    source: 'mic' | 'system',
    startMs: number,
    endMs: number,
  ): CaptureReport['gaps'][number] => ({
    id,
    source,
    startMs,
    endMs,
    reason: 'offline',
    recoveredAt: null,
    recoverError: null,
  });
  return {
    meetingId: PAST_ID,
    stopReason: 'user',
    gaps: [gap('gap-1', 'system', 61_000, 92_000), gap('gap-2', 'mic', 120_000, 132_000)],
    events: [],
    echo: { hidden: 0, trimmed: 0, held: 0 },
    backup: {
      state: 'kept',
      bytes: 41_000_000,
      keepUntil: new Date(Date.now() + 5 * 24 * 3_600_000).toISOString(),
      keptForRerun: true,
      message: null,
    },
  };
}

describe('past with a gap', () => {
  it(
    'a gap says so on the page, and its audio and Delete audio live in Details',
    async () => {
      await walkEveryView(openScenario('past-meeting'), async ({ page }, _combo, shoot) => {
        await qa.emitEvent(page, captureChannels.CaptureGetReport, reportWithGaps());
        await openEarlier(page, /Daily standup/);
        await page.getByText('were not transcribed').waitFor();
        await shoot({
          group: 'Past meeting',
          slug: 'past-gap-line',
          caption:
            '"2 parts were not transcribed · Transcribe again": one line, the action a secondary',
          primary: 'Write notes',
          shows: ['2 parts were not transcribed', 'Transcribe again'],
        });

        await page.getByRole('button', { name: 'Details' }).click();
        await page.waitForSelector('dialog[open] .dialog-panel, dialog[open] .audio-kept');
        await page.getByRole('button', { name: 'Delete audio' }).click();
        await qa.settle(page);
        await shoot({
          group: 'Past meeting',
          slug: 'past-delete-audio',
          caption:
            'Details: the kept audio, and Delete audio confirming in place ("Delete audio? Its lines stay.")',
          primary: null,
          shows: ['Delete audio? Its lines stay.', 'Transcribe again'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Chat -------------------------------------------------------------------------------------------

const CHAT_BOX = 'section[aria-label="Chat"] textarea';

/** A ref the answer cites (`[L15]`), mapped to its line of the standup as the API maps it. */
function refTo(line: number): RefCitation {
  const found = PAST_MEETING.lines[line - 1];
  if (found === undefined) throw new Error(`The standup has no line ${line}`);
  return { ref: `L${line}`, segmentId: segmentIdForLine(PAST_ID, line), startMs: found.startMs };
}

/** Types a question and sends it with Enter; returns the id the page gave it. */
async function askInChat(page: Page, question: string): Promise<string> {
  await page.locator(CHAT_BOX).fill(question);
  await page.locator(CHAT_BOX).press('Enter');
  await page.waitForSelector('.meeting-chat-question');
  const thread = await page.evaluate((id) => window.roger.getChatThread(id), PAST_ID);
  const asked = thread.messages.findLast((message) => message.role === 'user');
  if (asked === undefined) throw new Error('The question reached no thread');
  return asked.id;
}

async function answerInChat(
  page: Page,
  questionId: string,
  text: string,
  lines: number[],
): Promise<void> {
  const answer: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    text,
    citations: lines.map(refTo),
    replyTo: questionId,
    runId: randomUUID(),
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  await qa.emitEvent(page, chatChannels.ChatEvent, {
    meetingId: PAST_ID,
    messageId: questionId,
    event: { type: 'done', message: answer },
  });
  await qa.settle(page);
}

describe('chat', () => {
  it(
    'an answer with chips, then an answer that failed',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await pickTab(page, 'Chat');
        const first = await askInChat(
          page,
          'What did Maximilian say about the Northwind demo, and what if it fails?',
        );
        await answerInChat(
          page,
          first,
          [
            'Maximilian records the Northwind demo at two as his one real thirty-minute call on the installed app [L15].',
            '- If it works, the release checklist closes and M1 could close by end of day [L26].',
            '- If it does not, the team reads the tccd log before touching any code [L28].',
          ].join('\n'),
          [15, 26, 28],
        );
        await qa.expectVisible(page, '.meeting-chat .citation-chip');
        await shoot({
          group: 'Chat',
          slug: 'chat-answer',
          caption: 'An answer from the transcript: each claim a chip; the box says what it is for',
          // No AI notes yet, so the meeting's one primary is still Write notes.
          primary: 'Write notes',
          shows: ['What did Maximilian say', '01:37'],
          hides: ['Ask anything about this call'],
        });

        const second = await askInChat(page, 'Who owns the seat list?');
        await qa.emitEvent(page, chatChannels.ChatEvent, {
          meetingId: PAST_ID,
          messageId: second,
          event: { type: 'error', code: 'llm_provider_error', message: 'upstream 529' },
        });
        await qa.settle(page);
        await shoot({
          group: 'Chat',
          slug: 'chat-answer-failed',
          caption: 'The AI service did not answer: a line with Try again, the question kept',
          // No AI notes yet, so the meeting's one primary is still Write notes.
          primary: 'Write notes',
          problems: ['The AI service did not answer'],
          shows: ['Try again', 'Who owns the seat list?'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a chat that cannot be read says so, with Try again',
    async () => {
      await walkEveryView(openScenario('api-offline'), async ({ page }, _combo, shoot) => {
        await openEarlier(page, /Daily standup/);
        await pickTab(page, 'Chat');
        await page.waitForSelector('.meeting-chat-log .problem');
        await shoot({
          group: 'Chat',
          slug: 'chat-read-failure',
          caption: "Roger's server is away: the chat could not be read, in words, with Try again",
          // No AI notes yet, so the meeting's one primary is still Write notes.
          primary: 'Write notes',
          problems: ['Could not open this chat'],
          shows: ['Try again'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Settings ---------------------------------------------------------------------------------------

/** Settings with the calendar connected: Connect on Home (the fake provider), then the gear. */
const connectedSettings = async (combo: Combo): Promise<qa.PreviewPage> => {
  const preview = await openScenario('past-meeting')(combo);
  await connectCalendar(preview.page);
  await goToSettings(preview.page);
  return preview;
};

describe('settings', () => {
  it(
    'no calendar yet: Connect Google Calendar is the one primary',
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-not-connected',
          caption:
            'Nothing connected: Appearance first, the jargon list, and Connect Google Calendar as the one primary',
          primary: 'Connect Google Calendar',
          shows: ['Appearance', 'System', 'Light', 'Dark', 'Jargon list', 'Calendar'],
          hides: ['Save', 'No calendar connected'],
        },
        openScenario('empty-mac'),
        ({ page }) => goToSettings(page),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'connected: sections are space and a hairline, nothing is primary',
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-connected',
          caption:
            'The demo calendar (a developer set CALENDAR_PROVIDER=fake): the account says so, then Remind me, the notice and its text, Open at login; no Save, no counters',
          primary: null,
          shows: ['Connected as Demo calendar', 'Notice text', 'Open Roger at login'],
          hides: ['Save notice', 'of 100 terms', 'you@example.com'],
        },
        connectedSettings,
        async ({ page }) => {
          // A long term must wrap or clip inside its chip, never push the page.
          await page
            .getByPlaceholder(/Add names/)
            .fill('Linkt Courseware Platform Services Incorporated');
          await page.getByRole('button', { name: 'Add' }).click();
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a Google account: the address, Disconnect asks before it ends every reminder',
    async () => {
      await walkEveryView(connectedSettings, async ({ page }, _combo, shoot) => {
        await qa.emitEvent(page, calendarChannels.CalendarConnectionChanged, {
          provider: 'google',
          accountEmail: 'rahul@linkt.ai',
          status: 'active',
          connectedAt: minutesAgo(600),
          expiresHint: null,
          lastError: null,
        });
        await qa.settle(page);
        await shoot({
          group: 'Settings',
          slug: 'settings-google-account',
          caption: 'A real Google account: its address, nothing primary, Disconnect a ghost',
          primary: null,
          shows: ['Connected as rahul@linkt.ai', 'Disconnect'],
          hides: ['Demo calendar'],
        });
        await page.getByRole('button', { name: 'Disconnect' }).click();
        await page.getByText('Disconnect Google Calendar? Reminders stop.').waitFor();
        await qa.settle(page);
        const onCancel = await page.evaluate(
          () => document.activeElement?.textContent.trim() ?? '',
        );
        if (onCancel !== 'Cancel') throw new Error(`the question's focus is on "${onCancel}"`);
        await shoot({
          group: 'Settings',
          slug: 'settings-disconnect-confirm',
          caption:
            'Disconnect was pressed: "Disconnect Google Calendar? Reminders stop." in place, focus on Cancel (D4)',
          primary: null,
          problems: ['Disconnect Google Calendar? Reminders stop.'],
          shows: ['Cancel', 'Disconnect'],
        });
        // Escape closes the question only: it must not also leave Settings for Home.
        await page.keyboard.press('Escape');
        await qa.settle(page);
        await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
        await page.getByRole('button', { name: 'Disconnect' }).waitFor();
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    "Google Calendar is not set up on Roger's server: Connect is off in Settings too",
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-not-set-up',
          caption:
            'The server has no Google client: Connect is off with the reason beside it, nothing offers a retry that cannot work',
          // Still the view's one primary, drawn off: pressing it can only fail again.
          primary: 'Connect Google Calendar',
          shows: [GOOGLE_NOT_SET_UP, 'Appearance'],
        },
        openScenario('empty-mac'),
        async ({ page }) => {
          await goToSettings(page);
          await qa.failNextRequest(page, GOOGLE_NOT_SET_UP);
          await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
          await page.getByText(GOOGLE_NOT_SET_UP).waitFor();
          await qa.settle(page);
          if (await page.getByRole('button', { name: 'Connect Google Calendar' }).isEnabled()) {
            throw new Error('Connect is still pressable with no Google client');
          }
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'Google refused the grant: Reconnect takes the primary',
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-reconnect',
          caption:
            'The calendar needs signing in again: Reconnect is the one primary, Disconnect a ghost',
          primary: 'Reconnect',
          shows: ['Disconnect'],
        },
        connectedSettings,
        async ({ page }) => {
          await qa.emitEvent(page, calendarChannels.CalendarSyncStateChanged, {
            lastSuccessAt: minutesAgo(180),
            lastError: 'invalid_grant',
            staleSince: minutesAgo(180),
            reconnectRequired: true,
          });
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a setting that could not be saved says so, in words',
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-save-failed',
          caption:
            'The reminder could not be saved: one line under the section, the choice kept on screen',
          primary: null,
          problems: ['could not save that setting'],
        },
        connectedSettings,
        async ({ page }) => {
          await qa.failNextRequest(page, 'the preferences file is read-only');
          await page.getByLabel('Remind me').selectOption({ index: 2 });
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a jargon term that could not be saved: Not saved, with Try again',
    async () => {
      await inEveryView(
        {
          group: 'Settings',
          slug: 'settings-jargon-failed',
          caption: "Roger's server is away: the new term shows as Not saved, with Try again",
          primary: null,
          problems: ['Not saved: Roger could not reach its server.'],
          shows: ['Try again'],
        },
        connectedSettings,
        async ({ page }) => {
          await qa.setApiOffline(page, true);
          await page.getByPlaceholder(/Add names/).fill('Anneliese Vandenbroucke-Haverkamp');
          await page.getByRole('button', { name: 'Add' }).click();
          await page.waitForSelector('.settings-list .problem');
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );
});

// Set up Roger -----------------------------------------------------------------------------------

const fine = <State extends string>(state: State): SetupCheck<State> => ({
  state,
  message: null,
  relaunchNeeded: false,
});

/** A Mac where every check passes, with `changes` laid over it. */
function setupMac(changes: Partial<SetupStatus> = {}): SetupStatus {
  return {
    microphone: fine('granted'),
    systemAudio: fine('verified'),
    systemCapture: 'tap',
    screenRecording: null,
    notifications: fine('shown'),
    signing: fine('local-identity'),
    api: fine('ok'),
    stt: fine('ok'),
    ...changes,
  };
}

/** Set up Roger on a Mac in `status`: main answers it, then the window goes to `#/setup`. */
const openSetup =
  (status: SetupStatus) =>
  async (combo: Combo): Promise<qa.PreviewPage> => {
    const preview = await openScenario('empty-mac')(combo);
    await qa.emitEvent(preview.page, setupChannels.SetupGetStatus, status);
    await preview.page.evaluate(() => {
      window.location.hash = '#/setup';
    });
    await preview.page.getByRole('heading', { name: 'Set up Roger' }).waitFor();
    await qa.settle(preview.page);
    return preview;
  };

describe('setup', () => {
  it(
    'a first run: Allow microphone leads, ‹ Home is the one way out',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-first-run',
          caption:
            'Microphone not asked yet: its fix is the one primary; the passing rows are one line',
          exits: ['Home'],
          primary: 'Allow microphone',
          shows: ['checks pass'],
          hides: ['Later', 'Done'],
        },
        openSetup(setupMac({ microphone: fine('not-determined'), systemAudio: fine('unknown') })),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a check that fails says what is wrong and what fixes it',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-mic-denied',
          caption:
            'Microphone refused in System Settings: what is wrong, and the button that opens it',
          exits: ['Home'],
          primary: 'Open Microphone settings',
          shows: ['Roger is not allowed to use the microphone'],
          hides: ['Later'],
        },
        openSetup(
          setupMac({
            microphone: {
              state: 'denied',
              // PermissionService.microphoneCheck's words for a denied microphone, with its pane.
              message: `Roger is not allowed to use the microphone. Turn on Roger under ${SETTINGS_PANES.microphone.where}, then relaunch Roger.`,
              relaunchNeeded: true,
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'call audio not heard in the test: its fix leads, with the reason',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-call-audio',
          caption:
            'The call audio test heard nothing: why, and the button to the pane that fixes it; ‹ Home is the one way out',
          exits: ['Home'],
          primary: 'Open System Audio settings',
          shows: ['Test again'],
          hides: ['Later'],
        },
        openSetup(
          setupMac({
            systemAudio: {
              state: 'not-heard',
              // PermissionService.systemAudioCheck's words for a test that heard nothing.
              message: `Roger heard nothing: it is not allowed to record system audio, or this Mac is muted. Turn on Roger under ${SETTINGS_PANES.systemAudio.where} and turn the sound up, then press Test again.`,
              relaunchNeeded: false,
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    "Roger's server did not answer: Check again leads",
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-server',
          caption:
            "Roger's server is away: a failing check is shown even though it is not a permission",
          exits: ['Home'],
          primary: 'Check again',
          hides: ['Later'],
        },
        openSetup(
          setupMac({
            api: {
              state: 'failed',
              // main/setup/connectionChecks.ts: the words for a server that does not answer.
              ...describeServerFailure(new ApiError(0, 'unreachable', 'fetch failed')),
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a fix that needs a new process: Relaunch Roger is offered last',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-relaunch',
          caption:
            "The server refused this copy's access key: a fix only a new process reads, so Relaunch Roger is offered after Check again",
          exits: ['Home'],
          primary: 'Check again',
          shows: ['Relaunch Roger'],
          hides: ['Later'],
        },
        openSetup(
          setupMac({
            api: {
              state: 'failed',
              // The server turned this copy's access key down: only a new process reads a fixed one.
              ...describeServerFailure(new ApiError(401, 'unauthorized', 'unauthorized')),
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'everything passes: Done is the one primary, and it only goes Home',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-all-pass',
          caption: 'All checks pass: Done, and the passing rows folded into one line',
          exits: ['Done', 'Home'],
          primary: 'Done',
          shows: ['checks pass'],
          hides: ['Later'],
        },
        openSetup(setupMac()),
      );
    },
    PIECE_TIMEOUT_MS,
  );
});

// The prompt panel -------------------------------------------------------------------------------

/**
 * The panel on its stage: a 1440 x 900 screen with a menu bar strip and a call behind it, the panel
 * where main puts it (top right of the work area, 16 px in: promptBounds.ts). `theme` is the Mac's
 * appearance, which the panel's own page follows (it has no useTheme; main sets nativeTheme from
 * Appearance), and `backdrop` the call behind it: a dark Meet or a light Zoom. All four pairings
 * matter: the card's edge must read on a call of the other brightness, which is where the dark
 * card's edge was lost before the sweep (P5).
 */
const PROMPT_SCREEN = { width: 1440, height: 900 } as const;
const MENU_BAR_PX = 25;
const PANEL_MARGIN = 16;
const PANEL_WIDTH = 360;

type Backdrop = 'dark' | 'light';
const BACKDROPS: readonly Backdrop[] = ['dark', 'light'];

const openPrompt = (card: PromptScenarioId, theme: ForcedTheme, backdrop: Backdrop) =>
  run.openPrompt({ card, theme, backdrop, ...PROMPT_SCREEN });

/** What a card must show: its words, its one primary, the problem line it carries, if any. */
interface PromptCase {
  card: PromptScenarioId;
  caption: string;
  primary: string | null;
  shows: string[];
  problems?: string[];
  /** What a person does first (a click main refuses), before the card is checked. */
  act?: (page: Page) => Promise<void>;
}

const PROMPT_CASES: PromptCase[] = [
  {
    card: 'meeting-link',
    caption:
      'A meeting with a video link: "Roger · Starting in 1 min", the title, hours, Join and start notes as the one primary, Start notes a ghost, × to dismiss',
    primary: 'Join and start notes',
    shows: ['Roger', 'Starting in', 'Northwind renewal', '1 min', 'Start notes', 'Dismiss'],
  },
  {
    card: 'meeting-no-link',
    caption: 'No video link: Start notes is the one primary',
    primary: 'Start notes',
    shows: ['Design review', 'Dismiss'],
  },
  {
    card: 'meeting-blank-title',
    caption: 'An invite with no title reads "Meeting at ...", the title the meeting will get',
    primary: 'Start notes',
    shows: ['Meeting at'],
  },
  {
    card: 'two-meetings',
    caption: 'Two meetings starting together: Roger named once, one primary, a hairline between',
    primary: 'Join and start notes',
    shows: ['Daily standup', 'Northwind renewal'],
  },
  {
    card: 'two-cards',
    caption: 'Two cards in one column, the newest on top, one primary across both',
    primary: 'Start notes',
    shows: ['Quarterly review', 'Northwind renewal'],
  },
  {
    card: 'call-detected',
    caption: 'A call Roger noticed: an offer to take notes, not a privacy warning',
    primary: 'Start notes',
    shows: ['Zoom', 'Dismiss'],
  },
  {
    card: 'stops-other-note',
    caption: 'Another meeting is recording: one helper line says which notes this stops',
    primary: 'Join and start notes',
    shows: ['Stops notes on Weekly sync'],
  },
  {
    card: 'taking-notes',
    caption: 'After a start: "Recording" and the meeting it is for, Open Roger a ghost, no primary',
    primary: null,
    shows: ['Recording', 'Northwind renewal', 'Open Roger'],
  },
  {
    card: 'taking-notes-call',
    caption: 'After a start from a call Roger noticed: it names the call',
    primary: null,
    shows: ['Recording', 'Open Roger'],
  },
  {
    card: 'taking-notes-two',
    caption: 'After a start with two meetings on the card: it says which one started',
    primary: null,
    shows: ['Recording', 'Open Roger'],
  },
  {
    card: 'start-failed',
    caption:
      "The start failed: main's plain sentence between the hours and the buttons, the buttons still there",
    primary: 'Join and start notes',
    shows: ['Dismiss'],
    problems: ['Roger could not start notes from here. Try again.'],
  },
  {
    card: 'stop-failed',
    caption: 'Stopping the other meeting failed: what happened, then what to do',
    primary: 'Join and start notes',
    shows: ['Dismiss'],
    problems: [
      'Roger could not stop the notes on Weekly sync. Stop them in Roger, then try again.',
    ],
  },
  {
    card: 'read-failed',
    caption: 'The panel could not read main: one plain line on a card of its own, no IPC text',
    primary: null,
    shows: [],
    problems: ['Roger could not show this reminder.'],
  },
  {
    card: 'click-failed',
    caption: 'A click main refused: "Roger could not do that. Try again." on the card',
    primary: 'Join and start notes',
    shows: ['Dismiss'],
    problems: ['Roger could not do that. Try again.'],
    act: async (page) => {
      await page.getByRole('button', { name: 'Join and start notes' }).click();
      await page.getByText('Roger could not do that. Try again.').waitFor();
    },
  },
];

/**
 * The card sits where promptBounds puts it, 360 px wide, under the menu bar, 16 px from the right;
 * its primary and × are on top at their centres (a transparent window's stack must not cover its
 * own buttons); nothing scrolls inside it at this height.
 */
async function expectPanelInPlace(page: Page, spec: { primary: string | null }): Promise<void> {
  const problem = await page.evaluate(
    ({ screen, menuBar, margin, width, primary }) => {
      const stack = document.querySelector<HTMLElement>('.prompt-stack');
      if (stack === null) return 'no panel is drawn';
      const first = stack.querySelector<HTMLElement>('.prompt-card');
      if (first === null) return 'the panel has no card';
      const box = first.getBoundingClientRect();
      const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
      if (!close(box.right, screen - margin))
        return `the card ends at ${box.right}, not ${screen - margin}`;
      if (!close(box.top, menuBar + margin))
        return `the card starts at ${box.top}, not ${menuBar + margin}`;
      if (!close(box.width, width)) return `the card is ${box.width} px wide, not ${width}`;
      const hit = (element: HTMLElement | null, name: string): string | null => {
        if (element === null) return `no ${name}`;
        const at = element.getBoundingClientRect();
        const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
        return top !== null && element.contains(top) ? null : `${name} is covered`;
      };
      // Not every card has a ×: the "Recording" line and a read failure have none.
      const dismiss = stack.querySelector<HTMLElement>('button[aria-label="Dismiss"]');
      if (dismiss !== null) {
        const covered = hit(dismiss, 'the ×');
        if (covered !== null) return covered;
      }
      if (primary !== null) {
        const named = [...stack.querySelectorAll<HTMLElement>('button')].find(
          (button) => button.textContent.trim() === primary,
        );
        const covered = hit(named ?? null, `"${primary}"`);
        if (covered !== null) return covered;
      }
      if (stack.scrollHeight > stack.clientHeight + 1) return 'the stack scrolls inside itself';
      return null;
    },
    {
      screen: PROMPT_SCREEN.width,
      menuBar: MENU_BAR_PX,
      margin: PANEL_MARGIN,
      width: PANEL_WIDTH,
      primary: spec.primary,
    },
  );
  if (problem !== null) throw new Error(`prompt panel: ${problem}`);
}

describe('prompt', () => {
  for (const { card, caption, primary, shows, problems, act } of PROMPT_CASES) {
    it(
      `${card}: ${caption}`,
      async () => {
        for (const theme of qa.QA_THEMES) {
          for (const backdrop of BACKDROPS) {
            const preview = await openPrompt(card, theme, backdrop);
            const at = `${card} (${theme} Mac, ${backdrop} call)`;
            try {
              if (act !== undefined) await act(preview.page);
              await qa.settle(preview.page);
              const spec: Spec = {
                group: 'Prompt panel',
                slug: `prompt-${card}`,
                caption,
                primary,
                shows,
                hides: ['Copy notice', 'Take notes', 'Untitled meeting'],
                ...(problems === undefined ? {} : { problems }),
                prompt: true,
              };
              await checkView(preview, spec);
              await expectPanelInPlace(preview.page, spec);
              const height = await preview.page.evaluate(
                () => document.querySelector('.prompt-stack')?.getBoundingClientRect().bottom ?? 0,
              );
              const clipLeft = PROMPT_SCREEN.width - PANEL_WIDTH - PANEL_MARGIN - 32;
              await gallery.shootClip(
                preview.page,
                {
                  x: clipLeft,
                  y: 0,
                  width: PROMPT_SCREEN.width - clipLeft,
                  height: Math.ceil(height) + 32,
                },
                'Prompt panel',
                `prompt-${card}-${theme}-${backdrop}`,
                `${caption} (${theme} Mac, over a ${backdrop} call)`,
                'pass',
                `At its real place: 16 px from the right, under the menu bar. ${
                  primary === null ? 'No primary button.' : `One primary: ${primary}.`
                } No raw text, no console errors.`,
              );
            } catch (error) {
              throw new Error(`${at}: ${reasonOf(error)}`, { cause: error });
            } finally {
              await preview.close();
            }
          }
        }
      },
      PIECE_TIMEOUT_MS,
    );
  }

  it(
    'in place: the whole screen, the panel over a call, in both themes and over both calls',
    async () => {
      for (const theme of qa.QA_THEMES) {
        for (const backdrop of BACKDROPS) {
          const preview = await openPrompt('meeting-link', theme, backdrop);
          try {
            await qa.settle(preview.page);
            await expectPanelInPlace(preview.page, { primary: 'Join and start notes' });
            await gallery.shoot(
              preview.page,
              'Prompt panel in place',
              `prompt-frame-${theme}-${backdrop}`,
              `The panel over a ${backdrop} call on a ${theme} Mac: top right, under the menu bar, the card's edge readable on both`,
              'pass',
              "A 1440 x 900 screen as the preview stands in for it; the call behind is another app's pixels.",
            );
            qa.expectNoConsoleErrors(preview);
          } finally {
            await preview.close();
          }
        }
      }
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'the buttons do what they say: × dismisses, the primary starts the meeting named on the card',
    async () => {
      const preview = await openPrompt('meeting-link', 'light', 'dark');
      try {
        const { page } = preview;
        await page.getByRole('button', { name: 'Dismiss' }).click();
        await page.getByRole('button', { name: 'Join and start notes' }).click();
        await page.getByRole('button', { name: 'Start notes', exact: true }).click();
        const acts = await page.evaluate(() => window.__rogerPromptPreview?.acts ?? []);
        const kinds = acts.map((act) => act.action).join(',');
        if (kinds !== 'dismiss,join_and_take_notes,take_notes') {
          throw new Error(`the panel sent [${kinds}], not a dismiss, a join and a start`);
        }
        qa.expectNoConsoleErrors(preview);
      } finally {
        await preview.close();
      }
    },
    PIECE_TIMEOUT_MS,
  );
});

// The API is away, or refuses ---------------------------------------------------------------------

/** What My notes held when the server turned its upload down. */
function myNote(sync: LocalNote['sync']): LocalNote {
  return {
    meetingId: PAST_ID,
    kind: 'user',
    doc: {
      type: 'doc',
      content: MY_NOTES_TEXT.map((line) => ({ type: 'paragraph', content: [words(line)] })),
    },
    revisionId: randomUUID(),
    dirty: true,
    baseVersion: 0,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    conflictCopy: null,
    sync,
    updatedAt: new Date().toISOString(),
  };
}

/** The standup under the api-offline scenario: its lines wait to upload, the server is away. */
const offlineMeeting = async (combo: Combo): Promise<qa.PreviewPage> => {
  const preview = await openScenario('api-offline')(combo);
  await openEarlier(preview.page, /Daily standup/);
  return preview;
};

describe('offline', () => {
  it(
    'the server is away: Home stays calm and Start notes still works',
    async () => {
      await inEveryView(
        {
          group: 'Server away or refusing',
          slug: 'offline-home',
          caption:
            'Roger’s server is away: Home is unchanged, because nothing is lost (lines wait on this Mac)',
          primary: 'Start notes',
        },
        openScenario('api-offline'),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'lines the server refused for good: a line under the meeting header',
    async () => {
      await inEveryView(
        {
          group: 'Server away or refusing',
          slug: 'offline-refused-lines',
          caption:
            'The server refused 3 lines for good: said under the header, with where they stay',
          primary: 'Stop',
          problems: ["Roger's server refused 3 lines for good", 'They stay saved on this Mac only'],
        },
        liveMeeting,
        ({ page }) =>
          patchStatus(page, {
            upload: { state: 'idle', rejected: 3, lastError: 'validation_error' },
          }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'lines the server refused for good, on Home: the banner says it',
    async () => {
      await inEveryView(
        {
          group: 'Server away or refusing',
          slug: 'offline-refused-lines-home',
          caption:
            'The server refused 3 lines for good and the person is on Home: the banner says so, with where they stay',
          primary: 'Start notes',
          problems: ["Roger's server refused 3 lines for good", 'They stay saved on this Mac only'],
        },
        openScenario('empty-mac'),
        ({ page }) =>
          patchStatus(page, {
            upload: { state: 'idle', rejected: 3, lastError: 'validation_error' },
          }),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'lines the server refused for good, in Settings: the banner says it there too',
    async () => {
      await inEveryView(
        {
          group: 'Server away or refusing',
          slug: 'offline-refused-lines-settings',
          caption: 'The same line above Settings: a person who left Home is still told',
          primary: 'Connect Google Calendar',
          problems: ["Roger's server refused 3 lines for good"],
        },
        openScenario('empty-mac'),
        async ({ page }) => {
          await goToSettings(page);
          await patchStatus(page, {
            upload: { state: 'idle', rejected: 3, lastError: 'validation_error' },
          });
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'Details after Stop while the server is away: what waits to upload, in plain words',
    async () => {
      await inEveryView(
        {
          group: 'Server away or refusing',
          slug: 'offline-details',
          caption:
            'Stopped with the server away: Details says how many lines wait to upload, and that it retries',
          primary: null,
          shows: ["Roger's server", '212 lines waiting'],
        },
        liveMeeting,
        async ({ page }) => {
          await patchStatus(page, {
            upload: {
              state: 'backoff',
              pending: 212,
              lastError: 'connect ECONNREFUSED 127.0.0.1:8000',
              nextAttemptAt: Date.now() + 30_000,
            },
          });
          await page.getByRole('button', { name: 'Stop' }).click();
          await page.getByRole('button', { name: 'Write notes' }).waitFor();
          await page.getByRole('button', { name: 'Details' }).click();
          await page.waitForSelector('dialog[open] .dialog-panel');
          await qa.settle(page);
        },
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'notes the server refused, and notes saved here while it is away',
    async () => {
      await walkEveryView(offlineMeeting, async ({ page }, _combo, shoot) => {
        await qa.emitEvent(page, notesChannels.NotesChanged, myNote('offline'));
        await qa.settle(page);
        await shoot({
          group: 'Server away or refusing',
          slug: 'offline-note-saved-here',
          caption: 'My notes while the server is away: "Saved on this Mac", quiet, nothing to do',
          primary: 'Write notes',
          shows: ['Saved on this Mac', 'Priyanka: uploader retries done'],
        });
        await qa.emitEvent(page, notesChannels.NotesChanged, myNote('refused'));
        await qa.settle(page);
        await shoot({
          group: 'Server away or refusing',
          slug: 'offline-note-refused',
          caption: 'My notes the server refused: "Not saved to Roger", the notes kept on screen',
          primary: 'Write notes',
          problems: ['Not saved to Roger'],
          shows: ['Priyanka: uploader retries done'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a note save that fails on this Mac: Not saved, in words',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await qa.failNextRequest(page, 'the notes file is read-only');
        await page.locator('section[aria-label="My notes"] .note-editor-content').click();
        await page.keyboard.type('Ask Anneliese for the seat export');
        await page.getByText('Not saved.').waitFor();
        await qa.settle(page);
        await shoot({
          group: 'Server away or refusing',
          slug: 'offline-note-not-saved',
          caption: 'The save on this Mac failed: "Not saved" and why, the typed text still there',
          primary: 'Write notes',
          problems: ['Not saved'],
          shows: ['Ask Anneliese for the seat export'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'Write notes that could not start says why, with Dismiss',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await qa.failNextRequest(
          page,
          'POST /v1/meetings/x/notes/generate failed: connect ECONNREFUSED 127.0.0.1:8000',
          'ApiError',
        );
        await page.getByRole('button', { name: 'Write notes' }).click();
        await page.waitForSelector('.meeting-problem');
        await qa.settle(page);
        await shoot({
          group: 'Server away or refusing',
          slug: 'offline-write-failed',
          caption:
            'Write notes could not start: a line with the reason and Dismiss, Write notes still offered',
          primary: 'Write notes',
          problems: [
            'Roger could not start writing the notes: Roger could not reach its server.',
            'Dismiss',
          ],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Navigation: Back, Escape, what main's Cmd+[ sends, focus on arrival --------------------------------

/** Behaviours, not looks: one theme is enough, at both widths. */
const LIGHT_COMBOS: Combo[] = qa.QA_WIDTHS.map((width) => ({ theme: 'light', width }));

async function eachWidth(
  open: (combo: Combo) => Promise<qa.PreviewPage>,
  body: (preview: qa.PreviewPage, combo: Combo) => Promise<void>,
): Promise<void> {
  for (const combo of LIGHT_COMBOS) {
    const preview = await open(combo);
    try {
      await body(preview, combo);
      qa.expectNoConsoleErrors(preview);
    } catch (error) {
      throw new Error(`(${combo.theme}, ${combo.width}): ${reasonOf(error)}`, { cause: error });
    } finally {
      await preview.close();
    }
  }
}

/**
 * The page has just been arrived at (R11, V5): focus is on its h1 and the window is titled for it.
 * Focus waits on the page's own observer, so this polls instead of reading once.
 */
async function expectArrival(page: Page, heading: string, title: string): Promise<void> {
  await page
    .waitForFunction(
      (expected) =>
        document.activeElement?.tagName === 'H1' &&
        document.activeElement.textContent.trim() === expected.heading &&
        document.title === expected.title,
      { heading, title },
      { timeout: 3000 },
    )
    .catch(async (error: unknown) => {
      const seen = await page.evaluate(() => ({
        focus: `${document.activeElement?.tagName}: ${document.activeElement?.textContent.trim()}`,
        title: document.title,
      }));
      throw new Error(
        `arrival at ${heading}: focus is on ${seen.focus}, the window is titled "${seen.title}" (wanted the h1 and "${title}")`,
        { cause: error },
      );
    });
  await qa.settle(page);
}

/** What a click on the header's "Home" does: Home, with focus on its h1, in one step. */
async function backHome(page: Page, heading = 'Home'): Promise<void> {
  await page.locator('.app-header .app-back').click();
  await expectArrival(page, heading, 'Roger');
  if ((await page.locator('.app-header .app-back').count()) !== 0) {
    throw new Error('Home still has a "Home" button');
  }
}

/** The current page's h1 text, for "Escape left it" and "Escape stayed". */
const headingNow = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector('h1')?.textContent.trim() ?? '');

describe('nav', () => {
  it(
    'every page but Home has "Home", it goes Home, and focus lands on the next page\'s h1',
    async () => {
      await eachWidth(openScenario('past-meeting'), async ({ page }) => {
        await expectHeader(page);

        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await expectHeader(page);
        await backHome(page);

        await openEarlier(page, /Daily standup/);
        await expectArrival(page, 'Daily standup', 'Daily standup');
        await expectHeader(page);
        await backHome(page);

        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await page.getByRole('button', { name: 'Open Set up Roger' }).click();
        await expectArrival(page, 'Set up Roger', 'Set up Roger');
        await expectHeader(page);
        await backHome(page);
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'Escape goes back from Settings and Set up Roger, and never leaves a meeting or a field',
    async () => {
      await eachWidth(openScenario('past-meeting'), async ({ page }) => {
        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await page.keyboard.press('Escape');
        await expectArrival(page, 'Home', 'Roger');

        await page.evaluate(() => {
          window.location.hash = '#/setup';
        });
        await expectArrival(page, 'Set up Roger', 'Set up Roger');
        await page.keyboard.press('Escape');
        await expectArrival(page, 'Home', 'Roger');

        // A text field keeps its Escape: leaving mid-word would lose the term being typed.
        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await page.getByPlaceholder(/Add names/).fill('Anneliese');
        await page.keyboard.press('Escape');
        if ((await headingNow(page)) !== 'Settings')
          throw new Error('Escape in a field left Settings');
        const kept = await page.getByPlaceholder(/Add names/).inputValue();
        if (kept !== 'Anneliese') throw new Error(`the typed term became "${kept}"`);
        await page.keyboard.press('Tab');
        await backHome(page);

        // The meeting page is not left by Escape: it would drop the person out of their notes.
        await openEarlier(page, /Daily standup/);
        await expectArrival(page, 'Daily standup', 'Daily standup');
        await page.keyboard.press('Escape');
        await qa.settle(page);
        if ((await headingNow(page)) !== 'Daily standup')
          throw new Error('Escape left the meeting');
        await page.locator('section[aria-label="My notes"] .note-editor-content').click();
        await page.keyboard.press('Escape');
        await qa.settle(page);
        if ((await headingNow(page)) !== 'Daily standup') {
          throw new Error('Escape in My notes left the meeting');
        }
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    "Cmd+[ is main's Go > Home: what it sends takes any page to Home",
    async () => {
      // The accelerator is a native menu item (main/appMenu.ts, pinned by appMenu.test.ts): the
      // page never sees the key. Main answers it with app:navigate 'home', which is what is sent.
      await eachWidth(openScenario('past-meeting'), async ({ page }) => {
        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await qa.emitEvent(page, appChannels.AppNavigate, 'home');
        await expectArrival(page, 'Home', 'Roger');

        await openEarlier(page, /Daily standup/);
        await expectArrival(page, 'Daily standup', 'Daily standup');
        await qa.emitEvent(page, appChannels.AppNavigate, 'home');
        await expectArrival(page, 'Home', 'Roger');

        await qa.emitEvent(page, appChannels.AppNavigate, 'setup');
        await expectArrival(page, 'Set up Roger', 'Set up Roger');
        await qa.emitEvent(page, appChannels.AppNavigate, 'home');
        await expectArrival(page, 'Home', 'Roger');
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'while a call records, the header chip is the way to it from every other page',
    async () => {
      await walkEveryView(openScenario('live-call'), async ({ page }, _combo, shoot) => {
        await page.getByRole('button', { name: 'Settings' }).click();
        await expectArrival(page, 'Settings', 'Settings');
        await shoot({
          group: 'Navigation',
          slug: 'nav-settings-recording',
          caption:
            'Settings while a call records: ‹ Home on the left, the Recording chip and the current gear on the right',
          primary: 'Connect Google Calendar',
          shows: ['Home', 'Recording'],
        });
        await page.locator('.recording-chip').click();
        await expectArrival(page, LIVE_CALL.title, LIVE_CALL.title);
        if ((await page.locator('.app-header .recording-chip').count()) !== 0) {
          throw new Error("the chip is on the meeting's own page, where it opens nothing");
        }
        await shoot({
          group: 'Navigation',
          slug: 'nav-live-meeting',
          caption:
            "The live meeting's own page: ‹ Home on the left, no chip (it would open this page), Stop the one primary",
          primary: 'Stop',
          shows: ['Home'],
        });
        // While a call records Home's h1 is the live meeting's title (the hero, HomePage.tsx).
        await backHome(page, LIVE_CALL.title);
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Appearance --------------------------------------------------------------------------------------

/** The window's canvas colour: what the whole page is drawn on. */
const canvasOf = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

describe('appearance', () => {
  it(
    'System, Light and Dark switch this window at once, and the choice is saved',
    async () => {
      for (const width of qa.QA_WIDTHS) {
        for (const start of qa.QA_THEMES) {
          const other = start === 'light' ? 'dark' : 'light';
          const preview = await openScenario('empty-mac')({ theme: start, width });
          const { page } = preview;
          try {
            await goToSettings(page);
            const before = await canvasOf(page);
            const radio = (name: string) => page.getByRole('radio', { name });
            const chosen = (name: string): Promise<string | null> =>
              radio(name).getAttribute('aria-checked');

            // The other look, from the click to the drawn page in one frame: no waiting on main.
            // Main's answer is the PrefsChanged it sends once it has saved (the preview's
            // getPreferences always reports the forced theme, so it cannot be read back).
            const option = other === 'dark' ? 'Dark' : 'Light';
            const announced = page.evaluate(
              () =>
                new Promise<string>((resolve) => {
                  const stop = window.roger.onPreferenceChanged((change) => {
                    if (change.key !== 'theme') return;
                    stop();
                    resolve(change.value);
                  });
                }),
            );
            await radio(option).click();
            await page.waitForFunction(
              (theme) => document.documentElement.dataset.theme === theme,
              other,
              { timeout: 1000 },
            );
            const after = await canvasOf(page);
            if (after === before) throw new Error(`choosing ${option} left the canvas ${before}`);
            if ((await chosen(option)) !== 'true') throw new Error(`${option} is not checked`);
            if ((await announced) !== other)
              throw new Error(`main saved a look other than ${other}`);
            await qa.settle(page);
            await expectHeader(page);
            await expectNoInternals(page);
            await gallery.shoot(
              page,
              'Appearance',
              `appearance-${option.toLowerCase()}-from-${start}-${width}`,
              `${option} chosen in a ${start} window: the page switched at once, ${option} checked, nothing to save or confirm`,
              'pass',
              `Canvas ${before} became ${after}, with no wait on main. ${width} px wide.`,
            );

            // System goes back to what the Mac says, the forced scheme of this page.
            await radio('System').click();
            await page.waitForFunction(
              () => !document.documentElement.hasAttribute('data-theme'),
              undefined,
              { timeout: 1000 },
            );
            const system = await canvasOf(page);
            if (system !== before) {
              throw new Error(`System left the canvas ${system}, the Mac's own is ${before}`);
            }
            if ((await chosen('System')) !== 'true') throw new Error('System is not checked');
            qa.expectNoConsoleErrors(preview);
          } finally {
            await preview.close();
          }
        }
      }
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'arrow keys move between the looks and choose as they go',
    async () => {
      // The page opens on Light (the forced theme is the stored preference): Right is Dark.
      await eachWidth(openScenario('empty-mac'), async ({ page }) => {
        await goToSettings(page);
        const theme = (): Promise<string | undefined> =>
          page.evaluate(() => document.documentElement.dataset.theme);
        await page.getByRole('radio', { name: 'Light' }).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === 'dark',
          undefined,
          { timeout: 1000 },
        );
        const onDark = await page.evaluate(() => document.activeElement?.textContent.trim());
        if (onDark !== 'Dark') throw new Error(`focus is on "${onDark}" after Right`);
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(
          () => !document.documentElement.hasAttribute('data-theme'),
          undefined,
          { timeout: 1000 },
        );
        const onSystem = await page.evaluate(() => document.activeElement?.textContent.trim());
        if (onSystem !== 'System' || (await theme()) !== undefined) {
          throw new Error(
            `after Left, Left focus is on "${onSystem}" and the theme is ${String(await theme())}`,
          );
        }
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a look that could not be saved goes back and says why',
    async () => {
      await walkEveryView(openScenario('empty-mac'), async ({ page }, { theme }, shoot) => {
        await goToSettings(page);
        const before = await canvasOf(page);
        await qa.failNextRequest(page, 'the preferences file is read-only');
        await page.getByRole('radio', { name: theme === 'light' ? 'Dark' : 'Light' }).click();
        await page.getByText('Roger could not save the look').waitFor();
        await qa.settle(page);
        if ((await canvasOf(page)) !== before)
          throw new Error('the look stayed switched after a refusal');
        await shoot({
          group: 'Appearance',
          slug: 'appearance-save-failed',
          caption:
            'Main refused to save the look: the page went back to what it was and says why, in words',
          primary: 'Connect Google Calendar',
          problems: ['Roger could not save the look'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Focus: no box around the transcript, the chat or My notes (R13) -------------------------------------

interface FocusLook {
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
  border: string;
  focusVisible: boolean;
  focused: boolean;
}

/** How `selector` is drawn now, for the "no box" rule. */
function focusLook(page: Page, selector: string): Promise<FocusLook> {
  return page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (element === null) throw new Error(`no ${target}`);
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      border: `${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth} ${style.borderTopColor} ${style.borderRightColor} ${style.borderBottomColor} ${style.borderLeftColor}`,
      focusVisible: element.matches(':focus-visible'),
      focused: element === document.activeElement || element.contains(document.activeElement),
    };
  }, selector);
}

/** The 2 px --ring line along the left edge: an inset shadow with one offset and no blur. */
const LEFT_EDGE_LINE =
  /^(?:rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|\S+) 2px 0px 0px 0px inset$/;

/**
 * No box: no outline, no border that changed, and a shadow only if it is the 2 px line at the left
 * edge (keyboard focus, docs/design.md Focus). `before` is the look before focus: a border may not
 * change colour or width when focus arrives.
 */
function expectNoFocusBox(selector: string, now: FocusLook, before: FocusLook | null): void {
  if (now.outlineStyle !== 'none' && now.outlineWidth !== '0px') {
    throw new Error(`${selector} has an outline (${now.outlineStyle} ${now.outlineWidth})`);
  }
  if (now.boxShadow !== 'none' && !LEFT_EDGE_LINE.test(now.boxShadow)) {
    throw new Error(
      `${selector} has a box shadow that is not the left-edge line: ${now.boxShadow}`,
    );
  }
  if (before !== null && now.border !== before.border) {
    throw new Error(`${selector}'s border changed on focus: ${before.border} to ${now.border}`);
  }
}

/** The active element sits inside `selector` (the focus really is in that region). */
async function expectFocusIn(page: Page, selector: string): Promise<void> {
  const inside = await page.evaluate(
    (target) => document.querySelector(target)?.contains(document.activeElement) ?? false,
    selector,
  );
  if (!inside) throw new Error(`focus is not in ${selector}`);
}

const TRANSCRIPT_LOG = '.live-transcript-lines';
const CHAT_LOG = '.meeting-chat-log';
const NOTES_BOX = 'section[aria-label="My notes"] .note-editor-content';

describe('focus', () => {
  it(
    'the transcript: by a click, by Jump to live, by a citation, then a key: no box, ever',
    async () => {
      await walkEveryView(liveMeeting, async ({ page }, _combo, shoot) => {
        await pickTab(page, 'Transcript');
        await page.waitForSelector(`${TRANSCRIPT_LOG} [data-segment-id]`);
        const before = await focusLook(page, TRANSCRIPT_LOG);

        // By a click on a line, then a key.
        await page.locator(`${TRANSCRIPT_LOG} [data-segment-id]`).last().click();
        await page.keyboard.press('ArrowUp');
        await expectFocusIn(page, TRANSCRIPT_LOG);
        expectNoFocusBox(TRANSCRIPT_LOG, await focusLook(page, TRANSCRIPT_LOG), before);

        // By Jump to live: scroll away so the button comes, press it, then a key.
        await page.evaluate((log) => {
          const element = document.querySelector(log);
          if (element !== null) element.scrollTop = 0;
        }, TRANSCRIPT_LOG);
        await page.getByRole('button', { name: 'Jump to live' }).click();
        await page.keyboard.press('ArrowUp');
        await expectFocusIn(page, TRANSCRIPT_LOG);
        expectNoFocusBox(TRANSCRIPT_LOG, await focusLook(page, TRANSCRIPT_LOG), before);
        await qa.stopScenario(page);
        await shoot({
          group: 'Focus',
          slug: 'focus-transcript-clicked',
          caption:
            'Focus in the transcript after Jump to live and a key: no outline, no orange frame, no border change',
          primary: 'Stop',
        });

        // By the keyboard: a 2 px line at the left edge, and still no box.
        await page.getByRole('tab', { name: 'Chat' }).focus();
        await page.getByRole('tab', { name: 'Transcript' }).focus();
        for (let step = 0; step < 12; step += 1) {
          await page.keyboard.press('Tab');
          if (
            await page.evaluate(
              (log) => document.querySelector(log) === document.activeElement,
              TRANSCRIPT_LOG,
            )
          )
            break;
        }
        const keyboard = await focusLook(page, TRANSCRIPT_LOG);
        if (!keyboard.focusVisible || keyboard.boxShadow === 'none') {
          throw new Error(
            `Tab reached no focusable transcript with a left-edge line (visible ${String(keyboard.focusVisible)}, shadow ${keyboard.boxShadow})`,
          );
        }
        expectNoFocusBox(TRANSCRIPT_LOG, keyboard, before);
        await shoot({
          group: 'Focus',
          slug: 'focus-transcript-keyboard',
          caption: 'Keyboard focus in the transcript: a 2 px line at the left edge, no box',
          primary: 'Stop',
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a citation puts focus in the transcript with no box; the chat log and My notes are as quiet',
    async () => {
      await walkEveryView(pastMeeting, async ({ page }, _combo, shoot) => {
        await page.getByRole('button', { name: 'Write notes' }).click();
        await page.waitForSelector(AI_PANE);
        await finishWritingNotes(page);

        // A chip reveals its transcript line and puts focus in the log: then a key.
        await page.locator('.ai-notes-editor .citation-chip').first().click();
        await page.waitForSelector('[data-cited]');
        await page.keyboard.press('ArrowDown');
        await expectFocusIn(page, TRANSCRIPT_LOG);
        expectNoFocusBox(TRANSCRIPT_LOG, await focusLook(page, TRANSCRIPT_LOG), null);
        await shoot({
          group: 'Focus',
          slug: 'focus-transcript-citation',
          caption:
            'Focus after a citation chip and a key: the cited line tinted, the log with no outline or frame',
          primary: null,
        });

        // The chat log: a click, then a key.
        await pickTab(page, 'Chat');
        const first = await askInChat(page, 'Who owns the seat list?');
        await answerInChat(page, first, 'Anneliese owns the seat export [L22].', [22]);
        const chatBefore = await focusLook(page, CHAT_LOG);
        await page.locator('.meeting-chat-answer').first().click();
        await page.keyboard.press('PageUp');
        expectNoFocusBox(CHAT_LOG, await focusLook(page, CHAT_LOG), chatBefore);
        await shoot({
          group: 'Focus',
          slug: 'focus-chat-clicked',
          caption: 'Focus in the chat log after a click and a key: no outline, no frame',
          primary: null,
        });

        // My notes: typing shows the caret and nothing else.
        await pickTab(page, 'My notes');
        const notesBefore = await focusLook(page, NOTES_BOX);
        await page.locator(NOTES_BOX).click();
        await page.keyboard.type('Ask Anneliese');
        expectNoFocusBox(NOTES_BOX, await focusLook(page, NOTES_BOX), notesBefore);
        const now = await focusLook(page, NOTES_BOX);
        if (now.boxShadow !== 'none') {
          throw new Error(`My notes draws a shadow while typing: ${now.boxShadow}`);
        }
        await shoot({
          group: 'Focus',
          slug: 'focus-my-notes-typing',
          caption: 'Typing in My notes: the caret only, the box keeps its own border',
          primary: null,
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});

// Main's words, whatever fails -------------------------------------------------------------------------

/** Every sentence a failed Start can show: START_FAILURE_SENTENCES, as the banner draws them. */
const START_SENTENCES = Object.entries(START_FAILURE_SENTENCES);

describe('words', () => {
  it(
    'every failed Start reads as a plain sentence, and its raw text stays in Details',
    async () => {
      await walkEveryView(openScenario('empty-mac'), async ({ page }, _combo, shoot) => {
        for (const [name, sentence] of START_SENTENCES) {
          await patchStatus(page, { error: sentence, errorDetail: 'xAI: rejected with HTTP 401' });
          try {
            await expectProblem(page, sentence);
            await expectNoInternals(page);
          } catch (error) {
            throw new Error(`START_FAILURE_SENTENCES.${name}: ${reasonOf(error)}`, {
              cause: error,
            });
          }
        }
        await patchStatus(page, {
          error: START_FAILURE_SENTENCES.serviceRefused,
          errorDetail: 'xAI: rejected with HTTP 401',
        });
        await shoot({
          group: "Main's words",
          slug: 'words-start-refused',
          caption:
            "Start failed because the speech service refused: main's sentence and what to do, no vendor, no HTTP code",
          primary: 'Start notes',
          problems: [START_FAILURE_SENTENCES.serviceRefused],
        });
        await patchStatus(page, {
          error: START_FAILURE_SENTENCES.serverAway,
          errorDetail: 'POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000',
        });
        await shoot({
          group: "Main's words",
          slug: 'words-start-server-away',
          caption: "Start failed because Roger's server is away: no route, no address, no errno",
          primary: 'Start notes',
          problems: [START_FAILURE_SENTENCES.serverAway],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'every warning main raises, as the banner and the status line read it',
    async () => {
      const facts = {
        micSilent: { mic: { silentForMs: MIC_DEAD_WARNING_MS } },
        micNoChunks: { mic: { noChunkForMs: 6_000 } },
        micEnded: { mic: { stopped: { message: 'AbortError: Starting audio source failed' } } },
        callNoChunks: { system: { noChunkForMs: 6_000 } },
        callEnded: { system: { stopped: { message: 'spawn EACCES' } } },
        callSilent: { system: { silentForMs: CALL_AUDIO_SILENT_LOUD_MS } },
        offline: { offline: true },
      };
      const warnings = Object.entries(facts).flatMap(([name, change]) =>
        warningsFor(change).map((warning) => ({ name, warning })),
      );
      if (warnings.length < 7) throw new Error(`main raised only ${warnings.length} warnings`);
      for (const combo of LIGHT_COMBOS) {
        const preview = await liveMeeting(combo);
        try {
          for (const { name, warning } of warnings) {
            await patchStatus(preview.page, { warnings: [warning] });
            try {
              await expectNoInternals(preview.page);
              if (warning.loud) await expectProblem(preview.page, warning.message.slice(0, 40));
            } catch (error) {
              throw new Error(`${name} (${warning.kind}): ${reasonOf(error)}`, { cause: error });
            }
          }
          qa.expectNoConsoleErrors(preview);
        } finally {
          await preview.close();
        }
      }
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'every stop notice reads as a sentence, on Home after Roger stopped a call itself',
    async () => {
      const guards = { noSpeechStopMs: 900_000, maxRecordingMs: 14_400_000 };
      const reasons = [
        'no-speech',
        'max-duration',
        'renderer-gone',
        'system-sleep',
        'call-ended',
      ] as const;
      await walkEveryView(openScenario('empty-mac'), async ({ page }, _combo, shoot) => {
        for (const reason of reasons) {
          const notice = stopNotice(reason, new Date(), guards, 'Zoom');
          if (notice === null) throw new Error(`${reason} leaves no notice`);
          await patchStatus(page, { notice });
          await expectProblem(page, notice);
          await expectNoInternals(page);
        }
        const notice = stopNotice('call-ended', new Date(), guards, 'Zoom');
        await patchStatus(page, { notice });
        await shoot({
          group: "Main's words",
          slug: 'words-stop-notice',
          caption:
            "Roger stopped because the call ended: one quiet line above Home, in main's words",
          primary: 'Start notes',
          problems: [notice ?? ''],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    "Details is the one place raw text may show: the vendor's own reason, on the meeting page",
    async () => {
      await walkEveryView(liveMeeting, async ({ page }, _combo, shoot) => {
        await patchStatus(page, {
          error: START_FAILURE_SENTENCES.serviceRefused,
          errorDetail: 'xAI: rejected with HTTP 401',
        });
        await expectNoInternals(page);
        await page.getByRole('button', { name: 'Details' }).click();
        await page.waitForSelector('dialog[open] .dialog-panel');
        await qa.settle(page);
        await shoot({
          group: "Main's words",
          slug: 'words-details-raw',
          caption:
            'Details shows the raw reason ("xAI: rejected with HTTP 401") that the banner behind it never does',
          primary: null,
          shows: ['xAI: rejected with HTTP 401'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});
