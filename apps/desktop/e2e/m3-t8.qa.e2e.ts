import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ForcedTheme } from '../preview/control';
import type { ScenarioId } from '../preview/scenarios';
import * as qa from '../qa/driver';
import type { VocabularyApi } from '../src/shared/ipc/vocabulary';

/**
 * M3-T8's browser QA: the jargon list section in Settings, both themes, 1440 and 390 wide, with a
 * long list, an empty one, a full one, an edit, a save, a refused term, a column pasted over a
 * selection, a failed save and the API offline at load. `ROGER_QA_OUT=<dir> pnpm exec vitest run --config vitest.e2e.config.ts
 * e2e/m3-t8.qa.e2e.ts`; qa/README.md says how the driver works.
 */

let run: qa.QaRun;
const gallery = new qa.Gallery('M3-T8 jargon list', 'm3-t8');

beforeAll(async () => {
  run = await qa.startQa();
});

afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m3-t8', Task: 'M3-T8 jargon list editor' });
});

/**
 * A workspace's list as a team would keep it: companies, people, products, one name with accents,
 * one 50-letter word with no space to break at. Within the limits: the fake refuses it otherwise.
 */
const TEAM_LIST = [
  'Linkt',
  'Roger',
  'AssemblyAI',
  'Deepgram',
  'Granola',
  'OpenRouter',
  'Acme Analytics',
  'Northwind Traders',
  'Contoso Pharmaceuticals',
  'Fabrikam Residences',
  'Wide World Importers',
  'Tailspin Toys',
  'Priya Raman',
  'Zoë Kowalczyk-Nakamura',
  'Joaquín Herrera',
  'Siobhán O’Sullivan',
  'Tomasz Wiśniewski',
  'Q3 roadmap',
  'SOC 2 Type II',
  'GDPR',
  'Kubernetes',
  'FastAPI',
  'TipTap',
  'Hyperconvergedinfrastructureorchestrationplatforms',
];

/** 100 terms, 8 characters each: the most a list can hold. */
const FULL_LIST = Array.from(
  { length: 100 },
  (_, index) => `Client${String(index).padStart(2, '0')}`,
);

/** One term over the 50-character limit, as someone might paste a full legal name. */
const TOO_LONG = 'Northwind Traders International Holdings Limited Co';

/**
 * The renderer file the preview serves at this URL: Vite serves files outside its root
 * (preview/) as `/@fs/<real path>`, the URL the app itself imports them from.
 */
function servedUrl(path: string): string {
  return `/@fs${realpathSync(fileURLToPath(new URL(path, import.meta.url)))}`;
}

const SLOTS_URL = servedUrl('../src/renderer/src/app/slots.ts');
const SECTION_URL = servedUrl('../src/renderer/src/settings/VocabularySettings.tsx');

/**
 * Mounts the section in the shell's `settings` slot, as M3-T9 will (app/slots/m3-transcript.ts,
 * wave 5), so the shots show it in the real Settings page with the real shell around it. The
 * entry joins the app's own `slots` object: importing the same URL gives the page's module, not a
 * copy, and SettingsPage reads the slot each time it renders. Before navigating to Settings.
 * Once M3-T9 has mounted the section, this adds nothing: a second entry would draw it twice, and
 * with one id React logs a duplicate key, failing every shot's console check.
 *
 * The page code is a string, not a function: Vitest rewrites every `import()` in this file to its
 * own loader (`__vite_ssr_dynamic_import__`), and Playwright would send that rewritten call to the
 * page, where it does not exist.
 */
async function mountInSettings(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const [{ slots }, { VocabularySettings }] = await Promise.all([
      import(${JSON.stringify(SLOTS_URL)}),
      import(${JSON.stringify(SECTION_URL)}),
    ]);
    if (slots.settings.some((entry) => entry.component === VocabularySettings)) return;
    slots.settings.push({ id: 'm3-vocabulary', order: 10, component: VocabularySettings });
  })()`);
}

/** Replaces the preview's stored list (the fake main, through window.roger). */
async function storeList(page: Page, terms: readonly string[]): Promise<void> {
  await page.evaluate(async (list) => {
    // window.roger's type lives in the renderer's roger.d.ts, outside this Node program; in the
    // preview it is the fake from preview/fakeRoger.ts.
    const roger = (window as unknown as { roger: VocabularyApi }).roger;
    await roger.setVocabulary(list);
  }, terms);
}

/** The list the preview's main stores now. */
async function storedList(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const roger = (window as unknown as { roger: VocabularyApi }).roger;
    return roger.getVocabulary();
  });
}

/** Opens Settings from the sidebar, as a person would, and waits until the list has answered. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('nav.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForSelector('.vocabulary .vocabulary-editor, .vocabulary .vocabulary-failed');
  await qa.settle(page);
}

/** Leaves Settings and comes back: the section mounts again and reads the list again. */
async function reopenSettings(page: Page): Promise<void> {
  await page.locator('nav.sidebar').getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForSelector('.vocabulary', { state: 'detached' });
  await openSettings(page);
}

/**
 * qa.expectVisible on the whole page column (qa.fitShellPage first): at 390 wide, Save is below
 * the fold of the shell's one-screen column.
 */
async function visible(page: Page, selector: string): Promise<void> {
  await qa.fitShellPage(page);
  await qa.expectVisible(page, selector);
}

async function addTerms(page: Page, text: string): Promise<void> {
  await page.fill('.vocabulary-input', text);
  await page.press('.vocabulary-input', 'Enter');
  await qa.settle(page);
}

/**
 * Selects all of the box's text and pastes `pasted` over it, as Cmd+A then Cmd+V would. The paste
 * is a page-made ClipboardEvent, not a keypress: a real Cmd+V would read, and a test would first
 * have to write, the Mac's own clipboard.
 */
async function pasteOverAll(page: Page, pasted: string): Promise<void> {
  await page.locator('.vocabulary-input').selectText();
  await page.evaluate((text) => {
    const box = document.querySelector('.vocabulary-input');
    if (!(box instanceof HTMLInputElement)) throw new Error('no jargon list box');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    box.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await qa.settle(page);
}

async function save(page: Page): Promise<void> {
  await visible(page, '.vocabulary-save');
  await page.click('.vocabulary-save');
  // The status line is display: none while empty, so wait on its text, not its visibility.
  await page.waitForFunction(
    () => document.querySelector('.vocabulary-save-status')?.textContent !== 'Saving…',
  );
  await qa.settle(page);
}

async function text(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).first().textContent()) ?? '';
}

/** The page's state checks every shot shares: fits the width, nothing logged. */
async function shoot(
  preview: qa.PreviewPage,
  group: string,
  name: string,
  caption: string,
): Promise<void> {
  await qa.fitShellPage(preview.page);
  await qa.expectNoPageOverflow(preview.page);
  qa.expectNoConsoleErrors(preview);
  await gallery.shoot(preview.page, group, name, caption);
}

async function open(scenario: ScenarioId, theme: ForcedTheme, width: number) {
  const preview = await run.open({ scenario, theme, width });
  await qa.stopScenario(preview.page);
  await mountInSettings(preview.page);
  return preview;
}

it('edits, saves and refuses terms in every theme and width', async () => {
  for (const theme of qa.QA_THEMES) {
    for (const width of qa.QA_WIDTHS) {
      const shot = `${theme}-${width}`;
      const preview = await open('empty-mac', theme, width);
      const { page } = preview;
      try {
        await storeList(page, TEAM_LIST);
        await openSettings(page);

        // The stored list, every term with its own Remove button.
        await visible(page, '.vocabulary-title');
        expect(await page.locator('.vocabulary-term').count()).toBe(TEAM_LIST.length);
        await visible(page, '.vocabulary-term:last-child .vocabulary-remove');
        expect(await text(page, '.vocabulary-size')).toBe(
          `${TEAM_LIST.length} of 100 terms · ${TEAM_LIST.reduce((sum, term) => sum + Array.from(term).length, 0)} of 800 characters`,
        );
        expect(await page.locator('.vocabulary-save').isDisabled()).toBe(true);
        await shoot(
          preview,
          'Saved list',
          `saved-list-${shot}`,
          `${TEAM_LIST.length} terms as stored; nothing to save. The 50-letter word breaks inside its chip instead of widening the page.`,
        );

        // Two new terms and one too long: the two join the list, the long one stays in the box.
        await addTerms(page, `Initech, Globex Corporation, ${TOO_LONG}`);
        expect(await page.inputValue('.vocabulary-input')).toBe(TOO_LONG);
        await visible(page, '.vocabulary-problem');
        expect(await text(page, '.vocabulary-problem')).toBe(
          '"Northwind Traders Internatio…" is 51 characters long. A term can have at most 50.',
        );
        expect(await text(page, '.vocabulary-save-status')).toBe('Unsaved changes');
        await visible(page, '.vocabulary-save');
        expect(await page.locator('.vocabulary-save').isDisabled()).toBe(false);
        await shoot(
          preview,
          'Unsaved changes and a refused term',
          `unsaved-${shot}`,
          'Initech and Globex Corporation added; the 51-character name stays in the box with the reason. Save is on.',
        );

        // Save: the list as the API stored it comes back, sorted ignoring case.
        await page.fill('.vocabulary-input', '');
        await page.click('button[aria-label="Remove Tailspin Toys"]');
        await save(page);
        expect(await text(page, '.vocabulary-save-status')).toBe(
          'Saved. New recordings use this list.',
        );
        const stored = await storedList(page);
        expect(stored).toContain('Initech');
        expect(stored).toContain('Globex Corporation');
        expect(stored).not.toContain('Tailspin Toys');
        expect(stored).toHaveLength(TEAM_LIST.length + 1);
        expect(await page.locator('.vocabulary-save').isDisabled()).toBe(true);
        await shoot(
          preview,
          'Saved',
          `saved-${shot}`,
          'After Save: the list as the API stored it, sorted; Tailspin Toys removed; the status says it is saved.',
        );

        // The API goes away, then a save fails: the change stays, with the reason.
        await qa.setApiOffline(page, true);
        await page.click('button[aria-label="Remove Initech"]');
        await save(page);
        await visible(page, '.vocabulary-editor .error');
        expect(await text(page, '.vocabulary-editor .error')).toContain(
          'Couldn’t save the jargon list: PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
        );
        expect(await page.locator('button[aria-label="Remove Initech"]').count()).toBe(0);
        expect(await page.locator('.vocabulary-save').isDisabled()).toBe(false);
        await shoot(
          preview,
          'Save failed',
          `save-failed-${shot}`,
          'The API is offline at Save: the reason shows, the removal of Initech is kept, Save stays on to retry.',
        );

        // Back online, Save again: it goes through.
        await qa.setApiOffline(page, false);
        await save(page);
        expect(await storedList(page)).not.toContain('Initech');
        expect(await page.locator('.vocabulary-editor .error').count()).toBe(0);

        // An empty list.
        await storeList(page, []);
        await reopenSettings(page);
        await visible(page, '.vocabulary-empty');
        expect(await text(page, '.vocabulary-size')).toBe('0 of 100 terms · 0 of 800 characters');
        await shoot(
          preview,
          'Empty list',
          `empty-${shot}`,
          'A workspace with no terms yet: the empty state and the box to add one.',
        );

        // A column pasted over a half-typed name replaces it: only the pasted names are added.
        await page.fill('.vocabulary-input', 'Glo');
        await pasteOverAll(page, 'Initech\nGlobex Corporation\n');
        expect(await page.inputValue('.vocabulary-input')).toBe('');
        expect(await page.locator('.vocabulary-term-text').allTextContents()).toEqual([
          'Initech',
          'Globex Corporation',
        ]);
        expect(await page.locator('.vocabulary-problem').count()).toBe(0);
        await visible(page, '.vocabulary-term:last-child .vocabulary-remove');
        await shoot(
          preview,
          'Pasted column',
          `pasted-${shot}`,
          'Two names pasted on two lines over a selected "Glo": both become terms, "Glo" is gone.',
        );

        // A full list refuses one more, and keeps it in the box.
        await storeList(page, FULL_LIST);
        await reopenSettings(page);
        await addTerms(page, 'Initech');
        expect(await page.inputValue('.vocabulary-input')).toBe('Initech');
        expect(await text(page, '.vocabulary-problem')).toBe(
          'The list is full: it can hold 100 terms. Remove one to add another.',
        );
        await visible(page, '.vocabulary-problem');
        await shoot(
          preview,
          'Full list',
          `full-${shot}`,
          '100 terms, the most a list holds: one more is refused with the reason and stays in the box.',
        );
      } finally {
        await preview.close();
      }
    }
  }
});

it('shows why the list could not be read, never an empty list to save over it', async () => {
  for (const theme of qa.QA_THEMES) {
    for (const width of qa.QA_WIDTHS) {
      const preview = await open('api-offline', theme, width);
      const { page } = preview;
      try {
        await openSettings(page);
        await visible(page, '.vocabulary-failed .error');
        expect(await text(page, '.vocabulary-failed .error')).toContain(
          'Couldn’t load the jargon list: GET /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
        );
        // Nothing to type into and nothing to save while the list is unread.
        expect(await page.locator('.vocabulary-input').count()).toBe(0);
        expect(await page.locator('.vocabulary-save').count()).toBe(0);
        await visible(page, '.vocabulary-failed .shell-button');
        await shoot(
          preview,
          'API offline at load',
          `load-failed-${theme}-${width}`,
          'The api-offline scenario: the read fails, the reason shows, and only Try again is offered.',
        );

        // The API comes back: Try again reads the list.
        await qa.setApiOffline(page, false);
        await page.click('.vocabulary-failed .shell-button');
        await page.waitForSelector('.vocabulary-editor');
        await qa.settle(page);
        expect(await page.locator('.vocabulary-term').count()).toBeGreaterThan(0);
        qa.expectNoConsoleErrors(preview);
      } finally {
        await preview.close();
      }
    }
  }
});
