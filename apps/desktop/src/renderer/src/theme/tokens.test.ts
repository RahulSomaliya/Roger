import { describe, expect, it } from 'vitest';
import { cssDeclarations } from './cssDeclarations';
import { rendererSource, rendererSources } from './rendererSources';

/**
 * Every colour token the renderer has (docs/design.md, Colour tokens). Exactly this list: an old
 * name that survives is a token nobody paints, and a missing one is a `var()` that paints nothing.
 */
const TOKENS = [
  '--canvas',
  '--surface',
  '--raised',
  '--fill',
  '--sunken',
  '--control',
  '--line',
  '--ink',
  '--ink-muted',
  '--ink-subtle',
  '--accent',
  '--accent-hover',
  '--on-accent',
  '--accent-ink',
  '--accent-soft',
  '--ring',
  '--scrim',
  '--e1',
  '--e2',
  '--e3',
];

/** The tokens text may be coloured with. Every other token is a surface, a fill or a shadow. */
const TEXT_TOKENS = ['--ink', '--ink-muted', '--ink-subtle', '--accent-ink', '--on-accent'];

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

/** A colour as linear-light red, green and blue, each 0 to 1. */
type Linear = readonly [number, number, number];

/**
 * OKLCH to linear-light sRGB (Bjorn Ottosson's OKLab matrices), clamped to the sRGB gamut as a
 * display does. The result is already linear light, so luminance takes it with no gamma step
 * (ported from JS Journey's tests/theme-contrast.test.ts).
 */
function oklchToLinear(lightness: number, chroma: number, hue: number): Linear {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** A token's value, following `var(--other)` (--ring is --accent). */
function resolve(block: Map<string, string>, token: string, seen: readonly string[] = []): string {
  const value = block.get(token);
  if (value === undefined) throw new Error(`${token} is not defined in this theme`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (!alias) return value;
  const next = alias[1] ?? '';
  if (seen.includes(next)) throw new Error(`${token} aliases itself through ${next}`);
  return resolve(block, next, [...seen, token]);
}

/** A token's colour. Only an opaque `oklch(L C H)` has one: a tint (--scrim) never sits under text. */
function colour(block: Map<string, string>, token: string): Linear {
  const value = resolve(block, token);
  const parts = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!parts) throw new Error(`${token} must be an opaque oklch(L C H) colour (got ${value})`);
  return oklchToLinear(Number(parts[1]), Number(parts[2]), Number(parts[3]));
}

/** WCAG 2 relative luminance of a linear-light colour. */
const luminance = ([red, green, blue]: Linear): number =>
  0.2126 * red + 0.7152 * green + 0.0722 * blue;

/** WCAG 2 contrast ratio of two tokens in `block`. */
function contrast(block: Map<string, string>, first: string, second: string): number {
  const [lighter = 0, darker = 0] = [colour(block, first), colour(block, second)]
    .map(luminance)
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** One row of docs/design.md's "Pinned pairings": a token over each surface it is painted on. */
interface Pinned {
  readonly text: string;
  readonly on: readonly string[];
  /** The ratios the doc prints for light and dark, one per surface in `on`. */
  readonly light: readonly number[];
  readonly dark: readonly number[];
  /** 4.5 for text (AA under 18.66px bold), 3 for a non-text mark such as the focus ring. */
  readonly min: 4.5 | 3;
}

const SEVEN = [
  '--canvas',
  '--surface',
  '--raised',
  '--fill',
  '--sunken',
  '--control',
  '--accent-soft',
];

/**
 * Every pairing the app paints. Add a row here, and to the doc's table, before you paint a new one:
 * "subtle" is still text, and --ink-subtle failed AA in dark on --accent-soft until it was tuned.
 */
const PINNED: readonly Pinned[] = [
  {
    text: '--ink',
    on: SEVEN,
    light: [16.5, 17.0, 17.0, 15.1, 15.1, 17.0, 14.7],
    dark: [15.5, 14.4, 13.0, 12.6, 14.7, 9.5, 11.6],
    min: 4.5,
  },
  {
    text: '--ink-muted',
    on: SEVEN,
    light: [7.1, 7.3, 7.3, 6.5, 6.5, 7.3, 6.3],
    dark: [7.7, 7.1, 6.4, 6.2, 7.2, 4.7, 5.7],
    min: 4.5,
  },
  {
    text: '--ink-subtle',
    on: ['--canvas', '--surface', '--raised', '--fill', '--sunken', '--accent-soft'],
    light: [5.2, 5.4, 5.4, 4.8, 4.8, 4.7],
    dark: [6.1, 5.6, 5.1, 4.9, 5.8, 4.5],
    min: 4.5,
  },
  {
    text: '--accent-ink',
    on: ['--canvas', '--surface', '--raised', '--fill', '--accent-soft'],
    light: [6.7, 6.9, 6.9, 6.1, 5.9],
    dark: [9.8, 9.1, 8.2, 8.0, 7.4],
    min: 4.5,
  },
  {
    text: '--on-accent',
    on: ['--accent', '--accent-hover'],
    light: [4.8, 5.7],
    dark: [7.2, 8.4],
    min: 4.5,
  },
  {
    text: '--accent',
    on: ['--canvas', '--surface', '--raised', '--fill'],
    light: [4.7, 4.9, 4.9, 4.3],
    dark: [7.3, 6.7, 6.1, 5.9],
    min: 3,
  },
  {
    text: '--ring',
    on: ['--canvas', '--surface', '--raised', '--fill'],
    light: [4.7, 4.9, 4.9, 4.3],
    dark: [7.3, 6.7, 6.1, 5.9],
    min: 3,
  },
];

describe('the theme tokens', () => {
  it('are exactly the design system list, in light, in the system dark theme and in forced dark', () => {
    for (const [, block] of THEMES) expect(tokensOf(block).sort()).toEqual([...TOKENS].sort());
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

  it('hold nothing but colours and the shadows that carry them: every other rule lives in styles.css', () => {
    for (const block of [light, systemDark, forcedDark]) {
      expect([...block.keys()].filter((property) => !property.startsWith('--'))).toEqual([
        'color-scheme',
      ]);
    }
  });

  // --ring is the accent, by reference, so the two cannot drift apart.
  it.each(THEMES)('make --ring the --accent fill (%s)', (_, block) => {
    expect(block.get('--ring')).toBe('var(--accent)');
  });

  // Every measured ratio must clear its bar, and must still be the number docs/design.md prints:
  // the doc floors every ratio to one decimal (a printed number never overstates the margin over
  // the bar), so 0.1 is the tolerance that catches a re-tune.
  it.each([
    ['light', light, 'light'],
    ['system dark', systemDark, 'dark'],
    ['forced dark', forcedDark, 'dark'],
  ] as const)('keep every pinned pairing at AA and as documented (%s)', (_, block, mode) => {
    const underBar: string[] = [];
    const drifted: string[] = [];
    for (const row of PINNED) {
      expect(row[mode]).toHaveLength(row.on.length);
      row.on.forEach((surface, index) => {
        const ratio = contrast(block, row.text, surface);
        const documented = row[mode][index] ?? 0;
        if (ratio < row.min) underBar.push(`${row.text} on ${surface}: ${ratio.toFixed(2)}`);
        if (Math.abs(ratio - documented) >= 0.1) {
          drifted.push(`${row.text} on ${surface}: ${ratio.toFixed(2)}, doc says ${documented}`);
        }
      });
    }
    expect(underBar).toEqual([]);
    expect(drifted).toEqual([]);
  });

  // A hairline is decorative (1.3:1), so a control never leans on it alone: an input's edge is
  // --line plus its own --surface against --canvas, and focus adds --ring. Not a pinned text pairing.
  it.each(THEMES)('keep --line a hairline, under 2:1 on --canvas (%s)', (_, block) => {
    expect(contrast(block, '--line', '--canvas')).toBeLessThan(2);
  });

  it('never colour text with a fill: `color` reads an ink token, --accent-ink or --on-accent', () => {
    const sheets = rendererSources(
      (path) => path.endsWith('.css') && path !== 'src/theme/tokens.css',
    );
    expect(Object.keys(sheets)).toContain('src/styles.css');
    const textTokens = new Set(TEXT_TOKENS);
    const wrongText = Object.entries(sheets).flatMap(([path, text]) =>
      cssDeclarations(text)
        .filter(({ property }) => property === 'color')
        .filter(({ value }) =>
          [...value.matchAll(/var\((--[\w-]+)/g)].some((read) => !textTokens.has(read[1] ?? '')),
        )
        .map(({ property, value }) => `${path}: ${property}: ${value}`),
    );
    expect(wrongText).toEqual([]);
  });

  it('reach the page through styles.css', () => {
    expect(rendererSource('src/styles.css')).toMatch(/^@import '\.\/theme\/tokens\.css';$/m);
  });
});
