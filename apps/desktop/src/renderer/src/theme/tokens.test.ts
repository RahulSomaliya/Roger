import { describe, expect, it } from 'vitest';
import { rendererSource } from './rendererSources';

/** Every colour token a Phase 2 plan reads (phase-2-build-order.md, section 3.1). */
const PLANNED_TOKENS = [
  '--bg',
  '--panel',
  '--ink',
  '--muted',
  '--line',
  '--accent',
  '--danger',
  '--warn',
  '--ok',
  '--danger-bg',
  '--warn-bg',
  '--ok-bg',
  '--interim-ink',
  '--hidden-ink',
  '--cited-bg',
  '--recording',
  '--focus-ring',
  '--sidebar-bg',
  '--chip-bg',
  '--conflict-bg',
];

const css = rendererSource('src/theme/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the one rule `pattern` finds, by property. */
function declarations(pattern: RegExp): Map<string, string> {
  const body = pattern.exec(css)?.[1];
  if (body === undefined) throw new Error(`tokens.css has no rule matching ${String(pattern)}`);
  return new Map(
    body
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter(([property]) => property)
      .map(([property = '', ...value]) => [property, value.join(':')]),
  );
}

/** The three ways a theme is chosen; useTheme.ts sets `data-theme` from the `theme` preference. */
const light = declarations(/(?:^|\})\s*:root\s*\{([^{}]*)\}/);
const systemDark = declarations(
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^{}]*)\}\s*\}/,
);
const forcedDark = declarations(/(?:^|\})\s*:root\[data-theme='dark'\]\s*\{([^{}]*)\}/);

const tokensOf = (block: Map<string, string>): string[] =>
  [...block.keys()].filter((property) => property.startsWith('--'));

describe('the theme tokens', () => {
  it('define every colour the Phase 2 plans name', () => {
    expect(tokensOf(light)).toEqual(expect.arrayContaining(PLANNED_TOKENS));
  });

  // A token missing from one theme reads as nothing there: no background, or the inherited ink.
  it('define every token in light, in the system dark theme and in forced dark', () => {
    expect(tokensOf(systemDark)).toEqual(tokensOf(light));
    expect(tokensOf(forcedDark)).toEqual(tokensOf(light));
  });

  // Dark is written twice: once for macOS in dark mode, once for a forced `theme: dark`.
  it('give forced dark exactly the values of the system dark theme', () => {
    expect([...forcedDark]).toEqual([...systemDark]);
  });

  it('switch the colour scheme with the theme, so scrollbars and controls follow a forced one', () => {
    expect(light.get('color-scheme')).toBe('light');
    expect(systemDark.get('color-scheme')).toBe('dark');
    expect(forcedDark.get('color-scheme')).toBe('dark');
  });

  it('hold nothing but colours: every other rule lives in styles.css', () => {
    for (const block of [light, systemDark, forcedDark]) {
      expect([...block.keys()].filter((property) => !property.startsWith('--'))).toEqual([
        'color-scheme',
      ]);
    }
  });

  it('reach the page through styles.css', () => {
    expect(rendererSource('src/styles.css')).toMatch(/^@import '\.\/theme\/tokens\.css';$/m);
  });
});
