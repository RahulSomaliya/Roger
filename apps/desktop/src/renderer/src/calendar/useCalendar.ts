import { useEffect, useState, useSyncExternalStore } from 'react';
import { CalendarSettingsStore, type CalendarSettingsState } from './calendarSettingsStore';
import { CalendarStore, type CalendarState } from './calendarStore';

/**
 * One store of each kind for the whole window, made on first use: Home's Today, the status banner,
 * the meeting banner and Settings all read the same calendar, and a store each would read the same
 * channels again and keep three copies that disagree for a moment after every event. They are
 * made here, not at import, because `window.roger` exists only in the page (tests build their own
 * stores).
 */
let calendarStore: CalendarStore | null = null;
let settingsStore: CalendarSettingsStore | null = null;

function sharedCalendarStore(): CalendarStore {
  calendarStore ??= new CalendarStore(window.roger);
  return calendarStore;
}

function sharedSettingsStore(): CalendarSettingsStore {
  settingsStore ??= new CalendarSettingsStore(window.roger);
  return settingsStore;
}

/** The calendar as main has it, and the store whose methods act on it (connect, disconnect). */
export function useCalendar(): { state: CalendarState; store: CalendarStore } {
  const store = sharedCalendarStore();
  useEffect(() => store.retain(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return { state, store };
}

/** The calendar's preferences and the login item's state, and the store that changes them. */
export function useCalendarSettings(): {
  state: CalendarSettingsState;
  store: CalendarSettingsStore;
} {
  const store = sharedSettingsStore();
  useEffect(() => store.retain(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return { state, store };
}

/**
 * The time now, in epoch ms, renewed every `intervalMs` and when the window comes back (a Mac that
 * slept over a meeting wakes with a stale clock in state, and "Starting in 5 min" would lie until
 * the next tick). Everything on Home that depends on the clock takes this as its `nowMs`.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = (): void => {
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs]);
  return now;
}
