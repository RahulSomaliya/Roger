import { appChannels, parseAppRoute, type AppRoute } from '../shared/ipc/app';
import { onTrusted, type IpcMainLike } from './ipc/trust';
import type { Logger } from './logger';

/**
 * Main asks the page to open a route (`app:navigate`, src/shared/ipc/app.ts): the app menu's
 * Settings and Set up items, later M5's "Take notes". A page that is still loading, reloading or
 * crashed has no listener, and a message sent to it is lost, so a route waits here until the page
 * says `app:ready`, then goes once. No Electron import, so this tests under Node.
 */

/** How long a route waits for the page before it is dropped (M5's SHELL-0 spec). */
export const NAVIGATE_HOLD_MS = 60_000;

/** The parts of the main window's webContents this needs. Electron's BrowserWindow fits. */
export interface NavigableWindow {
  readonly webContents: {
    readonly id: number;
    send(channel: string, payload: unknown): void;
    isDestroyed(): boolean;
    on(
      event: 'did-start-navigation',
      listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
    ): unknown;
    on(event: 'render-process-gone', listener: () => void): unknown;
  };
}

export interface NavigationDeps {
  ipcMain: IpcMainLike;
  /** The main window; null while none is open. Only its page may say app:ready. */
  getWindow: () => NavigableWindow | null;
  logger: Logger;
  /** Epoch ms. Injected in tests. */
  now?: () => number;
}

export interface Navigation {
  /**
   * Opens `route` in the main window's page: at once when the page is ready, else when it next
   * says app:ready, within NAVIGATE_HOLD_MS. A newer route replaces one still waiting. Throws on a
   * route outside the closed set, naming it: callers build routes from their own ids.
   */
  navigate(route: AppRoute): void;
}

/** Registers app:ready for the main window's page (ipc/trust.ts) and returns the navigator. */
export function registerNavigation(deps: NavigationDeps): Navigation {
  const navigator = new AppNavigator(deps);
  onTrusted(
    { ipcMain: deps.ipcMain, getWindow: deps.getWindow, logger: deps.logger },
    appChannels.AppReady,
    () => {
      navigator.pageReady();
    },
  );
  return navigator;
}

class AppNavigator implements Navigation {
  /**
   * The webContents whose current page said app:ready, or null. By id, not a flag: a window made
   * after the old one closed has a new page that has not said ready yet.
   */
  private readyPageId: number | null = null;
  private waiting: { route: AppRoute; since: number } | null = null;
  private readonly watched = new WeakSet<NavigableWindow['webContents']>();
  private readonly now: () => number;

  constructor(private readonly deps: NavigationDeps) {
    this.now = deps.now ?? Date.now;
  }

  navigate(route: AppRoute): void {
    if (parseAppRoute(route) === null) {
      throw new Error(`app:navigate refused a route outside the closed set: ${route}`);
    }
    const page = this.readyPage();
    if (page !== null) {
      this.send(page, route);
      return;
    }
    if (this.waiting !== null) {
      this.deps.logger.info('navigate replaced a route still waiting for the page', {
        route,
        replaced: this.waiting.route,
      });
    }
    this.waiting = { route, since: this.now() };
  }

  /** The trusted page said app:ready (ipc/trust.ts already refused any other sender). */
  pageReady(): void {
    const window = this.deps.getWindow();
    if (window === null) return;
    this.watch(window.webContents);
    this.readyPageId = window.webContents.id;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting === null) return;
    const waitedMs = this.now() - waiting.since;
    if (waitedMs > NAVIGATE_HOLD_MS) {
      this.deps.logger.warn('navigate dropped: the page was not ready in time', {
        route: waiting.route,
        waitedMs,
      });
      return;
    }
    this.send(window.webContents, waiting.route);
  }

  private readyPage(): NavigableWindow['webContents'] | null {
    const page = this.deps.getWindow()?.webContents ?? null;
    if (page === null || page.isDestroyed() || page.id !== this.readyPageId) return null;
    return page;
  }

  private send(page: NavigableWindow['webContents'], route: AppRoute): void {
    page.send(appChannels.AppNavigate, route);
    this.deps.logger.info('navigate sent to the page', { route });
  }

  /**
   * From its first app:ready on, a page that loads a new document (a reload, M2's reload after a
   * crash) or loses its renderer is not ready until it says so again. Hash and history changes
   * are same-document navigations and keep it ready. Routes sent before the first app:ready wait
   * anyway, so watching from then on misses nothing.
   */
  private watch(page: NavigableWindow['webContents']): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    const notReady = (): void => {
      if (this.readyPageId === page.id) this.readyPageId = null;
    };
    page.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) notReady();
    });
    page.on('render-process-gone', notReady);
  }
}
