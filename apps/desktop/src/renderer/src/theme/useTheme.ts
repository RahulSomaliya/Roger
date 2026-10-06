import { useEffect, useState } from 'react';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { ThemePreference } from '../../../shared/preferences';

/** The attribute tokens.css reads: `light` or `dark` forces a theme; absent, the page follows macOS. */
export const THEME_ATTRIBUTE = 'data-theme';

export interface ThemeState {
  /** The `theme` preference in force; null until main answers. */
  preference: ThemePreference | null;
  /** Why the preference could not be read. The page follows macOS meanwhile. */
  error: string | null;
}

/** <html>, as far as the theme touches it. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyTheme(root: ThemeRoot, preference: ThemePreference): void {
  if (preference === 'system') root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, preference);
}

/**
 * Keeps `root`'s theme on the `theme` preference: the stored one once main answers, then every
 * change (from Settings, from main, or the QA driver's forced theme through the preview's fake).
 * Returns the function that stops it. A change that lands before the first read wins, and a read
 * that answers after the stop is dropped, as React's StrictMode stops and reruns every effect.
 */
export function followThemePreference(
  prefs: Pick<PrefsApi, 'getPreferences' | 'onPreferenceChanged'>,
  root: ThemeRoot,
  onState: (state: ThemeState) => void,
): Unsubscribe {
  let stopped = false;
  let changed = false;
  const show = (preference: ThemePreference): void => {
    applyTheme(root, preference);
    onState({ preference, error: null });
  };
  const unsubscribe = prefs.onPreferenceChanged((change) => {
    if (change.key !== 'theme') return;
    changed = true;
    show(change.value);
  });
  prefs.getPreferences().then(
    (values) => {
      if (!stopped && !changed) show(values.theme);
    },
    (error: unknown) => {
      if (stopped || changed) return;
      const message = error instanceof Error ? error.message : String(error);
      onState({ preference: null, error: `Could not read the theme preference: ${message}` });
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/**
 * Puts the `theme` preference on <html> for the life of the calling component: AppLayout calls it
 * once (M4-S1). Show `error` where the shell shows errors; the page follows macOS until then.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>({ preference: null, error: null });
  useEffect(() => followThemePreference(window.roger, document.documentElement, setState), []);
  return state;
}
