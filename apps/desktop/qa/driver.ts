import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import type { ForcedTheme, MainErrorName } from '../preview/control';
import type { PromptScenarioId } from '../preview/promptScenarios';
import { previewSearch, type ScenarioId } from '../preview/scenarios';

/**
 * The one QA driver for Phase 2's browser checks and galleries: it serves the renderer preview
 * (preview/, vite.preview.config.ts) on a free port, opens a scenario in the Mac's own Google
 * Chrome through playwright-core with the theme forced, and shoots and checks the page the way
 * qa/README.md describes. QA scripts are vitest files (`e2e/<task>.qa.e2e.ts`).
 */

/** System Chrome: playwright-core downloads no browser. ROGER_QA_CHROME names another binary. */
export const CHROME_PATH =
  process.env.ROGER_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Every gallery shoots both themes, at a laptop width and a phone width. */
export const QA_THEMES: readonly ForcedTheme[] = ['light', 'dark'];
export const QA_WIDTHS: readonly number[] = [1440, 390];
const DEFAULT_HEIGHT = 900;

const PREVIEW_CONFIG = fileURLToPath(new URL('../vite.preview.config.ts', import.meta.url));

export interface PreviewServer {
  /** `http://127.0.0.1:<port>`, the port the OS gave this run. */
  origin: string;
  close(): Promise<void>;
}

/**
 * Serves the preview on a port the OS picks, so parallel runs never collide. Vite's own `listen`
 * reads port 0 as "no port" and binds 5173 (`startServer`: `!configPort`), and middleware mode
 * alone opens its HMR socket on the fixed port 24678: so this server binds port 0 itself, Vite
 * answers its requests, and the HMR socket rides on the same server.
 */
export async function startPreviewServer(): Promise<PreviewServer> {
  const http = createHttpServer();
  const vite = await createViteServer({
    configFile: PREVIEW_CONFIG,
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: { server: http } },
  });
  http.on('request', vite.middlewares);
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await vite.close();
    throw new Error('The preview server could not bind a port on 127.0.0.1', { cause: error });
  }
  const address = http.address();
  if (address === null || typeof address === 'string') {
    await closeAll(vite.close(), http);
    throw new Error(`The preview server bound no TCP port (address: ${String(address)})`);
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeAll(vite.close(), http),
  };
}

async function closeAll(viteClosed: Promise<void>, http: Server): Promise<void> {
  await viteClosed;
  if (!http.listening) return;
  await new Promise<void>((resolve, reject) => {
    http.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function launchChrome(): Promise<Browser> {
  try {
    await access(CHROME_PATH);
  } catch (error) {
    throw new Error(
      `QA drives the system Google Chrome, and there is none at ${CHROME_PATH}. Install Chrome, or set ROGER_QA_CHROME to a Chrome or Chromium binary.`,
      { cause: error },
    );
  }
  return chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    // A fake microphone, allowed without a prompt, so Start in the preview opens one as the app
    // does instead of failing on a permission dialog headless Chrome cannot show.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
}

export interface OpenOptions {
  scenario: ScenarioId;
  theme: ForcedTheme;
  /** CSS pixels: QA_WIDTHS. */
  width: number;
  height?: number;
}

export interface PreviewPage {
  page: Page;
  /** Console errors and uncaught page errors since the page opened, in order. */
  errors: string[];
  close(): Promise<void>;
}

/**
 * Opens a scenario in a fresh context and waits until the preview says it is drawn. The theme is
 * forced twice, and both must agree: the app's own `theme` preference (the preview answers
 * `prefs:get-all` with it) and the system scheme. Headless Chrome inherits the Mac's appearance,
 * so without the second a "light" shot from a dark-mode Mac silently comes out dark.
 */
export async function openPreview(
  browser: Browser,
  origin: string,
  options: OpenOptions,
): Promise<PreviewPage> {
  const { scenario, theme, width, height = DEFAULT_HEIGHT } = options;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // A failed load logs only "Failed to load resource": the URL says which.
      const { url } = message.location();
      errors.push(url ? `${message.text()} (${url})` : message.text());
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    // Never `networkidle`: the dev server's HMR socket and any poll keep the network busy, so it
    // times out on healthy pages. The preview says when it is drawn, on <html data-state>.
    await page.goto(`${origin}/${previewSearch({ scenario, theme })}`, { waitUntil: 'load' });
    await page.waitForSelector('html[data-state="ready"], html[data-state="error"]', {
      state: 'attached',
    });
    const boot = await page.evaluate(() => ({
      state: document.documentElement.dataset.state,
      error: document.documentElement.dataset.error,
    }));
    if (boot.state !== 'ready') {
      throw new Error(`The preview of ${scenario} did not start: ${boot.error ?? 'no reason'}`);
    }
    await expectTheme(page, theme);
    return { page, errors, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function expectTheme(page: Page, theme: ForcedTheme): Promise<void> {
  const seen = await page.evaluate(() => ({
    system: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    // Set by the app from its `theme` preference once M4-S2's useTheme() runs.
    app: document.documentElement.dataset.theme ?? null,
  }));
  if (seen.system !== theme || (seen.app !== null && seen.app !== theme)) {
    throw new Error(
      `Asked for the ${theme} theme, but the page shows system ${seen.system}, data-theme ${String(seen.app)}`,
    );
  }
}

/** A prompt panel state the preview can open: `preview/promptScenarios.ts`. */
export interface OpenPromptOptions {
  card: PromptScenarioId;
  theme: ForcedTheme;
  /** CSS pixels: QA_WIDTHS. The panel stays 360 px wide (or the page's width less a gutter). */
  width: number;
  height?: number;
}

/**
 * Opens the prompt panel's own page (`preview/prompt.html`) in a fresh context. That page has no
 * `useTheme`, so it follows the system scheme only: the context's `colorScheme` is the theme.
 */
export async function openPromptPreview(
  browser: Browser,
  origin: string,
  options: OpenPromptOptions,
): Promise<PreviewPage> {
  const { card, theme, width, height = DEFAULT_HEIGHT } = options;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const { url } = message.location();
      errors.push(url ? `${message.text()} (${url})` : message.text());
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await page.goto(`${origin}/prompt.html?card=${card}`, { waitUntil: 'load' });
    await page.waitForSelector('html[data-state="ready"], html[data-state="error"]', {
      state: 'attached',
    });
    const boot = await page.evaluate(() => ({
      state: document.documentElement.dataset.state,
      error: document.documentElement.dataset.error,
    }));
    if (boot.state !== 'ready') {
      throw new Error(`The prompt preview of ${card} did not start: ${boot.error ?? 'no reason'}`);
    }
    const system = await page.evaluate(() =>
      matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    );
    if (system !== theme) throw new Error(`Asked for ${theme}, but the page shows ${system}`);
    return { page, errors, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Waits for the page to be still: the preview's requests answered and drawn, and no finite
 * animation or transition running. Mid-animation a shot catches a colour halfway through a fade,
 * and `elementFromPoint` returns <html> during a view transition. Endless animations (a pulsing
 * recording dot) are left running.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The prompt panel's page has no fake `window.roger` to wait on (preview/prompt.html says so).
    if (document.documentElement.dataset.preview === 'prompt') return;
    const control = window.__rogerPreview;
    if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
    await control.settled();
  });
  await settleAnimations(page);
}

/** The animation half of settle(): waits until no finite animation or transition runs. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
}

/**
 * Shoots the whole page. Never `fullPage`: it re-runs fill-mode CSS animations inside the capture.
 * The viewport grows to the document's height instead, then goes back, scrolled to the top.
 */
export async function screenshot(page: Page, path: string): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The page has no fixed viewport to grow');
  await settle(page);
  await growToDocument(page, viewport.width, viewport.height);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  await page.setViewportSize(viewport);
}

/**
 * Shoots one element, clipped from a page grown to the document's height. Not
 * `locator.screenshot()`: it scrolls the page, and the next click at a narrow width then lands
 * off its target.
 */
export async function screenshotElement(page: Page, selector: string, path: string): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The page has no fixed viewport to grow');
  await settle(page);
  await growToDocument(page, viewport.width, viewport.height);
  // With the page as tall as its document and scrolled to the top, viewport and document
  // coordinates agree, so the box needs no scroll offset.
  const box = await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }, selector);
  if (box === null || box.width === 0 || box.height === 0) {
    await page.setViewportSize(viewport);
    throw new Error(`Nothing to shoot: ${selector} matches no element with a size`);
  }
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: box, animations: 'disabled', caret: 'hide' });
  await page.setViewportSize(viewport);
}

async function growToDocument(page: Page, width: number, minHeight: number): Promise<void> {
  // A layout sized to the viewport (100vh) grows with it, so measure again until it holds.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const height = await page.evaluate(() => {
      window.scrollTo(0, 0);
      return Math.ceil(document.documentElement.scrollHeight);
    });
    const current = page.viewportSize()?.height ?? minHeight;
    if (height <= current) return;
    await page.setViewportSize({ width, height: Math.max(minHeight, height) });
  }
}

/**
 * Grows the viewport until the app shell's page column stops scrolling. The shell is one screen
 * tall (app.css, `.shell` at 100vh) and scrolls inside `.shell-page`, so the document never grows
 * and `screenshot()` alone cuts what is below the fold from the shot, and leaves it outside the
 * viewport for `expectVisible()`. Call it before either on a page that runs in the shell; it
 * keeps the larger viewport, as a person who made the window taller would.
 */
export async function fitShellPage(page: Page): Promise<void> {
  // The column's content can reflow at the new height, so measure again until it holds.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hidden = await page.evaluate(() => {
      const column = document.querySelector('.shell-page');
      return column === null ? 0 : column.scrollHeight - column.clientHeight;
    });
    const viewport = page.viewportSize();
    if (hidden <= 0 || viewport === null) return;
    await page.setViewportSize({ width: viewport.width, height: viewport.height + hidden });
  }
}

export interface VisibleOptions {
  /** A scrolling container the element must lie inside, such as the transcript. */
  within?: string;
}

/**
 * Fails unless a person could see `selector`: it has a size, its centre is inside the viewport
 * (and inside `within`), and `document.elementFromPoint` at its centre is the element or inside
 * it, so nothing covers it. A class or attribute check passes on an element drawn under an
 * overlay. `elementFromPoint` skips `pointer-events: none`, so a disabled control is never found
 * at its centre: check such a control's state, not this.
 */
export async function expectVisible(
  page: Page,
  selector: string,
  options: VisibleOptions = {},
): Promise<void> {
  await settle(page);
  const problem = await page.evaluate(
    ({ target, within }) => {
      const describe = (element: Element | null): string =>
        element === null
          ? 'nothing'
          : `<${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
              element.classList.length > 0 ? `.${[...element.classList].join('.')}` : ''
            }>`;
      const element = document.querySelector(target);
      if (element === null) return 'no element matches';
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return `it has no size (${box.width} x ${box.height})`;
      }
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return `its centre (${x}, ${y}) is outside the ${window.innerWidth} x ${window.innerHeight} viewport`;
      }
      if (within !== null) {
        const container = document.querySelector(within);
        if (container === null) return `no container matches ${within}`;
        const area = container.getBoundingClientRect();
        if (x < area.left || x >= area.right || y < area.top || y >= area.bottom) {
          return `its centre (${x}, ${y}) is outside ${within}`;
        }
      }
      const top = document.elementFromPoint(x, y);
      if (top === null || !(top === element || element.contains(top))) {
        return `${describe(top)} covers its centre`;
      }
      return null;
    },
    { target: selector, within: options.within ?? null },
  );
  if (problem !== null) throw new Error(`${selector} is not visible: ${problem}`);
}

/** Fails if the page scrolls sideways, the first sign of a layout that does not fit the width. */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const { overflow, width } = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    width: window.innerWidth,
  }));
  if (overflow > 0) throw new Error(`The page scrolls sideways by ${overflow} px at ${width} px`);
}

export function expectNoConsoleErrors(preview: PreviewPage): void {
  if (preview.errors.length > 0) {
    throw new Error(
      `The page logged ${preview.errors.length} error(s):\n${preview.errors.join('\n')}`,
    );
  }
}

/** Sends a main → renderer event through the preview (window.__rogerPreview.emit). */
export async function emitEvent(page: Page, channel: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ({ name, body }) => {
      const control = window.__rogerPreview;
      if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
      control.emit(name, body);
    },
    { name: channel, body: payload },
  );
}

/** The page's next request rejects as if main's handler threw `name: message`. */
export async function failNextRequest(
  page: Page,
  message: string,
  name: MainErrorName = 'Error',
): Promise<void> {
  await page.evaluate(
    ({ text, errorName }) => {
      const control = window.__rogerPreview;
      if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
      control.failNextRequest(text, errorName);
    },
    { text: message, errorName: name },
  );
}

/** Takes the Roger API away from the page, or brings it back. */
export async function setApiOffline(page: Page, offline: boolean): Promise<void> {
  await page.evaluate((value) => {
    const control = window.__rogerPreview;
    if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
    control.setApiOffline(value);
  }, offline);
}

/** Stops the scenario's timers (the live call's new lines) for a fixed frame. */
export async function stopScenario(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = window.__rogerPreview;
    if (control === undefined) throw new Error('No window.__rogerPreview: not the preview page');
    control.stopScenario();
  });
}

/** A preview server and Chrome for one QA script; close() ends both. */
export interface QaRun {
  origin: string;
  browser: Browser;
  open(options: OpenOptions): Promise<PreviewPage>;
  /** The prompt panel's page, on one of its cards. */
  openPrompt(options: OpenPromptOptions): Promise<PreviewPage>;
  close(): Promise<void>;
}

export async function startQa(): Promise<QaRun> {
  const server = await startPreviewServer();
  let browser: Browser;
  try {
    browser = await launchChrome();
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    origin: server.origin,
    browser,
    open: (options) => openPreview(browser, server.origin, options),
    openPrompt: (options) => openPromptPreview(browser, server.origin, options),
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

export type ShotCheck = 'pass' | 'warn' | 'fail';

/** One entry of the gallery manifest: a shot and what it proves. */
export interface GalleryShot {
  file: string;
  caption: string;
  check: ShotCheck;
  note?: string;
}

/** The gallery manifest (shots.json) the QA gallery page is built from, shots grouped by screen. */
export interface GalleryManifest {
  title: string;
  subtitle?: string;
  meta: Record<string, string>;
  groups: { name: string; shots: GalleryShot[] }[];
}

/**
 * Collects a QA script's shots into one folder and one manifest, so the gallery is one page, not
 * loose PNG paths. The folder is ROGER_QA_OUT, else `<tmp>/roger-qa/<slug>`: never inside the repo.
 */
export class Gallery {
  readonly dir: string;
  private readonly groups = new Map<string, GalleryShot[]>();

  constructor(
    private readonly title: string,
    slug: string,
  ) {
    this.dir = process.env.ROGER_QA_OUT ?? join(tmpdir(), 'roger-qa', slug);
  }

  /** Shoots the page into the gallery folder as `<name>.png` and lists it under `group`. */
  async shoot(
    page: Page,
    group: string,
    name: string,
    caption: string,
    check: ShotCheck = 'pass',
    note?: string,
  ): Promise<string> {
    const file = join(this.dir, `${name}.png`);
    await screenshot(page, file);
    const shot: GalleryShot =
      note === undefined ? { file, caption, check } : { file, caption, check, note };
    this.groups.set(group, [...(this.groups.get(group) ?? []), shot]);
    return file;
  }

  /**
   * Writes `shots.json` next to the shots and returns its path. A manifest already there is kept
   * and added to: a shot of the same file is replaced, any other stays. A QA script too long for
   * one call (the 10-minute stall limit) runs in pieces, each adding its groups; clear the folder
   * to start a gallery afresh, or a shot of a state that no longer exists stays in it.
   */
  async write(meta: Record<string, string> = {}, subtitle?: string): Promise<string> {
    const path = join(this.dir, 'shots.json');
    const before = await readManifest(path);
    const groups = new Map<string, GalleryShot[]>(
      (before?.groups ?? []).map(({ name, shots }) => [name, shots]),
    );
    for (const [name, added] of this.groups) {
      const kept = (groups.get(name) ?? []).filter(
        (shot) => !added.some((again) => again.file === shot.file),
      );
      groups.set(name, [...kept, ...added]);
    }
    const manifest: GalleryManifest = {
      title: this.title,
      ...(subtitle === undefined ? {} : { subtitle }),
      meta: { ...before?.meta, ...meta },
      groups: [...groups].map(([name, shots]) => ({ name, shots })),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return path;
  }
}

/** The manifest at `path`, or null when there is none yet; any other failure is raised. */
async function readManifest(path: string): Promise<GalleryManifest | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(`Could not read the gallery manifest ${path}`, { cause: error });
  }
  return JSON.parse(text) as GalleryManifest;
}
