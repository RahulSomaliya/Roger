import type { Unsubscribe } from './unsubscribe';

/**
 * The app shell's channels. Main holds app:navigate until the page sends app:ready
 * (src/main/navigation.ts); the renderer opens the route (src/renderer/src/App.tsx).
 */
export const appChannels = {
  /** main → renderer event: open an AppRoute */
  AppNavigate: 'app:navigate',
  /** renderer → main, fire and forget: the page listens for AppNavigate now */
  AppReady: 'app:ready',
} as const;

/**
 * Where main may send the page. A closed set (M5's SHELL-0 spec), so no caller can open a screen
 * the renderer lacks; `meeting/<id>` takes a meeting id as isMeetingId accepts it.
 */
export type AppRoute = 'home' | 'settings' | 'setup' | `meeting/${string}`;

const MEETING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A meeting id as the desktop makes it (randomUUID) and Postgres returns it: a lowercase UUID.
 * Upper case is refused rather than folded, so one meeting never has two spellings.
 */
export function isMeetingId(value: string): boolean {
  return MEETING_ID.test(value);
}

/** `value` as an AppRoute, or null when it is not one. Both ends check: the payload crosses IPC. */
export function parseAppRoute(value: unknown): AppRoute | null {
  if (value === 'home' || value === 'settings' || value === 'setup') return value;
  if (typeof value !== 'string' || !value.startsWith('meeting/')) return null;
  const meetingId = value.slice('meeting/'.length);
  return isMeetingId(meetingId) ? `meeting/${meetingId}` : null;
}

/** The app shell's part of `window.roger`. */
export interface AppApi {
  /**
   * Tells main the page listens for onNavigate. Main holds every route sent before this, and
   * after a reload until the next call, so subscribe first and call this second.
   */
  appReady(): void;
  /** A route main asks the page to open: the app menu's items, later M5's "Take notes". */
  onNavigate(listener: (route: AppRoute) => void): Unsubscribe;
}
