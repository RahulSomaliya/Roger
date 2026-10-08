import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { PromptPanelState } from '../../shared/ipc/prompt';
import { errorMessage, type Logger } from '../logger';
import { PROMPT_PAGE_FILE, isPromptPageUrl, type AppPage } from '../page-policy';
import { PANEL_WIDTH, displayUnder, promptBounds } from './promptBounds';
import type { PromptPanelWindow } from './promptIpc';
import type { PromptService } from './PromptService';

/**
 * How long main waits for the page to report height 0 after the last card went. The card slides out
 * over 170 ms (prompt.css `slide-out`) and the page reports 0 when that ends; this is the backstop
 * for a page that never does (a crashed or throttled one), so the window cannot hang over the call
 * with a ghost card. Keep it above the page's own exit time.
 */
export const EXIT_FALLBACK_MS = 400;

export interface PromptWindowOptions {
  prompts: Pick<PromptService, 'getState' | 'onChange'>;
  /** Where the pages are served from (window.ts `resolveAppPage`); the panel's page is next to the app's. */
  page: AppPage;
  /** Absolute path of the built `preload/prompt.js`. */
  preloadPath: string;
  logger: Logger;
}

/**
 * The prompt panel's window (M5-T10): a small panel at the top right of the display under the
 * cursor, shown while `PromptService` has a card and hidden when it has none. It draws nothing
 * itself: the page renders the state that promptIpc.ts sends it, and this class only decides
 * where the window is and whether it shows.
 *
 * The window never takes focus. Typing and clicks in the call go on working, and the panel does
 * not pull macOS off a full-screen call's Space:
 * - `type: 'panel'` and `focusable: false` make it a non-activating panel, and `acceptFirstMouse`
 *   makes the first click press a button instead of only focusing the window (one click, not two).
 * - It is shown with `showInactive()` and never `show()`, `focus()` or `moveTop()`: each of those
 *   activates Roger, which over a full-screen Meet switches Spaces away from the call.
 *
 * The window is built when the first card comes and kept for good, hidden between prompts, so
 * every later prompt shows at once. It is sized from the height its page reports (see
 * `parsePanelHeight`), and only shows once that height is known, so it never flashes at a guessed
 * size.
 *
 * Wiring (M5-T9c): `registerPromptIpc({ getWindow: () => promptWindow.panel, ... })` and
 * `promptWindow.start()` after the service; `stop()` at quit. `panel` is null until the first
 * card, so the panel's channels answer nobody before then, which is right: no page exists yet.
 */
export class PromptWindow {
  private window: BrowserWindow | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Whether main has a card to show: the window may be up before its page knows. */
  private wanted = false;
  /** The page's last reported card height in CSS pixels; 0 until it reports (or with no cards). */
  private height = 0;
  /** The backstop that hides the window if the page never reports 0 after the last card went. */
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PromptWindowOptions) {}

  /** The panel's window for `registerPromptIpc`, or null while it is not built (or crashed). */
  get panel(): PromptPanelWindow | null {
    return this.window !== null && !this.window.isDestroyed() ? this.window : null;
  }

  start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.options.prompts.onChange((state) => {
      this.guarded('update', () => {
        this.sync(state);
      });
    });
    this.guarded('update', () => {
      this.sync(this.options.prompts.getState());
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wanted = false;
    this.clearExitTimer();
    const window = this.window;
    this.window = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  /**
   * Runs `work`, logging a throw instead of passing it on. A throw out of an `onChange` listener
   * reaches PromptService's emitter (which wraps each listener), and one out of a webContents
   * event handler is an uncaught exception in main; neither may take the prompt feature down
   * because a window call failed.
   */
  private guarded(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.options.logger.error(`prompt panel ${what} failed`, { error: errorMessage(error) });
    }
  }

  private sync(state: PromptPanelState): void {
    this.wanted = state.cards.length > 0;
    if (!this.wanted) {
      this.leave();
      return;
    }
    this.clearExitTimer();
    this.reveal(this.ensureWindow());
  }

  /**
   * The last card went. It slides out first, so the window stays up until the page reports height 0
   * (`onPageTitle`) or `EXIT_FALLBACK_MS` passes. Hiding here at once, as before the sweep, cut the
   * exit off and made the card vanish over the call (P3).
   */
  private leave(): void {
    const window = this.window;
    if (window === null || window.isDestroyed() || !window.isVisible()) return;
    if (this.exitTimer !== null) return;
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      this.guarded('hide', () => {
        this.hide();
      });
    }, EXIT_FALLBACK_MS);
  }

  private clearExitTimer(): void {
    if (this.exitTimer !== null) clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  private hide(): void {
    this.clearExitTimer();
    const window = this.window;
    if (window !== null && !window.isDestroyed() && window.isVisible()) {
      window.hide();
      // macOS caches a transparent window's shadow (P13): drop it with the card.
      window.invalidateShadow();
    }
  }

  /**
   * Puts the window where it belongs at the page's reported height, and shows it if it is not up.
   * Does nothing until a height is known: the first report comes a moment after the window is
   * built, and `onPageTitle` calls this again then.
   */
  private reveal(window: BrowserWindow): void {
    if (!this.wanted || this.height === 0 || window.isDestroyed()) return;
    // A panel already up stays on its own display when the cards change: the cursor may have moved
    // to another one since, and the panel must not jump under it mid-click.
    const anchor = window.isVisible()
      ? centreOf(window.getBounds())
      : screen.getCursorScreenPoint();
    const display = displayUnder(anchor, screen.getAllDisplays());
    window.setBounds(promptBounds(display.workArea, this.height));
    // Trap: a transparent window's shadow is computed by macOS and cached. Without this a card
    // that grew (a problem line, a second meeting) keeps the old, smaller shadow (P13).
    window.invalidateShadow();
    if (!window.isVisible()) window.showInactive();
  }

  /** The page reports its height in its title (`panelHeightTitle` in the renderer's prompt/). */
  private onPageTitle(window: BrowserWindow, title: string): void {
    const height = parsePanelHeight(title);
    if (height === null) return;
    this.height = height;
    if (height === 0) this.hide();
    else this.reveal(window);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window !== null && !this.window.isDestroyed()) return this.window;
    const { page, preloadPath, logger } = this.options;
    const window = new BrowserWindow({
      // A non-activating panel (NSPanel). Without `focusable: false` a click would make Roger the
      // active app and take focus from the call, which is the whole point of not using a window.
      type: 'panel',
      focusable: false,
      acceptFirstMouse: true,
      // The cards are the only pixels: no frame, a transparent window, and the system shadow
      // follows the cards' shape. Transparent gaps between cards let clicks through to the call.
      frame: false,
      transparent: true,
      hasShadow: true,
      show: false,
      width: PANEL_WIDTH,
      // Replaced by the page's reported height before the first show.
      height: 100,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'Roger prompt',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Hidden, the page would be throttled and its height report would never come.
        backgroundThrottling: false,
      },
    });
    // Above a full-screen call: the 'screen-saver' level and the full-screen auxiliary behaviour.
    window.setAlwaysOnTop(true, 'screen-saver');
    // Trap: without `skipTransformProcessType` Electron turns Roger into a background-only app for
    // an instant and back, which hides the Dock icon and every Roger window each time this runs.
    // The panel is already a non-activating NSPanel, which is what the transform is for. If real-Mac
    // check 3 shows the panel missing over a full-screen call, this is the first thing to retry.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // No new windows, and no page but the panel's own: any other would get `window.rogerPrompt`
    // and with it a say in what main logs as the user's answer.
    window.webContents.setWindowOpenHandler(({ url }) => {
      logger.warn('prompt panel new window blocked', { url });
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (isPromptPageUrl(url, page)) return;
      event.preventDefault();
      logger.warn('prompt panel navigation blocked', { url });
    });
    window.webContents.on('page-title-updated', (_event, title) => {
      this.guarded('resize', () => {
        this.onPageTitle(window, title);
      });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      logger.error('prompt panel page gone', {
        reason: details.reason,
        exitCode: details.exitCode,
      });
      // The next state change builds a new one. Not on the spot: a page that dies as it loads
      // would rebuild in a loop, and the prompt log already holds the outcome (a missed row).
      if (!window.isDestroyed()) window.destroy();
    });
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null;
        this.height = 0;
      }
    });
    this.window = window;
    this.height = 0;
    const loading =
      page.devServerUrl !== null
        ? window.loadURL(new URL(PROMPT_PAGE_FILE, page.devServerUrl).href)
        : window.loadFile(join(page.rendererDir, PROMPT_PAGE_FILE));
    loading.catch((error: unknown) => {
      logger.error('prompt panel page failed to load', { error: errorMessage(error) });
    });
    return window;
  }
}

/** The title is `roger-prompt-height:<whole CSS pixels>`, at most 5 digits. */
const HEIGHT_TITLE = /^roger-prompt-height:(\d{1,5})$/;

/**
 * The card height the page reports, from its title, or null for any other title (the page's
 * static "Roger prompt", or junk). The panel's channels belong to M5-T9b, so the page reports its
 * height this way instead of through a channel of its own; renderer/src/prompt/panelHeight.ts
 * writes the same text. Keep them in step: a mismatch is silent, the window just never shows.
 */
export function parsePanelHeight(title: string): number | null {
  const match = HEIGHT_TITLE.exec(title);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function centreOf(bounds: { x: number; y: number; width: number; height: number }) {
  return {
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  };
}
