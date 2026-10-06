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

/** A colour as 0 to 255 red, green and blue channels. */
type Rgb = readonly [number, number, number];

/**
 * A token's colour as the page paints it: a `#rrggbb` value, or an `rgb(r g b / alpha)` tint drawn
 * over the `surface` token beneath it (the error box's --danger-bg over the page's --bg).
 */
function colour(block: Map<string, string>, token: string, surface?: string): Rgb {
  const value = block.get(token) ?? '';
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    const [, red = '', green = '', blue = ''] = hex;
    return [parseInt(red, 16), parseInt(green, 16), parseInt(blue, 16)];
  }
  const tint = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (tint && surface !== undefined) {
    const [, red = '', green = '', blue = '', alpha = ''] = tint;
    const [underRed, underGreen, underBlue] = colour(block, surface);
    const opacity = Number(alpha);
    const mix = (channel: string, under: number): number =>
      opacity * Number(channel) + (1 - opacity) * under;
    return [mix(red, underRed), mix(green, underGreen), mix(blue, underBlue)];
  }
  throw new Error(`${token} must be a #rrggbb colour, or a tint over a surface (got ${value})`);
}

/** WCAG 2 relative luminance. */
function luminance(rgb: Rgb): number {
  const [red = 0, green = 0, blue = 0] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * The pairs whose WCAG contrast in `block` is under 4.5:1 (AA for text under 18.66px bold), as
 * "text on background: ratio". A pair is `[text, background]` token names, or `[text, tint,
 * surface]` for text on a tint drawn over a surface.
 */
function underAA(
  block: Map<string, string>,
  pairs: (readonly [text: string, background: string, surface?: string])[],
): string[] {
  return pairs.flatMap(([text, background, surface]) => {
    const [lighter = 0, darker = 0] = [colour(block, text), colour(block, background, surface)]
      .map((rgb) => luminance(rgb))
      .sort((a, b) => b - a);
    const ratio = (lighter + 0.05) / (darker + 0.05);
    const under = surface === undefined ? background : `${background} over ${surface}`;
    return ratio < 4.5 ? [`${text} on ${under}: ${ratio.toFixed(2)}`] : [];
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

  // Text in these hues sits on cards (--panel) and on the page itself (--bg).
  it.each(THEMES)('keep accent and danger text readable on --panel and --bg (%s)', (_, block) => {
    expect(
      underAA(block, [
        ['--accent-ink', '--panel'],
        ['--danger-ink', '--panel'],
        ['--accent-ink', '--bg'],
        ['--danger-ink', '--bg'],
      ]),
    ).toEqual([]);
  });

  // The error box (`.error` in styles.css) is --danger-ink on the --danger-bg tint, which is drawn
  // over the page in the banner and over --panel inside a card. The tint darkens a light page, so
  // an ink that passes on --bg alone can fail inside the box.
  it.each(THEMES)('keep error text readable inside its --danger-bg box (%s)', (_, block) => {
    expect(
      underAA(block, [
        ['--danger-ink', '--danger-bg', '--bg'],
        ['--danger-ink', '--danger-bg', '--panel'],
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
