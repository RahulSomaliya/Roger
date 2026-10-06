import { describe, expect, it, vi } from 'vitest';
import {
  formatRoute,
  HOME,
  parseRoute,
  ROUTE_STORAGE_KEY,
  routeFromApp,
  RouteStore,
  type Route,
  type RoutePage,
} from './router';

const MEETING = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';

const FOUR_ROUTES: [string, Route][] = [
  ['#/', { name: 'home' }],
  [`#/meetings/${MEETING}`, { name: 'meeting', meetingId: MEETING }],
  ['#/settings', { name: 'settings' }],
  ['#/setup', { name: 'setup' }],
];

/** The page as RouteStore sees it. Writing location.hash throws: see the store's trap comment. */
function fakePage(hash = '', saved: string | null = null) {
  let currentHash = hash;
  const stored = new Map<string, string>();
  if (saved !== null) stored.set(ROUTE_STORAGE_KEY, saved);
  const listeners = new Set<() => void>();
  const page: RoutePage = {
    location: {
      get hash() {
        return currentHash;
      },
      set hash(_value: string) {
        throw new Error('RouteStore wrote location.hash');
      },
    },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    page,
    stored,
    listeners,
    /** Someone else changed the hash: a QA script, or a person in DevTools. */
    changeHash: (next: string) => {
      currentHash = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('parseRoute and formatRoute', () => {
  it('parses and formats the four routes', () => {
    for (const [hash, route] of FOUR_ROUTES) {
      expect(parseRoute(hash)).toEqual(route);
      expect(formatRoute(route)).toBe(hash);
    }
  });

  it('an unknown hash goes Home', () => {
    for (const hash of [
      '',
      '#',
      '#/nowhere',
      '#/meetings',
      '#/meetings/',
      '#/meetings/not-a-meeting-id',
      `#/meetings/${MEETING.toUpperCase()}`,
      `#/meetings/${MEETING}/notes`,
      '#/settings/',
      '#settings',
    ]) {
      expect(parseRoute(hash)).toEqual(HOME);
    }
  });
});

describe('routeFromApp', () => {
  it('opens the screen an app:navigate route names, and ignores a route the page lacks (null)', () => {
    expect(routeFromApp('home')).toEqual({ name: 'home' });
    expect(routeFromApp('settings')).toEqual({ name: 'settings' });
    expect(routeFromApp('setup')).toEqual({ name: 'setup' });
    expect(routeFromApp(`meeting/${MEETING}`)).toEqual({ name: 'meeting', meetingId: MEETING });
    expect(routeFromApp('calendar')).toBeNull();
    expect(routeFromApp('meeting/nope')).toBeNull();
    expect(routeFromApp(42)).toBeNull();
  });
});

describe('RouteStore', () => {
  it('starts on the route in the URL hash, else the one saved for this window, else Home', () => {
    expect(new RouteStore(fakePage('#/settings', '#/setup').page).getSnapshot()).toEqual({
      name: 'settings',
    });
    expect(new RouteStore(fakePage('', '#/setup').page).getSnapshot()).toEqual({ name: 'setup' });
    expect(new RouteStore(fakePage('#/', '#/setup').page).getSnapshot()).toEqual({
      name: 'setup',
    });
    expect(new RouteStore(fakePage().page).getSnapshot()).toEqual(HOME);
  });

  it('saves every route for this window, so a reload comes back to it', () => {
    const first = fakePage();
    new RouteStore(first.page).navigate({ name: 'meeting', meetingId: MEETING });
    expect(first.stored.get(ROUTE_STORAGE_KEY)).toBe(`#/meetings/${MEETING}`);

    // The reloaded page keeps its sessionStorage and the URL it was loaded with (no hash here).
    const reloaded = fakePage('', first.stored.get(ROUTE_STORAGE_KEY) ?? null);
    expect(new RouteStore(reloaded.page).getSnapshot()).toEqual({
      name: 'meeting',
      meetingId: MEETING,
    });
  });

  it('never writes location.hash, which would be a page load to main while recording', () => {
    const { page } = fakePage('#/settings');
    const store = new RouteStore(page);
    expect(() => {
      store.navigate({ name: 'setup' });
      store.navigate(HOME);
    }).not.toThrow();
    expect(page.location.hash).toBe('#/settings');
  });

  it('tells each subscriber once per change, and keeps the same snapshot when nothing changed', () => {
    const store = new RouteStore(fakePage().page);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const home = store.getSnapshot();

    store.navigate({ name: 'home' });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(home);

    store.navigate({ name: 'settings' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.navigate({ name: 'setup' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('follows a hash someone else sets, and stops listening with its last subscriber', () => {
    const fake = fakePage();
    const store = new RouteStore(fake.page);
    expect(fake.listeners.size).toBe(0);
    const unsubscribe = store.subscribe(() => undefined);

    fake.changeHash('#/settings');
    expect(store.getSnapshot()).toEqual({ name: 'settings' });
    expect(fake.stored.get(ROUTE_STORAGE_KEY)).toBe('#/settings');

    unsubscribe();
    expect(fake.listeners.size).toBe(0);
  });
});
