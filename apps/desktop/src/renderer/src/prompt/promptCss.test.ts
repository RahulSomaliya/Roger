import { describe, expect, it } from 'vitest';
import { rendererSource } from '../theme/rendererSources';

/**
 * The prompt panel is its own page and loads tokens.css and prompt.css, never styles.css, so it
 * keeps a copy of the few primitives it borrows (prompt.css, Trap). Two ways the copy goes wrong
 * without a test saying so: a `.btn` change in styles.css that the panel never gets (its primary
 * button turns into the old look), and a `var(--x)` that only styles.css defines (tokenReads.test.ts
 * pools every sheet, so it passes, and the panel paints nothing for it).
 */

const PROMPT = rendererSource('src/prompt/prompt.css');
const STYLES = rendererSource('src/styles.css');
const TOKENS = rendererSource('src/theme/tokens.css');

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Flat rules (no nesting inside) as normalised selector to normalised body. */
function flatRules(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const [, selector = '', body = ''] of withoutComments(css).matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    rules.set(squash(selector), squash(body));
  }
  return rules;
}

describe('prompt.css', () => {
  it('copies .btn, .problem and .overline from styles.css exactly, so the panel never drifts from the app', () => {
    const copied = [...flatRules(PROMPT)].filter(([selector]) =>
      /^\.(btn|problem|overline)\b(?!\.)/.test(selector),
    );
    // A guard on the guard: a regex that matched nothing would pass on any drift.
    expect(copied.length).toBeGreaterThanOrEqual(9);
    const app = flatRules(STYLES);
    for (const [selector, body] of copied) {
      expect(app.get(selector), `${selector} is not in styles.css`).toBe(body);
    }
  });

  it('reads only custom properties that tokens.css or prompt.css define', () => {
    const defined = new Set(
      [...withoutComments(`${TOKENS}\n${PROMPT}`).matchAll(/(--[\w-]+)\s*:/g)].map(
        ([, name = '']) => name,
      ),
    );
    const read = [...withoutComments(PROMPT).matchAll(/var\(\s*(--[\w-]+)/g)].map(
      ([, name = '']) => name,
    );
    expect(read.length).toBeGreaterThan(20);
    expect(read.filter((name) => !defined.has(name))).toEqual([]);
  });

  it('draws the card on the edge token, never `line`, and hovers on fill-raised, never `fill`', () => {
    const rules = flatRules(PROMPT);
    expect(rules.get('.prompt-card')).toContain('border: 1px solid var(--edge)');
    expect(rules.get('.prompt-card')).toContain('background: var(--raised)');
    // The copied `.btn` keeps its `line` border; the card's own surfaces do not.
    for (const [selector, body] of rules) {
      if (selector.startsWith('.prompt-')) expect(body, selector).not.toContain('var(--line)');
    }
    expect(
      rules.get(".btn[data-variant='ghost']:hover:not(:disabled, [aria-disabled='true'])"),
    ).toContain('var(--fill-raised)');
  });

  it('follows the theme through prefers-color-scheme alone: no attribute or class selector for it', () => {
    // T3 sets nativeTheme.themeSource, which moves this page's prefers-color-scheme; a theme
    // attribute would only ever be set by the main window's useTheme, which this page never runs.
    expect(withoutComments(PROMPT)).not.toMatch(/data-theme|\.dark\b|\.light\b/);
  });

  it('slides cards in over 240 ms and out over 170 ms, with opacity and transform only', () => {
    const css = withoutComments(PROMPT);
    expect(css).toContain('--dur-slide-in: 240ms');
    expect(css).toContain('--dur-slide-out: 170ms');
    const keyframes = [...css.matchAll(/@keyframes (slide-in|slide-out) \{([\s\S]*?\})\s*\}/g)];
    expect(keyframes.map(([, name]) => name)).toEqual(['slide-in', 'slide-out']);
    for (const [, , body = ''] of keyframes) {
      expect(body.match(/[\w-]+(?=:)/g)?.sort()).toEqual(['opacity', 'transform']);
    }
  });
});
