import { CALENDAR_PREFERENCES } from '../../src/shared/calendarPrefs';
import { prefsChannels, type PrefsApi } from '../../src/shared/ipc/prefs';
import {
  APP_PREFERENCES,
  type PreferenceChange,
  type PreferenceKey,
  PreferenceRegistry,
  type PreferenceSpec,
} from '../../src/shared/preferences';
import type { FakeHub } from './hub';

/**
 * Every milestone's specs (src/shared/preferences.ts, step 3). Main gets each milestone's from that
 * milestone's slot in index.ts, but no later task writes this file, so the preview registers them
 * all here. Typed with every key: a key added to PreferenceValues without its specs here fails the
 * type check, instead of reading as undefined and refusing every set in the preview.
 */
const EVERY_PREFERENCE: { readonly [K in PreferenceKey]: PreferenceSpec<K> } = {
  ...APP_PREFERENCES,
  ...CALENDAR_PREFERENCES,
};

/**
 * The preferences' part of the preview's `window.roger`, checked by the same specs as main's
 * PreferencesStore, so it refuses the same values with the same words.
 *
 * A PrefsChanged event a scenario sends through the hub becomes the stored value, as a set in main
 * would. That is the QA driver's forced-theme hook: it sends `{ key: 'theme', value: 'dark' }`,
 * and useTheme puts `data-theme="dark"` on <html>.
 */
export function createPrefsFake(hub: FakeHub): PrefsApi {
  const registry = new PreferenceRegistry();
  registry.register(EVERY_PREFERENCE);
  const values = new Map<string, unknown>();
  // Registered before any page listener, so a page that reads on a change reads the new value. A
  // change main would refuse throws back at the scenario that sent it.
  hub.on(prefsChannels.PrefsChanged, (change: PreferenceChange) => {
    values.set(change.key, registry.parse(change.key, change.value).value);
  });

  return {
    getPreferences: () => hub.request(prefsChannels.PrefsGetAll, () => registry.snapshot(values)),
    setPreference: (key, value) =>
      hub.request(prefsChannels.PrefsSet, () => {
        let change: PreferenceChange;
        try {
          change = registry.parse(key, value);
        } catch (error) {
          // The words a failed ipcRenderer.invoke rejects with, as FakeHub.failNextRequest does.
          const message = `Error invoking remote method '${prefsChannels.PrefsSet}': ${String(error)}`;
          throw new Error(message, { cause: error });
        }
        hub.emit(prefsChannels.PrefsChanged, change);
      }),
    onPreferenceChanged: (listener) => hub.on(prefsChannels.PrefsChanged, listener),
  };
}
