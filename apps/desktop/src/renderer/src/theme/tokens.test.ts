import { describe, expect, it } from 'vitest';
import { cssDeclarations } from './cssDeclarations';
import { rendererSource, rendererSources } from './rendererSources';

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

const THEMES = [
  ['light', light],
  ['system dark', systemDark],
  ['forced dark', forcedDark],
] as const;

/** WCAG 2 relative luminance of a `#rrggbb` token in one theme's block. */
function luminance(block: Map<string, string>, token: string): number {
  const value = block.get(token);
  const pairs = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '')?.slice(1);
  if (!pairs) throw new Error(`${token} must be a #rrggbb colour (got ${String(value)})`);
  const [red = 0, green = 0, blue = 0] = pairs.map((pair) => {
    const channel = parseInt(pair, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The pairs, `[text, background]` token names, whose WCAG contrast in `block` is under 4.5:1
 * (AA for text under 18.66px bold), as "text on background: ratio".
 */
function underAA(block: Map<string, string>, pairs: [string, string][]): string[] {
  return pairs.flatMap(([text, background]) => {
    const [lighter, darker] = [text, background]
      .map((token) => luminance(block, token))
      .sort((a, b) => b - a);
    const ratio = ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
    return ratio < 4.5 ? [`${text} on ${background}: ${ratio.toFixed(2)}`] : [];
  });
}

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

  // The Start and Stop labels are 16px at weight 650: not large text, so AA asks 4.5:1. A dark
  // fill that keeps white readable is too dark to read as text on --panel, so one token cannot do
  // both jobs: --accent and --danger are fills, --accent-ink and --danger-ink are text.
  it.each(THEMES)(
    'keep white labels readable on the --accent and --danger fills (%s)',
    (_, block) => {
      expect(
        underAA(block, [
          ['--on-accent', '--accent'],
          ['--on-accent', '--danger'],
        ]),
      ).toEqual([]);
    },
  );

  it.each(THEMES)('keep accent and danger text readable on --panel (%s)', (_, block) => {
    expect(
      underAA(block, [
        ['--accent-ink', '--panel'],
        ['--danger-ink', '--panel'],
      ]),
    ).toEqual([]);
  });

  it('never colour text with a fill token: text reads --accent-ink and --danger-ink', () => {
    const css = rendererSources((path) => path.endsWith('.css') && path !== 'src/theme/tokens.css');
    expect(Object.keys(css)).toContain('src/styles.css');
    const fillsAsText = Object.entries(css).flatMap(([path, text]) =>
      cssDeclarations(text)
        .filter(
          ({ property, value }) => property === 'color' && /var\(--(?:accent|danger)\)/.test(value),
        )
        .map(({ property, value }) => `${path}: ${property}: ${value}`),
    );
    expect(fillsAsText).toEqual([]);
  });

  it('reach the page through styles.css', () => {
    expect(rendererSource('src/styles.css')).toMatch(/^@import '\.\/theme\/tokens\.css';$/m);
  });
});
