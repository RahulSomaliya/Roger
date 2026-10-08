import type { PreferenceChange, ThemePreference } from '../../shared/preferences';

/**
 * Appearance in main (redesign sweep, T3): the `theme` preference (System, Light, Dark) drives
 * `nativeTheme.themeSource`, so the main window, the prompt panel (which only reads
 * `prefers-color-scheme`), menus, dialogs and scrollbars change together; and the window's
 * `backgroundColor`, so a forced theme never flashes the other canvas at show or resize. The page's
 * own `data-theme` (renderer/src/theme/useTheme.ts) is separate and stays as it is.
 */

/**
 * `--canvas` of renderer/src/theme/tokens.css (light: oklch(0.985 0.004 80), dark: oklch(0.17 0.006
 * 70)) as sRGB hex: BrowserWindow takes no oklch. Written once here; change them with the token.
 */
export const CANVAS_LIGHT = '#fbfaf7';
export const CANVAS_DARK = '#110f0d';

export function canvasColor(dark: boolean): string {
  return dark ? CANVAS_DARK : CANVAS_LIGHT;
}

/** The parts of Electron's `nativeTheme` this uses. */
export interface NativeThemeLike {
  themeSource: ThemePreference;
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
  off(event: 'updated', listener: () => void): unknown;
}

export interface AppearanceDeps {
  preferences: {
    get(key: 'theme'): ThemePreference;
    onChange(listener: (change: PreferenceChange) => void): () => void;
  };
  nativeTheme: NativeThemeLike;
  /** Sets the main window's backgroundColor; a no-op while no window is open. */
  setWindowBackground: (color: string) => void;
}

/**
 * Applies the stored theme now and on every change; returns the stop function. `system` follows the
 * Mac, so the background also follows nativeTheme's own `updated` event (the Mac switching at
 * sunset while Roger runs).
 */
export function startAppearance(deps: AppearanceDeps): () => void {
  const { preferences, nativeTheme, setWindowBackground } = deps;
  const paint = (): void => {
    setWindowBackground(canvasColor(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.themeSource = preferences.get('theme');
  paint();
  nativeTheme.on('updated', paint);
  const stopListening = preferences.onChange((change) => {
    if (change.key !== 'theme') return;
    nativeTheme.themeSource = preferences.get('theme');
    paint();
  });
  return () => {
    stopListening();
    nativeTheme.off('updated', paint);
  };
}
