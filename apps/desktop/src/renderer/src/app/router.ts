import { isMeetingId, parseAppRoute } from '../../../shared/ipc/app';

/**
 * The shell's four screens and their hashes: `#/`, `#/meetings/<id>`, `#/settings`, `#/setup`.
 * The hash format is what QA scripts and the preview load (`index.html#/settings`) and what this
 * window saves across a reload; a route main sends (app:navigate) arrives as an AppRoute.
 */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'meeting'; readonly meetingId: string }
  | { readonly name: 'settings' }
  | { readonly name: 'setup' };

export const HOME: Route = { name: 'home' };

const MEETING_HASH = /^#\/meetings\/([^/]+)$/;

/** The screen a hash names; anything else, a malformed meeting id included, is Home. */
export function parseRoute(hash: string): Route {
  if (hash === '#/settings') return { name: 'settings' };
  if (hash === '#/setup') return { name: 'setup' };
  const meetingId = MEETING_HASH.exec(hash)?.[1];
  if (meetingId !== undefined && isMeetingId(meetingId)) return { name: 'meeting', meetingId };
  return HOME;
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'meeting':
      return `#/meetings/${route.meetingId}`;
    case 'settings':
      return '#/settings';
    case 'setup':
      return '#/setup';
  }
}

/**
 * The screen an app:navigate payload opens, or null for one this page lacks, which it ignores
 * (M5's SHELL-0 spec). Checked again here: the preload passes the payload on unread.
 */
export function routeFromApp(payload: unknown): Route | null {
  const route = parseAppRoute(payload);
  if (route === null) return null;
  if (route === 'home' || route === 'settings' || route === 'setup') return { name: route };
  return { name: 'meeting', meetingId: route.slice('meeting/'.length) };
}

/** Where this window keeps its route, so a reload (M2 reloads after a crash) comes back to it. */
export const ROUTE_STORAGE_KEY = 'roger.route';

/** What RouteStore needs from the page; `window` fits. Injected so the store tests under Node. */
export interface RoutePage {
  readonly location: { readonly hash: string };
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/**
 * The current route, for useSyncExternalStore.
 *
 * Trap: navigating never writes `location.hash`, and nothing in the shell may (no
 * `<a href="#/...">`, no `history.pushState` or `history.replaceState`). Each is a same-document
 * navigation, and Chromium starts a load for it (DevTools' `Page.frameStartedLoading` fires on a
 * hash change and on a `replaceState`; seen in Chrome on 2026-10-06). M1's lifecycle
 * (main/lifecycle.ts, watchWindow) stops the recording on any `did-start-loading` as a reload.
 * Whether Electron emits that for a same-document navigation was not checked (it needs the running
 * app; the controller's Electron check after wave 2 settles it); if it does, a hash-driven router
 * ends the call the moment "New note" opens the meeting. Until M2-T12 removes that stop, the
 * route lives here and in sessionStorage, which a reload keeps. The URL hash is read once at
 * start (a QA script's `index.html#/settings` wins over the saved route) and followed when someone
 * else changes it; it is not updated as the user moves around.
 */
export class RouteStore {
  private route: Route;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly page: RoutePage) {
    const hash = page.location.hash;
    const named = hash !== '' && hash !== '#' && hash !== '#/';
    this.route = parseRoute(named ? hash : (page.sessionStorage.getItem(ROUTE_STORAGE_KEY) ?? ''));
  }

  readonly getSnapshot = (): Route => this.route;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.page.addEventListener('hashchange', this.followHash);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.page.removeEventListener('hashchange', this.followHash);
    };
  };

  readonly navigate = (route: Route): void => {
    const hash = formatRoute(route);
    if (hash === formatRoute(this.route)) return;
    this.route = route;
    this.page.sessionStorage.setItem(ROUTE_STORAGE_KEY, hash);
    for (const listener of [...this.listeners]) listener();
  };

  private readonly followHash = (): void => {
    this.navigate(parseRoute(this.page.location.hash));
  };
}
