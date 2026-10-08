import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTICE_TEXT } from '../../../shared/calendarPrefs';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import type { PreferenceChange, PreferenceValues } from '../../../shared/preferences';
import { applyTheme, followThemePreference, type ThemeRoot, type ThemeState } from './useTheme';

const STORED: PreferenceValues = {
  theme: 'dark',
  'calendar.reminderLeadMinutes': 1,
  'notice.enabled': true,
  'notice.text': DEFAULT_NOTICE_TEXT,
  'app.openAtLogin': 'auto',
};

/** <html> as far as the theme touches it. Node has no DOM. */
function fakeRoot(): ThemeRoot & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
  };
}

/** window.roger's preferences, with the first read answered when the test says. */
function fakePrefs() {
  const listeners = new Set<(change: PreferenceChange) => void>();
  let answer: (values: PreferenceValues) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const prefs: Pick<PrefsApi, 'getPreferences' | 'onPreferenceChanged'> = {
    getPreferences: () =>
      new Promise<PreferenceValues>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
    onPreferenceChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    prefs,
    listeners,
    answer: async (values: PreferenceValues) => {
      answer(values);
      await Promise.resolve();
    },
    fail: async (error: Error) => {
      fail(error);
      await Promise.resolve();
    },
    change: (change: PreferenceChange) => {
      for (const listener of listeners) listener(change);
    },
  };
}

function follow() {
  const root = fakeRoot();
  const main = fakePrefs();
  const states: ThemeState[] = [];
  const stop = followThemePreference(main.prefs, root, (state) => states.push(state));
  return { root, main, states, stop };
}

describe('the theme on <html>', () => {
  it('forces light or dark with data-theme, and removes it to follow macOS', () => {
    const root = fakeRoot();
    applyTheme(root, 'dark');
    expect(root.attributes.get('data-theme')).toBe('dark');
    applyTheme(root, 'light');
    expect(root.attributes.get('data-theme')).toBe('light');
    applyTheme(root, 'system');
    expect(root.attributes.has('data-theme')).toBe(false);
  });

  it('applies the stored theme once main answers', async () => {
    const { root, main, states } = follow();
    expect(root.attributes.has('data-theme')).toBe(false);
    await main.answer(STORED);
    expect(root.attributes.get('data-theme')).toBe('dark');
    expect(states).toEqual([{ preference: 'dark', error: null }]);
  });

  it('follows every theme change and ignores other keys', async () => {
    const { root, main, states } = follow();
    await main.answer(STORED);
    main.change({ key: 'notice.enabled', value: false });
    main.change({ key: 'theme', value: 'system' });
    expect(root.attributes.has('data-theme')).toBe(false);
    main.change({ key: 'theme', value: 'light' });
    expect(root.attributes.get('data-theme')).toBe('light');
    expect(states.map((state) => state.preference)).toEqual(['dark', 'system', 'light']);
  });

  // The QA driver forces a theme as soon as the page loads, possibly before the first read lands.
  it('keeps a change that lands before the first read answers', async () => {
    const { root, main, states } = follow();
    main.change({ key: 'theme', value: 'light' });
    await main.answer(STORED);
    expect(root.attributes.get('data-theme')).toBe('light');
    expect(states).toEqual([{ preference: 'light', error: null }]);
  });

  it('reports a failed read and leaves the page following macOS', async () => {
    const { root, main, states } = follow();
    await main.fail(new Error("Error invoking remote method 'prefs:get-all': Error: boom"));
    expect(root.attributes.has('data-theme')).toBe(false);
    expect(states).toEqual([
      {
        preference: null,
        error:
          "Could not read the theme preference: Error invoking remote method 'prefs:get-all': Error: boom",
      },
    ]);
  });

  it('clears the error when a change arrives after a failed read', async () => {
    const { main, states } = follow();
    await main.fail(new Error('boom'));
    main.change({ key: 'theme', value: 'dark' });
    expect(states.at(-1)).toEqual({ preference: 'dark', error: null });
  });

  // React's StrictMode runs the effect, stops it and runs it again: the first read must not land.
  it('stops listening when stopped, and ignores a read that answers afterwards', async () => {
    const { root, main, states, stop } = follow();
    stop();
    expect(main.listeners.size).toBe(0);
    await main.answer(STORED);
    expect(root.attributes.has('data-theme')).toBe(false);
    expect(states).toEqual([]);
  });
});
