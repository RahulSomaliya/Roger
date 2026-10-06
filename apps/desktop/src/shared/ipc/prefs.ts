import type { PreferenceChange, PreferenceKey, PreferenceValues } from '../preferences';
import type { Unsubscribe } from './unsubscribe';

/**
 * The preferences' channels. Main registers them in src/main/preferences/preferences-ipc.ts, for
 * the main window's page only. Add a member here together with its bridge
 * (src/preload/bridges/prefs.ts) and its preview fake (preview/fakes/prefs.ts): the type check
 * fails until all three agree.
 */
export const prefsChannels = {
  /** renderer → main, invoke */
  PrefsGetAll: 'prefs:get-all',
  PrefsSet: 'prefs:set',
  /** main → renderer events */
  PrefsChanged: 'prefs:changed',
} as const;

/** The preferences' part of `window.roger` (keys and values: src/shared/preferences.ts). */
export interface PrefsApi {
  /** Every registered preference, its default where the user chose nothing. */
  getPreferences(): Promise<PreferenceValues>;
  /**
   * Saves one preference. Rejects, naming the key, when main refuses the value or cannot write
   * the file; nothing changes then. On success the change also arrives as an event.
   */
  setPreference<K extends PreferenceKey>(key: K, value: PreferenceValues[K]): Promise<void>;
  /** One event per saved set, made in this page or in main. */
  onPreferenceChanged(listener: (change: PreferenceChange) => void): Unsubscribe;
}
