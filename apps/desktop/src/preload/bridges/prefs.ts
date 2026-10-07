import { prefsChannels, type PrefsApi } from '../../shared/ipc/prefs';
import { invoke, subscribe } from '../bridge';

/** The preferences' part of `window.roger`. Main checks every set (preferences-ipc.ts). */
export const prefsBridge: PrefsApi = {
  getPreferences: () => invoke(prefsChannels.PrefsGetAll),
  setPreference: (key, value) => invoke(prefsChannels.PrefsSet, { key, value }),
  onPreferenceChanged: (listener) => subscribe(prefsChannels.PrefsChanged, listener),
};
