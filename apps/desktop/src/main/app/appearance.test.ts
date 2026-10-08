import { describe, expect, it } from 'vitest';
import type { PreferenceChange, ThemePreference } from '../../shared/preferences';
import { CANVAS_DARK, CANVAS_LIGHT, canvasColor, startAppearance } from './appearance';

function setup(theme: ThemePreference, macDark: boolean) {
  const listeners: ((change: PreferenceChange) => void)[] = [];
  let themeUpdated: (() => void) | undefined;
  const native = {
    themeSource: 'system' as ThemePreference,
    // As Electron: follows themeSource, else the Mac.
    get shouldUseDarkColors(): boolean {
      return this.themeSource === 'system' ? state.macDark : this.themeSource === 'dark';
    },
    on: (_event: 'updated', listener: () => void) => {
      themeUpdated = listener;
    },
    off: () => undefined,
  };
  const state = { macDark, theme };
  const backgrounds: string[] = [];
  const stop = startAppearance({
    preferences: {
      get: () => state.theme,
      onChange: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    nativeTheme: native,
    setWindowBackground: (color) => backgrounds.push(color),
  });
  return {
    native,
    backgrounds,
    stop,
    choose(next: ThemePreference) {
      state.theme = next;
      for (const listener of listeners) listener({ key: 'theme', value: next });
    },
    macGoesDark() {
      state.macDark = true;
      themeUpdated?.();
    },
  };
}

describe('startAppearance', () => {
  it('applies the stored preference at launch: themeSource and the matching background', () => {
    const light = setup('light', true);
    expect(light.native.themeSource).toBe('light');
    expect(light.backgrounds.at(-1)).toBe(CANVAS_LIGHT);
    const dark = setup('dark', false);
    expect(dark.native.themeSource).toBe('dark');
    expect(dark.backgrounds.at(-1)).toBe(CANVAS_DARK);
  });

  it('system follows the Mac, and re-paints when the Mac changes', () => {
    const app = setup('system', false);
    expect(app.native.themeSource).toBe('system');
    expect(app.backgrounds.at(-1)).toBe(CANVAS_LIGHT);
    app.macGoesDark();
    expect(app.backgrounds.at(-1)).toBe(CANVAS_DARK);
  });

  it('follows a change of the theme preference, and ignores other keys', () => {
    const app = setup('system', false);
    app.choose('dark');
    expect(app.native.themeSource).toBe('dark');
    expect(app.backgrounds.at(-1)).toBe(CANVAS_DARK);
  });
});

describe('canvasColor', () => {
  it('is the canvas token of the theme in force', () => {
    expect(canvasColor(false)).toBe('#fbfaf7');
    expect(canvasColor(true)).toBe('#110f0d');
  });
});
