import { CALENDAR_PREFERENCES } from '../../shared/calendarPrefs';
import type { PreferencesStore } from '../preferences/PreferencesStore';

/**
 * M5's preference keys (src/shared/calendarPrefs.ts: the reminder lead time, the notice, open at
 * login) into M4-S2's store. Called from M5-T9c's slot in src/main/index.ts, before the window
 * opens and before anything reads them: `PreferenceValues` already types these keys, so until this
 * runs `getPreferences` silently lacks them and `get` throws "unknown preference"
 * (src/shared/preferences.ts, step 2).
 */
export function registerCalendarPreferences(store: Pick<PreferencesStore, 'register'>): void {
  store.register(CALENDAR_PREFERENCES);
}
