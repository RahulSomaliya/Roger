import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import { previewCalendarDay } from '../preview/fakes/calendar';
import { LIVE_CALL, PAST_MEETING, segmentIdForLine } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { CalendarEvent } from '../src/shared/calendar';
import type {
  CaptureReport,
  CaptureStatus,
  CaptureWarning,
  UploadStatus,
} from '../src/shared/capture';
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
 * The redesign's QA (docs/plans/redesign.md, R10): every screen in its states, in both themes at
 * 1440 and 390 wide, on the browser preview (qa/README.md). It replaces the per-milestone QA
 * scripts, which selected classes the redesign deleted.
 *
 * Every shot is first checked, because a screenshot of a wrong screen is still a screenshot:
 *  - at most ONE visible primary button, and it is the one docs/design.md names for that moment
 *    (the table "The one primary, per screen and moment"). Found by its variant AND by its
 *    computed background, so an accent-filled control that skipped `.btn` is still counted;
 *    `document.elementFromPoint` at its centre must be the button, so nothing covers it;
 *  - every problem line the state has is on screen: a person can see it, not just the DOM;
 *  - no sideways page scroll, no console error, and no running animation (nothing pulses).
 *
 * Run it in pieces (a 10-minute stall limit kills one long call):
 *   pnpm exec vitest run --config vitest.e2e.config.ts e2e/redesign.qa.e2e.ts -t "^home"
 * The pieces are `home`, `live`, `past`, `chat`, `settings`, `setup`, `prompt` and `offline`. Each
 * adds its shots to one gallery folder (ROGER_QA_OUT); clear it before a full run.
 */

const PIECE_TIMEOUT_MS = 240_000;

let run: qa.QaRun;
const gallery = new qa.Gallery('Roger redesign: Course Player style', 'redesign');
beforeAll(async () => {
  run = await qa.startQa();
});
afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'rd/r10', Date: '2026-10-07' });
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
      const busy = element.getAttribute('aria-disabled') === 'true';
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
  patch: Partial<Pick<CaptureStatus, 'phase' | 'error' | 'notice'>> & {
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

const NO_CALL_AUDIO: CaptureWarning = {
  kind: 'call-audio-silent',
  source: 'system',
  since: minutesAgo(2),
  message: "Roger can't hear the call. Check the call plays on this Mac.",
  loud: true,
};

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
        async ({ page }) => {
          await connectCalendar(page);
          await qa.emitEvent(page, calendarChannels.CalendarEventsChanged, dayInTheNextHalfHour());
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
          problems: ["Roger can't hear the call"],
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

// The live meeting -------------------------------------------------------------------------------

/** Opens the recording meeting from Home. */
const liveMeeting = async (combo: Combo): Promise<qa.PreviewPage> => {
  const preview = await openScenario('live-call')(combo);
  await openLive(preview.page);
  return preview;
};

const NO_MIC_AUDIO: CaptureWarning = {
  kind: 'mic-dead',
  source: 'mic',
  since: minutesAgo(1),
  message: "Roger can't hear your microphone. Check it is not muted.",
  loud: true,
};

/** Quiet: on screen only in Details, never in the status line (docs/plans/redesign.md). */
const KEYTERMS_REFUSED: CaptureWarning = {
  kind: 'keyterms-rejected',
  source: 'system',
  since: minutesAgo(30),
  message: 'The speech service did not take the jargon list, so this call runs without it.',
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
          problems: ['Roger could not save this call on this Mac'],
        },
        liveMeeting,
        ({ page }) =>
          patchStatus(page, {
            error:
              'Roger could not save this call on this Mac: the disk is full. Free some space; Roger keeps trying.',
          }),
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
          shows: ['My notes', 'Transcript', 'Chat', 'Details'],
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
          caption: 'The ⋯ menu: Write again as each template; used rarely, so not on the page',
          primary: null,
          shows: ['Write again as General', 'Write again as Standup'],
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
            'Nothing connected: the jargon list, and Connect Google Calendar as the one primary',
          primary: 'Connect Google Calendar',
          shows: ['Jargon list', 'Calendar'],
          hides: ['Save', 'Notes'],
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
            'Connected: account, Remind me, the notice and its text, Open at login; no Save, no counters',
          primary: null,
          shows: ['Connected as you@example.com', 'Notice text', 'Open Roger at login'],
          hides: ['Save notice', 'of 100 terms'],
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
          problems: ['Not saved'],
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
    'a first run: Allow microphone leads, Later is a quiet way out',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-first-run',
          caption:
            'Microphone not asked yet: its fix is the one primary; the passing rows are one line',
          primary: 'Allow microphone',
          shows: ['Later', 'checks pass'],
          hides: ['Done'],
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
          primary: 'Open Microphone settings',
          shows: ['Microphone access is off for Roger', 'Later'],
        },
        openSetup(
          setupMac({
            microphone: {
              state: 'denied',
              message:
                'Microphone access is off for Roger. Turn it on under System Settings → Privacy & Security → Microphone.',
              relaunchNeeded: false,
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
            'The call audio test heard nothing: why, the button to the pane that fixes it, Later stays',
          primary: 'Open System Audio settings',
          shows: ['Later', 'Test again'],
        },
        openSetup(
          setupMac({
            systemAudio: {
              state: 'not-heard',
              message:
                'Roger heard no call audio during the test. Play a video or join a call, then test again.',
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
          primary: 'Check again',
          shows: ['Later'],
        },
        openSetup(
          setupMac({
            api: {
              state: 'failed',
              message: "Roger's server did not answer. Check the connection, then check again.",
              relaunchNeeded: false,
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'a permission that needs a new process: Relaunch Roger',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-relaunch',
          caption:
            'macOS applies the new setting on the next launch: Relaunch Roger is the primary',
          primary: 'Relaunch Roger',
          shows: ['Later'],
        },
        openSetup(
          setupMac({
            microphone: {
              state: 'granted',
              message:
                'Microphone was allowed after Roger started. macOS applies it after a relaunch.',
              relaunchNeeded: true,
            },
          }),
        ),
      );
    },
    PIECE_TIMEOUT_MS,
  );

  it(
    'everything passes: Done is the one primary, Later is gone',
    async () => {
      await inEveryView(
        {
          group: 'Set up Roger',
          slug: 'setup-all-pass',
          caption: 'All checks pass: Done, and the passing rows folded into one line',
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

/** The panel's own page, on one card: it has no shell, so its states are `?card=` values. */
const promptCard =
  (card: PromptScenarioId) =>
  ({ theme, width }: Combo): Promise<qa.PreviewPage> =>
    // One card is short: a window the height of the panel, not of a laptop.
    run.openPrompt({ card, theme, width, height: 420 });

describe('prompt', () => {
  const cases: {
    card: PromptScenarioId;
    caption: string;
    primary: string | null;
    shows: string[];
    problems?: string[];
  }[] = [
    {
      card: 'meeting-link',
      caption:
        'A meeting with a video link: Join and start notes is the one primary, Start notes and Dismiss ghosts',
      primary: 'Join and start notes',
      shows: ['Starting in', 'Start notes', 'Dismiss'],
    },
    {
      card: 'meeting-no-link',
      caption: 'No video link: Start notes is the one primary',
      primary: 'Start notes',
      shows: ['Design review', 'Dismiss'],
    },
    {
      card: 'two-meetings',
      caption: 'Two calls starting together: still one primary, the first start',
      primary: 'Join and start notes',
      shows: ['Daily standup', 'Northwind renewal'],
    },
    {
      card: 'call-detected',
      caption: 'A call Roger noticed: Start notes, Dismiss; no meeting, no guests',
      primary: 'Start notes',
      shows: ['Zoom', 'Dismiss'],
    },
    {
      card: 'stops-other-note',
      caption:
        'Another note is recording: the label stays Start notes, one line says which it stops',
      primary: 'Join and start notes',
      shows: ['Stops notes on Weekly sync'],
    },
    {
      card: 'taking-notes',
      caption: 'After a start: Recording, and Open Roger, a ghost; no primary',
      primary: null,
      shows: ['Recording', 'Open Roger'],
    },
    {
      card: 'start-failed',
      caption: 'The start failed: the reason as a line on the card, the buttons still there',
      primary: 'Join and start notes',
      shows: ['Dismiss'],
      problems: ['could not start notes'],
    },
  ];

  for (const { card, caption, primary, shows, problems } of cases) {
    it(
      `${card}: ${caption}`,
      async () => {
        await inEveryView(
          {
            group: 'Prompt panel',
            slug: `prompt-${card}`,
            caption,
            primary,
            shows,
            hides: ['Copy notice', 'Take notes'],
            ...(problems === undefined ? {} : { problems }),
            prompt: true,
          },
          promptCard(card),
        );
      },
      PIECE_TIMEOUT_MS,
    );
  }
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
          problems: ['Dismiss'],
        });
      });
    },
    PIECE_TIMEOUT_MS,
  );
});
