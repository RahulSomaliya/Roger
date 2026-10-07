import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AllDayCalendarEvent,
  CalendarAttendee,
  CalendarConnection,
  CalendarEvent,
  TimedCalendarEvent,
} from '../src/shared/calendar';
import { calendarChannels } from '../src/shared/ipc/calendar';
import { loginItemChannels, type LoginItemStatus } from '../src/shared/ipc/loginItem';
import { PREVIEW_CALENDAR_ACCOUNT } from '../preview/fakes/calendar';
import type { ForcedTheme } from '../preview/control';
import * as qa from '../qa/driver';

/*
 * Browser QA for M5-T13, the calendar mounted in the real shell (qa/README.md): both themes, 1440
 * and 390 wide, through the preview. Nothing is mounted by hand: Home, Settings, the banner above
 * every page and the meeting page's notice are the app's own, filled by app/slots/m5-calendar.ts.
 *
 *  - Home with no calendar: the connect card; Connect with the preview's fake provider; then
 *    Today with the fake day, the "opens at login" line, and the all-day strip.
 *  - Start notes on the next meeting opens its meeting page, recording, with the consent notice;
 *    Copy notice failing (the clipboard refuses) and succeeding; back on Home the meeting says
 *    Open note once main knows it.
 *  - The calendar's health above every page: stale, reconnect soon, reconnect required.
 *  - Settings: the calendar section after M3's and M4's, the lead time and notice text saved, a
 *    refused save shown, the login item waiting for approval, Disconnect.
 *  - A crowded day (long titles, many attendees, all-day events), an empty day, and Connect
 *    failing while the API is away.
 *
 * Run:
 *
 *   ROGER_QA_OUT=<dir> pnpm --filter @roger/desktop exec vitest run \
 *     --config vitest.e2e.config.ts e2e/m5-t13.qa.e2e.ts
 */

declare global {
  interface Window {
    /** What the page wrote to its clipboard, recorded by the stand-in clipboard. */
    __m5t13Written?: string[];
  }
}

let run: qa.QaRun;
const gallery = new qa.Gallery('M5-T13 calendar in the shell', 'm5-t13');
const results: { shot: string; check: qa.ShotCheck; note?: string }[] = [];
const FLOW_TIMEOUT_MS = 300_000;
/** The notice banner's "copied" confirmation goes after this long (calendar/NoticeBanner.tsx). */
const COPIED_SHOWN_MS = 4_000;

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  const manifest = await gallery.write(
    {
      Branch: 'p2/m5-t13',
      Harness:
        "The app's own shell through the preview, with the preview's fake Google provider; nothing mounted by hand",
      Data: "The fake provider's day, a crowded day with long names, an empty day, the offline API",
    },
    'Calendar in the shell: connect card, Today with Start notes and Open note, the consent notice on the meeting page, the status banner on every page, the Calendar settings, a crowded and an empty day, and Connect while the API is away',
  );
  process.stdout.write(
    `\nM5-T13 QA: ${results.map(({ shot, check }) => `${shot} ${check}`).join(', ')}\n${manifest}\n`,
  );
});

const LONG_NAME = 'Maximilian Featherstonehaugh-Worthington';
const LONG_TITLE = `Quarterly business review with ${LONG_NAME} and the whole platform team`;
const LONG_EMAIL =
  'maximilian.featherstonehaugh-worthington@a-very-long-company-domain.example.com';
const BANNER_SLOT = '.banner-slot';
const CONNECT_CARD = '.calendar-connect';
const TODAY = '.calendar-today';
const SETTINGS = '.calendar-settings';
const NOTICE = '.calendar-notice';

function combos(): { theme: ForcedTheme; width: number }[] {
  return qa.QA_THEMES.flatMap((theme) => qa.QA_WIDTHS.map((width) => ({ theme, width })));
}

// The page -------------------------------------------------------------------------------------

async function openSettings(page: Page): Promise<void> {
  await page.locator('.sidebar-link', { hasText: 'Settings' }).click();
  await page.waitForSelector(SETTINGS);
  await qa.settle(page);
}

async function openHome(page: Page): Promise<void> {
  await page.locator('.sidebar-link', { hasText: 'Home' }).click();
  await page.waitForSelector('.page-title');
  await qa.settle(page);
}

async function textOf(page: Page, selector: string): Promise<string> {
  return ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
}

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

/** Connects as a person does and waits for the day to arrive. */
async function connectFromHome(page: Page): Promise<void> {
  await page.waitForSelector(CONNECT_CARD);
  await page.click(`${CONNECT_CARD} button`);
  await page.waitForSelector(`${TODAY} .calendar-list`);
  await qa.settle(page);
}

const emitLoginItem = (page: Page, status: LoginItemStatus): Promise<void> =>
  qa.emitEvent(page, loginItemChannels.LoginItemStateChanged, { status });

/** Fails if the window itself scrolls down: a box escaped every scroller (see m4-t20's twin). */
async function expectNoPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  if (overflow > 0) throw new Error(`The window scrolls down by ${overflow} px`);
}

/** Fails unless `selector`'s computed `property` is the theme token `token` in the page's theme. */
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

/** Fails if any of `selector`'s boxes reaches past its section: long text must wrap, not spill. */
async function expectInside(page: Page, selector: string, container: string): Promise<void> {
  const spill = await page.evaluate(
    ({ inner, outer }) => {
      const area = document.querySelector(outer)?.getBoundingClientRect();
      if (area === undefined) throw new Error(`No ${outer}`);
      return Array.from(document.querySelectorAll(inner)).flatMap((element) => {
        const box = element.getBoundingClientRect();
        return box.right > area.right + 0.5 || box.left < area.left - 0.5
          ? [`${element.textContent.slice(0, 30)} (${box.left}..${box.right})`]
          : [];
      });
    },
    { inner: selector, outer: container },
  );
  if (spill.length > 0) throw new Error(`${selector} spills out of ${container}: ${spill.join()}`);
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

// Calendar data --------------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** A local time today: the crowded day stands at fixed hours, so it reads the same at any hour. */
function today(hour: number, minute = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
}

function person(name: string, fields: Partial<CalendarAttendee> = {}): CalendarAttendee {
  return {
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
    displayName: name,
    responseStatus: 'accepted',
    isSelf: false,
    isOrganizer: false,
    ...fields,
  };
}

function timed(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<TimedCalendarEvent> = {},
): TimedCalendarEvent {
  return {
    provider: 'fake',
    id,
    icalUid: null,
    recurringEventId: null,
    title,
    status: 'confirmed',
    allDay: false,
    start,
    end,
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    ...extra,
  };
}

function allDay(id: string, title: string): AllDayCalendarEvent {
  const now = new Date();
  const date = (offset: number): string => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };
  return {
    ...timed(id, title, today(0), today(0)),
    allDay: true,
    start: null,
    end: null,
    startDate: date(0),
    endDate: date(1),
    selfResponse: 'organizer',
  };
}

/** Twelve meetings with long titles and many guests, four all-day items: the layout's worst day. */
function crowdedDay(): CalendarEvent[] {
  const guests = [
    person(LONG_NAME),
    person('Ali Khan'),
    person('Jane Cooper'),
    person('Priya Raman'),
    person('Sam Okafor'),
    person('Lena Fischer'),
  ];
  return [
    allDay('c-all-1', 'Release week'),
    allDay('c-all-2', 'Company offsite planning (all week, everyone invited)'),
    allDay('c-all-3', LONG_TITLE),
    allDay('c-all-4', 'Out of office: Priya'),
    ...Array.from({ length: 12 }, (_, index) =>
      timed(
        `c-${index}`,
        index % 3 === 0 ? LONG_TITLE : `Meeting ${index + 1}`,
        today(8 + index, 0),
        today(8 + index, 45),
        {
          attendees: guests,
          videoLink: 'https://meet.google.com/abc-defg-hij',
          videoLinkSource: 'conference',
          ...(index === 4 ? { selfResponse: 'declined' } : {}),
        },
      ),
    ),
  ];
}

const connection = (fields: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: 'google',
  accountEmail: PREVIEW_CALENDAR_ACCOUNT,
  status: 'active',
  connectedAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE_MS).toISOString(),
  expiresHint: null,
  lastError: null,
  ...fields,
});

const emitConnection = (page: Page, value: CalendarConnection | null): Promise<void> =>
  qa.emitEvent(page, calendarChannels.CalendarConnectionChanged, value);
const emitEvents = (page: Page, value: CalendarEvent[]): Promise<void> =>
  qa.emitEvent(page, calendarChannels.CalendarEventsChanged, value);
const emitSync = (
  page: Page,
  fields: { staleMinutesAgo?: number; reconnectRequired?: boolean },
): Promise<void> => {
  const stale =
    fields.staleMinutesAgo === undefined
      ? null
      : new Date(Date.now() - fields.staleMinutesAgo * MINUTE_MS).toISOString();
  return qa.emitEvent(page, calendarChannels.CalendarSyncStateChanged, {
    lastSuccessAt: new Date(Date.now() - (fields.staleMinutesAgo ?? 1) * MINUTE_MS).toISOString(),
    lastError: stale === null ? null : 'Google did not answer',
    staleSince: stale,
    reconnectRequired: fields.reconnectRequired ?? false,
  });
};

// The flows ------------------------------------------------------------------------------------

describe('M5-T13 calendar in the shell', () => {
  it(
    'offers Connect on Home, then shows Today with the fake day',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'empty-mac', theme, width });
        const { page } = preview;
        await emitLoginItem(page, 'enabled');
        await page.waitForSelector(CONNECT_CARD);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Home: connect',
          `home-connect-${tag}`,
          'Home with no calendar: the card says what Connect does',
          async () => {
            await qa.expectVisible(page, `${CONNECT_CARD} button`);
            expect(await textOf(page, `${CONNECT_CARD} h2`)).toBe('See your day in Roger');
            expect(await count(page, TODAY)).toBe(0);
            await expectToken(page, `${CONNECT_CARD} .calendar-connect-text`, 'color', '--muted');
          },
        );

        await connectFromHome(page);
        await shootChecked(
          preview,
          'Home: Today',
          `home-today-${tag}`,
          'Home after Connect: the next meeting first, Start notes on it, the declined call greyed, the all-day strip and the open-at-login line',
          async () => {
            await qa.expectVisible(page, `${TODAY} .calendar-next`);
            expect(await textOf(page, `${TODAY} .calendar-next .calendar-title`)).toBe(
              'Weekly sync',
            );
            await qa.expectVisible(page, 'button[aria-label="Start notes for Weekly sync"]');
            expect(await textOf(page, '.calendar-allday')).toContain('Release week');
            expect(await count(page, '.calendar-declined')).toBeGreaterThanOrEqual(1);
            expect(await textOf(page, '.calendar-login')).toContain(
              'Roger will open at login so it can remind you.',
            );
            await qa.expectVisible(page, '.calendar-login button');
            await expectToken(page, `${TODAY} .calendar-title`, 'color', '--ink');
            // The sidebar, the banner and the page do not move for the section.
            expect(await count(page, `${BANNER_SLOT} [data-notice]`)).toBe(0);
          },
        );
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'starts notes from Today, shows the consent notice on the meeting page, and Open note after',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'empty-mac', theme, width });
        const { page } = preview;
        await connectFromHome(page);
        await page.click('button[aria-label="Start notes for Weekly sync"]');
        await page.waitForSelector(`.meeting-page ${NOTICE}`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Meeting page: notice',
          `meeting-notice-${tag}`,
          'Start notes opened the meeting, recording, with the invite’s title in the request; the consent notice sits above it with Copy notice and Dismiss',
          async () => {
            // The request carried the invite's title: the capture fake answers it in the status.
            // The page's own h1 is the stored meeting's, which the preview's meetings fake names
            // by the clock (main names it from the request), so it is not what this checks.
            const status = await page.evaluate(() => window.roger.getCaptureStatus());
            expect(status.phase).toBe('recording');
            expect(status.title).toBe('Weekly sync');
            await qa.expectVisible(page, '.meeting-page h1');
            await qa.expectVisible(page, `${NOTICE} .calendar-start`);
            await qa.expectVisible(page, `${NOTICE} button:not(.calendar-start)`);
            expect(await textOf(page, `${NOTICE} .calendar-notice-title`)).toBe(
              'Let the others on the call know you are taking notes.',
            );
            expect(await textOf(page, '.calendar-notice-text')).toContain('Roger');
          },
        );

        // The clipboard refuses: the banner says so and keeps the notice, instead of the user
        // pasting an old clipboard into a call.
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: () => Promise.reject(new Error('Document is not focused')) },
          });
        });
        await page.click(`${NOTICE} .calendar-start`);
        await page.waitForSelector('.calendar-notice-error');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Meeting page: notice',
          `meeting-notice-refused-${tag}`,
          'The clipboard refused: the banner says Roger could not copy, and stays',
          async () => {
            expect(await textOf(page, '.calendar-notice-error')).toContain(
              'Roger could not copy the notice',
            );
            await qa.expectVisible(page, `${NOTICE} .calendar-start`);
          },
        );

        await page.evaluate(() => {
          const written: string[] = [];
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: (text: string) => {
                written.push(text);
                return Promise.resolve();
              },
            },
          });
          window.__m5t13Written = written;
        });
        await page.click(`${NOTICE} .calendar-start`);
        await page.waitForFunction(() =>
          document.querySelector('.calendar-notice')?.textContent.includes('Notice copied'),
        );
        const written = await page.evaluate(() => window.__m5t13Written ?? []);
        expect(written).toHaveLength(1);
        expect(written[0]).toContain('Roger');
        await shootChecked(
          preview,
          'Meeting page: notice',
          `meeting-notice-copied-${tag}`,
          'Copied: the banner says so for a few seconds, so the click is seen to have worked',
          async () => {
            expect(await textOf(page, NOTICE)).toBe(
              'Notice copied. Paste it into the call’s chat.',
            );
          },
        );
        // Then the banner goes and does not come back for this meeting.
        await page.waitForSelector(NOTICE, { state: 'detached', timeout: COPIED_SHOWN_MS * 3 });

        // Home, while recording: the meeting is the one note being taken, so main knows its event.
        const meetingId = await page.evaluate(
          async () => (await window.roger.getCaptureStatus()).meetingId,
        );
        if (meetingId === null) throw new Error('No meeting is recording after Start notes');
        await qa.emitEvent(page, calendarChannels.CalendarFindMeetings, [
          { eventId: 'fake-call', meetingId },
        ]);
        await openHome(page);
        await page.waitForSelector('button[aria-label="Open note for Weekly sync"]');
        await shootChecked(
          preview,
          'Home: Today',
          `home-open-note-${tag}`,
          'Back on Home while recording: the meeting that has its note says Open note, never a second Start',
          async () => {
            await qa.expectVisible(page, 'button[aria-label="Open note for Weekly sync"]');
            expect(await count(page, 'button[aria-label="Start notes for Weekly sync"]')).toBe(0);
          },
        );
        await page.click('button[aria-label="Open note for Weekly sync"]');
        await page.waitForSelector('.meeting-page h1');
        await qa.expectVisible(page, '.meeting-page h1');
        // Done for this meeting: the notice does not return on the way back.
        expect(await count(page, NOTICE)).toBe(0);
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'shows the calendar health above every page',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'empty-mac', theme, width });
        const { page } = preview;
        await connectFromHome(page);

        await emitSync(page, { staleMinutesAgo: 95 });
        await page.waitForSelector('[data-notice="stale"]');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Banner: calendar health',
          `banner-stale-${tag}`,
          'The copy is stale: "Calendar not updated since", above Home',
          async () => {
            await qa.expectVisible(page, '[data-notice="stale"]', { within: BANNER_SLOT });
            expect(await textOf(page, '[data-notice="stale"]')).toMatch(
              /^Calendar not updated since /,
            );
          },
        );
        // Above every page, not only Home: the settings page shows it too.
        await openSettings(page);
        await qa.expectVisible(page, '[data-notice="stale"]', { within: BANNER_SLOT });
        await openHome(page);

        await emitSync(page, {});
        await emitConnection(
          page,
          connection({ expiresHint: new Date(Date.now() + 20 * 60 * MINUTE_MS).toISOString() }),
        );
        await page.waitForSelector('[data-notice="reconnect-soon"]');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Banner: calendar health',
          `banner-reconnect-soon-${tag}`,
          'The Google grant ends within a day: "Reconnect before <date>"',
          async () => {
            await qa.expectVisible(page, '[data-notice="reconnect-soon"] button');
            expect(await textOf(page, '[data-notice="reconnect-soon"] button')).toMatch(
              /^Reconnect before /,
            );
            expect(await count(page, '[data-notice="stale"]')).toBe(0);
          },
        );

        await emitSync(page, { staleMinutesAgo: 300, reconnectRequired: true });
        await emitConnection(page, connection({ status: 'reconnect_required' }));
        await page.waitForSelector('[data-notice="reconnect-required"]');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Banner: calendar health',
          `banner-reconnect-required-${tag}`,
          'Google refused the grant: an alert with Reconnect, and no "stale" line next to it',
          async () => {
            await qa.expectVisible(page, '[data-notice="reconnect-required"] button');
            expect(await count(page, '[data-notice="stale"]')).toBe(0);
            expect(await page.getAttribute('[data-notice="reconnect-required"]', 'role')).toBe(
              'alert',
            );
          },
        );
        // Reconnect: the fake provider answers, and the banner goes.
        await page.click('[data-notice="reconnect-required"] button');
        await page.waitForSelector('[data-notice]', { state: 'detached' });
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'shows the Calendar section in Settings after the notes, saves a choice and shows a refused one',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'empty-mac', theme, width });
        const { page } = preview;

        // Not connected yet.
        await openSettings(page);
        await shootChecked(
          preview,
          'Settings',
          `settings-disconnected-${tag}`,
          'Settings with no calendar: the Calendar section after the notes section, with Connect',
          async () => {
            const headings = await page
              .locator('.settings-sections h2')
              .evaluateAll((all) => all.map((each) => each.textContent.trim()));
            expect(headings.at(-1)).toBe('Calendar');
            expect(headings.indexOf('Notes')).toBeLessThan(headings.indexOf('Calendar'));
            await qa.expectVisible(page, `${SETTINGS} .calendar-account button`);
            expect(await textOf(page, '.calendar-account-text')).toBe('No calendar connected.');
          },
        );

        await emitLoginItem(page, 'requires-approval');
        await emitConnection(page, connection({ accountEmail: LONG_EMAIL }));
        await page.waitForSelector('.calendar-account strong');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Settings',
          `settings-connected-${tag}`,
          'Connected as a long address, the notice text, and the login item waiting for approval with where to allow it',
          async () => {
            expect(await textOf(page, '.calendar-account strong')).toBe(LONG_EMAIL);
            await expectInside(page, '.calendar-account strong', SETTINGS);
            await qa.expectVisible(page, '[data-login-item="requires-approval"]');
            expect(await textOf(page, '[data-login-item]')).toContain('System Settings');
            await qa.expectVisible(page, '.calendar-textarea');
            await qa.expectVisible(page, `${SETTINGS} select`);
          },
        );

        // A saved choice: the lead time and the notice text go through the preferences.
        await page.selectOption(`${SETTINGS} select`, '5');
        await page.waitForFunction(
          () => document.querySelector<HTMLSelectElement>('.calendar-select')?.value === '5',
        );
        await page.fill('.calendar-textarea', 'Heads up: Roger is taking notes for me.');
        await page.click(`${SETTINGS} button:has-text("Save notice")`);
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLTextAreaElement>('.calendar-textarea')?.value ===
              'Heads up: Roger is taking notes for me.' &&
            document.querySelector<HTMLButtonElement>('.calendar-notice-actions .calendar-start')
              ?.disabled === true,
        );
        // A refused save is shown and keeps what is stored.
        await qa.failNextRequest(page, 'the preferences file is locked');
        await page.selectOption(`${SETTINGS} select`, '10');
        await page.waitForSelector(`${SETTINGS} .calendar-problem`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Settings',
          `settings-save-refused-${tag}`,
          'The notice saved; the next choice was refused, and the section says so and keeps the stored 5 minutes',
          async () => {
            expect(await textOf(page, `${SETTINGS} .calendar-problem`)).toContain(
              'Roger could not save that setting',
            );
            expect(await page.inputValue(`${SETTINGS} select`)).toBe('5');
          },
        );

        await page.click(`${SETTINGS} button:has-text("Disconnect")`);
        await page.waitForFunction(() =>
          document.querySelector('.calendar-account-text')?.textContent.includes('No calendar'),
        );
        await openHome(page);
        await page.waitForSelector(CONNECT_CARD);
        await shootChecked(
          preview,
          'Settings',
          `home-after-disconnect-${tag}`,
          'After Disconnect in Settings, Home offers Connect again and the day is gone',
          async () => {
            await qa.expectVisible(page, `${CONNECT_CARD} button`);
            expect(await count(page, `${TODAY} .calendar-list`)).toBe(0);
          },
        );
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'keeps a crowded day inside the page and says so when the day is empty',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'empty-mac', theme, width });
        const { page } = preview;
        await connectFromHome(page);

        await emitEvents(page, crowdedDay());
        await page.waitForFunction(
          () => document.querySelectorAll('.calendar-list > li').length === 12,
        );
        await qa.settle(page);
        await shootChecked(
          preview,
          'Home: busy and empty days',
          `home-crowded-${tag}`,
          'Twelve meetings with long titles and six guests each, four all-day items: everything wraps inside the column',
          async () => {
            expect(await count(page, '.calendar-allday li')).toBe(4);
            await expectInside(page, `${TODAY} .calendar-title`, TODAY);
            await expectInside(page, `${TODAY} .calendar-meta`, TODAY);
            await expectInside(page, `${TODAY} .calendar-allday li`, TODAY);
            expect(await count(page, '.calendar-declined')).toBeGreaterThanOrEqual(1);
          },
        );

        await emitEvents(page, []);
        await page.waitForSelector(`${TODAY} .empty-state`);
        await qa.settle(page);
        await shootChecked(
          preview,
          'Home: busy and empty days',
          `home-empty-day-${tag}`,
          'A connected calendar with nothing today says so, not a blank page',
          async () => {
            expect(await textOf(page, `${TODAY} .empty-state-title`)).toBe(
              'Nothing on your calendar today',
            );
          },
        );
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    'says why Connect failed while the API is away',
    async () => {
      for (const { theme, width } of combos()) {
        const tag = `${theme}-${width}`;
        const preview = await run.open({ scenario: 'api-offline', theme, width });
        const { page } = preview;
        await page.waitForSelector(CONNECT_CARD);
        await page.click(`${CONNECT_CARD} button`);
        await page.waitForSelector('.calendar-connect-error');
        await qa.settle(page);
        await shootChecked(
          preview,
          'Home: connect',
          `home-connect-offline-${tag}`,
          'The API is away: Connect fails with the reason in an alert, and the button stays to try again',
          async () => {
            expect(await textOf(page, '.calendar-connect-error')).toContain(
              'Roger could not connect Google Calendar:',
            );
            await qa.expectVisible(page, `${CONNECT_CARD} button`);
            expect(await count(page, `${TODAY} .calendar-list`)).toBe(0);
          },
        );
        await preview.close();
      }
    },
    FLOW_TIMEOUT_MS,
  );
});
