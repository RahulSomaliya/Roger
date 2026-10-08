import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ThemePreference } from '../../../shared/preferences';
import type { ThemeRoot } from '../theme/useTheme';
import {
  AppearanceSection,
  appearanceFromKey,
  chooseAppearance,
  type AppearanceSaver,
} from './AppearanceSetting';

function render(preference: ThemePreference | null, error: string | null = null): string {
  return renderToStaticMarkup(
    createElement(AppearanceSection, { preference, error, onChoose: vi.fn() }),
  );
}

function fakeRoot() {
  const attributes = new Map<string, string>();
  const root: ThemeRoot = {
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
  };
  return { root, attributes };
}

describe('the Appearance section', () => {
  it('is a radiogroup of System, Light and Dark with the stored one checked', () => {
    const html = render('light');
    expect(html).toMatch(/role="radiogroup"/);
    const labels = [...html.matchAll(/role="radio"[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(labels).toEqual(['System', 'Light', 'Dark']);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>Light</);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it('puts only the checked option in the Tab order (arrow keys move the rest)', () => {
    const html = render('dark');
    expect(html).toMatch(/tabindex="0"[^>]*>Dark</);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it('keeps one option reachable before main has answered, with none checked', () => {
    const html = render(null);
    expect(html).not.toContain('aria-checked="true"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('is titled Appearance and has no Save button', () => {
    const html = render('system');
    expect(html).toContain('Appearance</h2>');
    expect(html).not.toContain('Save');
    expect(html).toContain('System follows your Mac');
  });

  it('shows why a save failed as a problem line', () => {
    expect(render('system', 'Roger could not save the look: no')).toContain(
      'Roger could not save the look: no',
    );
  });
});

describe('appearanceFromKey', () => {
  it('moves and chooses with the arrow keys, wrapping at the ends', () => {
    expect(appearanceFromKey('system', 'ArrowRight')).toBe('light');
    expect(appearanceFromKey('dark', 'ArrowRight')).toBe('system');
    expect(appearanceFromKey('system', 'ArrowLeft')).toBe('dark');
    expect(appearanceFromKey('light', 'Home')).toBe('system');
    expect(appearanceFromKey('light', 'End')).toBe('dark');
  });

  it('ignores every other key, and starts from System before main has answered', () => {
    expect(appearanceFromKey('light', 'a')).toBeNull();
    expect(appearanceFromKey(null, 'ArrowRight')).toBe('light');
  });
});

describe('chooseAppearance', () => {
  it('changes this window at once and then saves the preference', async () => {
    const { root, attributes } = fakeRoot();
    const prefs: AppearanceSaver = { setPreference: vi.fn(() => Promise.resolve()) };
    const error = await chooseAppearance(prefs, root, 'system', 'dark');
    expect(error).toBeNull();
    expect(attributes.get('data-theme')).toBe('dark');
    expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'dark');
  });

  it('System removes the forcing attribute so the page follows macOS', async () => {
    const { root, attributes } = fakeRoot();
    attributes.set('data-theme', 'dark');
    await chooseAppearance({ setPreference: () => Promise.resolve() }, root, 'dark', 'system');
    expect(attributes.has('data-theme')).toBe(false);
  });

  it('puts the look back and says so when main refuses', async () => {
    const { root, attributes } = fakeRoot();
    attributes.set('data-theme', 'light');
    const error = await chooseAppearance(
      { setPreference: () => Promise.reject(new Error('preferences.json is read-only')) },
      root,
      'light',
      'dark',
    );
    expect(error).toBe('Roger could not save the look: preferences.json is read-only');
    expect(attributes.get('data-theme')).toBe('light');
  });
});
